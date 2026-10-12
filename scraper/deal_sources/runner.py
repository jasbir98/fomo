"""Run the configured deal sources end to end (called by weekly_edinburgh.py).

Per source: discover pages -> fetch politely -> skip unchanged (ledger) -> one DeepSeek
forced-tool call per page (long pages in overlapping chunks) -> evidence gate ->
build_full_record (the topic pipeline's record shape) -> identity reconcile.

SHADOW sources run all of that and are reported, but their records are never
returned for staging. LIVE sources return their records; weekly_edinburgh stages
them (official sources that passed every check count as verified, commercial
sources always go to review with reason `commercial_source_review`).

Spend is capped by `cap_usd` (the run's deal-source sub-cap). Pages are processed
one at a time: concurrent DeepSeek calls have crashed the streaming path.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from dataclasses import replace
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable

from happenings.cities.edinburgh import EDINBURGH
from happenings_research import build_full_record, slugify
from identity import Catalogue, reconcile
from deepseek_hours import DeepSeekPeakHours
from llm_client import default_research_model, make_research_client, research_provider

from deal_sources.discover import PageRef, discover
from deal_sources.extract import ExtractResult, build_user_prompt, extract_deals
from deal_sources.fetch import PoliteFetcher
from deal_sources.gate import PageContext, REASONS, gate_deal, normalise, to_raw_happening
from deal_sources.ledger import Ledger
from deal_sources.registry import DealSource
from deal_sources.textutil import html_links, html_to_text, og_image, split_blocks, split_chunks

CHUNK_CHARS = 14_000
CHUNK_OVERLAP_CHARS = 1_500
# Offer cards per LLM call on a segmented multi-offer page (DealSource.segment).
SEGMENT_BATCH = 6
# Rough per-call budget guard (tokens) used before a call, replaced by real usage after it.
PROMPT_OVERHEAD_TOKENS = 3_000
EXPECTED_OUTPUT_TOKENS = 4_000
MAX_SAMPLES = 5
MAX_REJECTION_EXAMPLES = 12


@dataclass
class SourceStats:
    source_id: str
    name: str
    trust: str
    status: str
    pages_discovered: int = 0
    pages_fetched: int = 0
    pages_unchanged: int = 0
    pages_failed: int = 0
    pages_extracted: int = 0
    pages_budget_skipped: int = 0
    deals_extracted: int = 0
    kept: int = 0
    rejected: Counter = field(default_factory=Counter)
    dropped_fields: Counter = field(default_factory=Counter)
    refreshes_known: int = 0
    quotes_repaired: int = 0
    new_rows: int = 0
    cost_usd: float = 0.0
    notes: list[str] = field(default_factory=list)
    samples: list[dict[str, Any]] = field(default_factory=list)
    rejection_examples: list[dict[str, str]] = field(default_factory=list)
    ledger_writes: int = 0

    def to_json(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        d["rejected"] = dict(self.rejected)
        d["dropped_fields"] = dict(self.dropped_fields)
        return d


@dataclass
class DealRunResult:
    stats: list[SourceStats] = field(default_factory=list)
    live_records: list[dict[str, Any]] = field(default_factory=list)
    shadow_records: list[dict[str, Any]] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    failures: list[dict[str, str]] = field(default_factory=list)
    dropped_known: list[str] = field(default_factory=list)
    identity_review: list[str] = field(default_factory=list)
    budget_exhausted: bool = False
    cap_usd: float = 0.0
    ledgers: list[Ledger] = field(default_factory=list)

    def commit_ledgers(self) -> int:
        """Record this run's page hashes. Call only once its rows are staged."""
        return sum(ledger.commit() for ledger in self.ledgers)


def page_slug(url: str) -> str:
    segments = [s for s in re.sub(r"[?#].*$", "", url).split("/") if s]
    return segments[-1] if segments else "page"


def estimate_cost(chars: int, in_rate: float, out_rate: float) -> float:
    tokens_in = chars / 3.2 + PROMPT_OVERHEAD_TOKENS
    return tokens_in / 1e6 * in_rate + EXPECTED_OUTPUT_TOKENS / 1e6 * out_rate


def _deal_key(item: dict[str, Any]) -> str:
    return normalise(item.get("quote") or item.get("title") or "")


def _short(value: Any, n: int = 140) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= n else text[: n - 1] + "…"


def process_page(
    source: DealSource,
    ref: PageRef,
    html: str,
    *,
    client_call: Callable[[str], ExtractResult],
    stats: SourceStats,
    today: date,
    batch_id: str,
    model: str,
    now_iso: str,
    in_rate: float,
    out_rate: float,
    spent_so_far: Callable[[], float],
    cap_usd: float,
    result: DealRunResult,
    log: Callable[[str], None] = print,
) -> tuple[list[dict[str, Any]], bool, str]:
    """Extract and gate one page. Returns (records, extraction_ok, page_text).

    `client_call(prompt)` is the LLM call (injected for tests)."""
    base = ref.url
    title = ref.title or ""
    body_plain = html_to_text(html, base_url=base)
    page_text = f"{title}\n{body_plain}".strip()
    body_marked = html_to_text(html, with_links=True, base_url=base)
    marked = f"{title}\n{body_marked}".strip()
    links = {href for _text, href in html_links(html, base)}
    return_text = page_text
    page = PageContext(url=ref.url, text=page_text, links=links, single_deal=not source.multi_deal_pages)

    # Each unit is (prompt text with link markers, plain text of the same span, note).
    units: list[tuple[str, str, str | None]] = []
    blocks = split_blocks(html, source.segment) if source.segment else []
    if blocks:
        # Multi-offer page: split into offer cards deterministically and show the model a
        # few whole cards at a time, so every call sees short text and can only quote from it.
        batches = [blocks[i:i + SEGMENT_BATCH] for i in range(0, len(blocks), SEGMENT_BATCH)]
        for n, batch in enumerate(batches, 1):
            marked_parts = [f"=== OFFER {i} ===\n" + html_to_text(b, with_links=True, base_url=base)
                            for i, b in enumerate(batch, 1)]
            plain = "\n".join(html_to_text(b, base_url=base) for b in batch)
            units.append((f"{title}\n" + "\n\n".join(marked_parts), plain,
                          f"This is batch {n} of {len(batches)}. It holds {len(batch)} separate offers from different "
                          "businesses, each starting at '=== OFFER n ==='. Return at most one entry per offer, and quote only "
                          "from that offer's own text."))
    else:
        chunks = split_chunks(marked, CHUNK_CHARS, CHUNK_OVERLAP_CHARS)
        for index, chunk in enumerate(chunks, 1):
            note = f"This is part {index} of {len(chunks)} of a long page; parts overlap, so an offer may repeat." if len(chunks) > 1 else None
            units.append((chunk, chunk, note))

    items: list[tuple[dict[str, Any], str]] = []
    seen_keys: set[str] = set()
    chunk_errors = 0
    for index, (chunk, plain_chunk, note) in enumerate(units, 1):
        if spent_so_far() + estimate_cost(len(chunk), in_rate, out_rate) > cap_usd:
            result.budget_exhausted = True
            stats.notes.append(f"budget cap ${cap_usd:.2f} reached before {ref.url}"
                               + (f" (call {index}/{len(units)})" if len(units) > 1 else ""))
            chunk_errors += 1
            break
        prompt = build_user_prompt(source_name=source.name, hints=source.extract_hints, page_url=ref.url,
                                   today=today, text=chunk, chunk_note=note)
        extracted = client_call(prompt)
        result.input_tokens += extracted.input_tokens
        result.output_tokens += extracted.output_tokens
        cost = extracted.input_tokens / 1e6 * in_rate + extracted.output_tokens / 1e6 * out_rate
        stats.cost_usd += cost
        result.cost_usd += cost
        if extracted.error:
            chunk_errors += 1
            stats.notes.append(f"{ref.url}: extraction failed: {extracted.error}")
            continue
        for item in extracted.deals:
            key = _deal_key(item)
            if key and key in seen_keys:
                continue
            seen_keys.add(key)
            items.append((item, plain_chunk))
    stats.pages_extracted += 1

    records: list[dict[str, Any]] = []
    for item, plain_chunk in items:
        stats.deals_extracted += 1
        title_text = str(item.get("title") or "(untitled)")
        item_page = replace(page, repair_text=plain_chunk, repaired=[])
        verdict = gate_deal(item, item_page, today=today, edinburgh_source=source.edinburgh,
                            default_eligibility=source.default_eligibility,
                            edinburgh_evidence=source.edinburgh_evidence, national_ok=source.national_ok)
        if not verdict.ok:
            reason = verdict.reason if verdict.reason in REASONS else "invalid_record"
            stats.rejected[reason] += 1
            if len(stats.rejection_examples) < MAX_REJECTION_EXAMPLES:
                stats.rejection_examples.append({"title": title_text, "page": ref.url, "reason": reason, "detail": verdict.detail or ""})
            continue
        stats.quotes_repaired += len(item_page.repaired)
        for name in verdict.dropped:
            stats.dropped_fields[name] += 1
        raw = to_raw_happening(item, verdict, source_name=source.name, page_url=ref.url)
        if verdict.national and source.national_venue:
            raw["venue_name"] = source.national_venue
        # Slug: the page for a one-deal page, else page + title. Identity may replace it.
        base_slug = f"{source.id}-{page_slug(ref.url)}"
        raw["slug"] = base_slug if not source.multi_deal_pages else slugify(f"{base_slug}-{title_text}")[:110]
        record = build_full_record(raw, batch_id, EDINBURGH, "deal-source", model, now_iso)
        if record is None:
            stats.rejected["invalid_record"] += 1
            if len(stats.rejection_examples) < MAX_REJECTION_EXAMPLES:
                stats.rejection_examples.append({"title": title_text, "page": ref.url, "reason": "invalid_record", "detail": "build_full_record refused the record"})
            continue
        image = None if source.multi_deal_pages else (ref.image_url or og_image(html, base))
        if image:
            record["image_url"] = image
        record["_deal_source"] = source.id
        record["_trust"] = source.trust
        record["_evidence"] = {
            "deal_quote": item.get("quote"),
            "fields": verdict.evidence,
            "dropped_fields": verdict.dropped,
        }
        records.append(record)
    ok = chunk_errors == 0
    return dedupe_offers(records, stats), ok, return_text


def dedupe_offers(records: list[dict[str, Any]], stats: SourceStats) -> list[dict[str, Any]]:
    """Drop repeats of one offer (same venue, label, dates, recurrence): overlapping
    chunks and pages that list the same partner offer extract it more than once."""
    unique: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for record in records:
        key = (normalise(record.get("venue_name") or ""), normalise(record.get("saving_label") or ""),
               record.get("starts_at"), record.get("ends_at"), json.dumps(record.get("recurrence"), sort_keys=True))
        if key[0] and key in seen:
            stats.rejected["duplicate"] += 1
            continue
        seen.add(key)
        unique.append(record)
    return unique


def _unique_slugs(records: list[dict[str, Any]]) -> None:
    seen: Counter = Counter()
    for record in records:
        slug = record["slug"]
        seen[slug] += 1
        if seen[slug] > 1:
            record["slug"] = f"{slug}-{seen[slug]}"[:120]


def run_deal_sources(
    sources: tuple[DealSource, ...],
    *,
    batch_id: str,
    today: date,
    now_iso: str,
    cap_usd: float,
    in_rate: float,
    out_rate: float,
    catalogue: Catalogue | None = None,
    ledger_enabled: bool = True,
    stage_write: bool = False,
    out_dir: Path | None = None,
    model: str | None = None,
    fetcher: PoliteFetcher | None = None,
    client: Any = None,
    log: Callable[[str], None] = print,
) -> DealRunResult:
    """Run `sources`. `ledger_enabled=False` never touches the database. Ledger
    writes happen only for LIVE sources and only when `stage_write` is true, and
    then only when the caller runs `result.commit_ledgers()` after staging."""
    result = DealRunResult(cap_usd=cap_usd)
    fetcher = fetcher or PoliteFetcher()
    model = model or default_research_model()
    now_dt = datetime.fromisoformat(now_iso)
    llm = client
    llm_error: str | None = None

    def get_client() -> Any:
        nonlocal llm, llm_error
        if llm is None and llm_error is None:
            if research_provider() == "none":
                llm_error = "no LLM API key set (DEEPSEEK_API_KEY)"
            else:
                try:
                    llm, _provider = make_research_client("deal-sources")
                except DeepSeekPeakHours as exc:  # pages stay unrecorded, so the next off-peak run redoes them
                    llm_error = str(exc)
        return llm

    def call_llm(prompt: str) -> ExtractResult:
        c = get_client()
        if c is None:
            return ExtractResult([], error=llm_error or "no client")
        return extract_deals(c, model, prompt)

    for source in sources:
        stats = SourceStats(source.id, source.name, source.trust, source.status)
        result.stats.append(stats)
        mode = "off" if not ledger_enabled else ("rw" if (source.status == "live" and stage_write) else "read")
        ledger = Ledger(mode, log=log, defer=True)
        result.ledgers.append(ledger)
        ledger.load(source.id)

        refs, notes = discover(source, fetcher, now_dt)
        stats.notes.extend(notes)
        for note in notes:
            result.failures.append({"source": f"deal source {source.id}", "reason": note})
        stats.pages_discovered = len(refs)
        log(f"[deal-sources] {source.id}: {len(refs)} page(s) discovered ({source.status}, {source.trust})")

        source_records: list[dict[str, Any]] = []
        for position, ref in enumerate(refs):
            if result.budget_exhausted:
                stats.pages_budget_skipped += len(refs) - position
                break
            html = ref.html
            status_code: int | None = 200
            if html is None:
                resp = fetcher.get(ref.url)
                if not resp.ok:
                    stats.pages_failed += 1
                    stats.notes.append(f"{ref.url}: {resp.reason}")
                    result.failures.append({"source": f"deal source {source.id}", "reason": f"{ref.url}: {resp.reason}"})
                    continue
                html, status_code = resp.text or "", resp.status
                ref.url = resp.final_url or ref.url
            stats.pages_fetched += 1

            probe_text = f"{ref.title or ''}\n{html_to_text(html, base_url=ref.url)}".strip()
            if ledger.is_unchanged(ref.url, probe_text):
                stats.pages_unchanged += 1
                continue

            records, ok, page_text = process_page(
                source, ref, html,
                client_call=call_llm, stats=stats, today=today, batch_id=batch_id, model=model,
                now_iso=now_iso, in_rate=in_rate, out_rate=out_rate,
                spent_so_far=lambda: result.cost_usd, cap_usd=cap_usd, result=result, log=log,
            )
            source_records.extend(records)
            if ok:
                if ledger.record(ref.url, source.id, page_text, status_code):
                    stats.ledger_writes += 1
            else:
                result.failures.append({"source": f"deal source {source.id}", "reason": f"{ref.url}: extraction incomplete, not recorded in the ledger"})

        source_records = dedupe_offers(source_records, stats)
        stats.kept = len(source_records)
        _unique_slugs(source_records)

        # Identity: like topic candidates, match against live/dormant rows and provider events.
        if catalogue and source_records:
            kept, dropped, review = reconcile(source_records, catalogue)
            result.dropped_known.extend(f"[{source.id}] {note}" for note in dropped)
            result.identity_review.extend(f"[{source.id}] {note}" for note in review)
            source_records = kept
            stats.refreshes_known = sum(1 for r in kept if r.get("_known_happening_id"))
            stats.new_rows = len(kept) - stats.refreshes_known
        else:
            stats.new_rows = len(source_records)
        for record in source_records:
            if len(stats.samples) >= MAX_SAMPLES:
                break
            stats.samples.append(sample_row(record))

        if source.status == "live":
            result.live_records.extend(source_records)
        else:
            result.shadow_records.extend(source_records)

        if out_dir is not None:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / f"{source.id}-records.json").write_text(
                json.dumps({"records": source_records}, ensure_ascii=False, indent=2) + "\n")
        log(f"[deal-sources] {source.id}: fetched={stats.pages_fetched} unchanged={stats.pages_unchanged} "
            f"extracted={stats.deals_extracted} kept={stats.kept} rejected={sum(stats.rejected.values())} "
            f"cost=${stats.cost_usd:.4f}")

    if out_dir is not None:
        (out_dir / "deal-sources-summary.json").write_text(json.dumps(summary_json(result), ensure_ascii=False, indent=2) + "\n")
    return result


def sample_row(record: dict[str, Any]) -> dict[str, Any]:
    evidence = record.get("_evidence") or {}
    return {
        "title": record.get("title"),
        "slug": record.get("slug"),
        "venue_name": record.get("venue_name"),
        "saving_label": record.get("saving_label"),
        "price_text": record.get("price_text"),
        "promo_code": record.get("promo_code"),
        "eligibility": record.get("eligibility"),
        "starts_at": record.get("starts_at"),
        "ends_at": record.get("ends_at"),
        "recurrence": record.get("recurrence"),
        "source_url": record.get("source_url"),
        "known": record.get("_known_happening_id"),
        "deal_quote": evidence.get("deal_quote"),
        "field_quotes": {k: v.get("quote") for k, v in (evidence.get("fields") or {}).items() if v.get("quote")},
    }


def summary_json(result: DealRunResult) -> dict[str, Any]:
    return {
        "cost_usd": result.cost_usd,
        "cap_usd": result.cap_usd,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "budget_exhausted": result.budget_exhausted,
        "sources": [s.to_json() for s in result.stats],
        "dropped_known": result.dropped_known,
        "identity_review": result.identity_review,
        "failures": result.failures,
    }


def markdown_section(result: DealRunResult, *, heading: str = "## Deal sources", show_samples: bool = True) -> list[str]:
    """The report's "Deal sources" section (list of lines)."""
    lines = [heading, "",
             f"Cost: ${result.cost_usd:.4f} of ${result.cap_usd:.2f} sub-cap "
             f"({result.input_tokens} in / {result.output_tokens} out tokens)."
             + (" **Budget cap reached; some pages were not read.**" if result.budget_exhausted else ""), ""]
    if not result.stats:
        return lines + ["- No deal sources configured for this run.", ""]
    lines += ["| source | trust | status | pages | unchanged | failed | extracted | kept | rejected | new / known | cost |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for s in result.stats:
        rejected = ", ".join(f"{k} {v}" for k, v in sorted(s.rejected.items())) or "0"
        lines.append(f"| {s.source_id} | {s.trust} | {s.status} | {s.pages_fetched}/{s.pages_discovered} | {s.pages_unchanged} | "
                     f"{s.pages_failed} | {s.deals_extracted} | {s.kept} | {rejected} | {s.new_rows} / {s.refreshes_known} | ${s.cost_usd:.4f} |")
    lines.append("")
    for s in result.stats:
        lines += [f"### {s.name} (`{s.source_id}`, {s.status}, {s.trust})", ""]
        if s.status == "shadow":
            lines += ["Shadow source: reported only, nothing staged.", ""]
        if s.quotes_repaired:
            lines += [f"Quotes repaired from the page's own text (>= 80% of the words matched): {s.quotes_repaired}", ""]
        if s.dropped_fields:
            lines += ["Fields dropped (display-only text that failed its quote check): "
                      + ", ".join(f"{k} {v}" for k, v in sorted(s.dropped_fields.items())), ""]
        if s.pages_budget_skipped:
            lines += [f"{s.pages_budget_skipped} page(s) skipped: budget cap.", ""]
        for note in s.notes[:8]:
            lines.append(f"- note: {note}")
        if s.notes:
            lines.append("")
        if show_samples and s.samples:
            lines += ["Sample kept rows:", ""]
            for sample in s.samples:
                lines.append(f"- **{sample['title']}** ({sample['venue_name'] or 'no venue'}): "
                             f"{sample['saving_label'] or sample['price_text'] or 'no label'}; "
                             f"{sample['starts_at'] or ''} {sample['ends_at'] or ''} {json.dumps(sample['recurrence'])}"
                             + (" -> refreshes known row" if sample.get("known") else ""))
                lines.append(f"  - quote: \"{_short(sample['deal_quote'], 220)}\"")
            lines.append("")
        if s.rejection_examples:
            lines += ["Rejected examples:", ""]
            for ex in s.rejection_examples:
                lines.append(f"- {ex['title']} [{ex['reason']}]: {_short(ex['detail'], 160)}")
            lines.append("")
    if result.dropped_known:
        lines += ["Dropped — already in a provider feed:", ""] + [f"- {n}" for n in result.dropped_known] + [""]
    if result.identity_review:
        lines += ["Identity — needs review:", ""] + [f"- {n}" for n in result.identity_review] + [""]
    return lines
