"""Score, route and (only when asked) auto-publish a run's final records.

Called from weekly_edinburgh.py after a run's records are final. Everything that touches the
outside world (the DeepSeek rating call, the page re-check, the database, the promote script) is
injected, so the tests use fakes and nothing here writes by default.

Steps, in order:
  1. rate_records   one off-peak DeepSeek call per 25 records (deal_sources.quality.rate_relevance).
                    A failed call means no cap for those records; it is logged, never fatal.
  2. route_records  score_deal + route_deal per record. This must run in-process: a staged row loses
                    `_evidence` (it is not a database column), and route_deal needs it.
  3. finalize       apply_daily_limit, then a FRESH CHECK of every row still routed publish
                    (verify_record against its source page, now). A failure moves the row to digest
                    with the reason, and the freed slot goes to the next best row.
  4. publish        ONLY when auto-publish is on: approve exactly the rows that are routed publish,
                    freshly verified and from a web source, then promote exactly those slugs.
                    With auto-publish off nothing is approved or promoted: the run only reports
                    "would publish" (shadow mode).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from deal_sources import quality
from deal_sources.quality import QualityResult, RoutedDeal

REPO_ROOT = Path(__file__).resolve().parent.parent

MAX_FRESH_CHECKS = 30  # page re-checks per run; more candidates than this go to digest
ROUTING_RESERVE_USD = 0.03  # held back from the run's cap for the rating calls
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")  # the only slugs auto-publish will pass to the promote script
PUBLISH_FRESH_REASON = "fresh check failed: "


# --- 1. AI relevance rating ---------------------------------------------------------------------


@dataclass
class RatingInfo:
    status: str = "not run"
    asked: int = 0
    rated: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    errors: list[str] = field(default_factory=list)


def rate_records(
    records: list[dict[str, Any]],
    make_call: Callable[[], Callable[[str], quality.RatingResult]],
    *,
    in_rate: float,
    out_rate: float,
    budget_usd: float,
    log: Callable[[str], None] = print,
) -> tuple[dict[str, int], RatingInfo]:
    """slug -> 1-5, plus what happened. `make_call()` builds the rating call (it raises when the
    client can't be built, for example in DeepSeek's peak hours); any failure here means no ratings,
    which means no score cap, and is logged. Never raises."""
    info = RatingInfo(asked=len([r for r in records if r.get("slug")]))
    if not info.asked:
        info.status = "nothing to rate"
        return {}, info
    try:
        call = make_call()
    except BaseException as exc:  # SystemExit too: make_research_client exits when no key is set
        if isinstance(exc, KeyboardInterrupt):
            raise
        info.status = f"NOT RUN: {exc.__class__.__name__}: {exc}"
        log(f"[routing] AI rating {info.status}; scoring without the relevance cap")
        return {}, info

    def counted(prompt: str) -> quality.RatingResult:
        spent = info.input_tokens / 1e6 * in_rate + info.output_tokens / 1e6 * out_rate
        if spent >= budget_usd:
            result = quality.RatingResult([], error="rating budget reached")
        else:
            result = call(prompt)
        info.input_tokens += result.input_tokens
        info.output_tokens += result.output_tokens
        if result.error:
            info.errors.append(result.error)
        return result

    ratings = quality.rate_relevance(records, counted)
    info.rated = len(ratings)
    info.cost_usd = info.input_tokens / 1e6 * in_rate + info.output_tokens / 1e6 * out_rate
    info.status = "ran"
    if info.errors:
        log(f"[routing] AI rating: {len(info.errors)} failed batch(es) ({sorted(set(info.errors))[0]}); those rows get no cap")
    return ratings, info


# --- 2 and 3. route, limit, fresh check ---------------------------------------------------------


def route_records(records: list[dict[str, Any]], ratings: dict[str, int], *, today: date | None = None,
                  now: datetime | None = None) -> list[RoutedDeal]:
    """score_deal + route_deal for each record (before the daily limit)."""
    out: list[RoutedDeal] = []
    for record in records:
        result = quality.score_deal(record, ai_rating=ratings.get(str(record.get("slug"))), now=now)
        route = quality.route_deal(record, result, source_class=quality.source_class(record), today=today)
        out.append(RoutedDeal(record, result, route))
    return out


@dataclass
class FreshStats:
    checked: int = 0
    failed: int = 0
    skipped_over_limit: int = 0
    failures: list[tuple[str, list[str]]] = field(default_factory=list)  # (title, reasons)
    already_today: int = 0  # rows auto-published today (London date) before this run
    cooldown: int = 0  # moved to digest: the venue got an auto-published deal in the last COOLDOWN_DAYS
    blocked: int = 0  # moved to digest: the day's limit was used up, or the limit history could not be read
    history_error: str | None = None


COOLDOWN_DAYS = 7  # a venue with an auto-published deal this recently routes to digest


@dataclass
class PublishHistory:
    """Rows this pipeline published recently, for the limits that hold across runs."""
    published_today: int = 0
    recent: list[dict[str, Any]] = field(default_factory=list)  # published within COOLDOWN_DAYS: venue_name, place_id, title, created_at


def load_publish_history(get_all: Callable[[str, dict[str, str]], list[dict[str, Any]]], *,
                         now: datetime | None = None) -> tuple[PublishHistory | None, str | None]:
    """(history, None), or (None, why) when it can't be read. Never raises.

    "Published by this pipeline" = a staged row routed publish that was then approved or promoted. The
    staged row's created_at (set when the row is first inserted, which for an auto-published row is the
    run that published it) is the publish time; "today" is the London date. A row a person approved by hand
    that was also routed publish counts too, which errs towards publishing less. Needs the quality_route
    column (add_deal_quality.sql): without it the read fails and the caller fails safe."""
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=COOLDOWN_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        rows = get_all("happenings_staging", {
            "quality_route": "eq.publish", "approved": "eq.true", "extraction_status": "in.(approved,promoted)",
            "created_at": f"gte.{cutoff}", "select": "slug,title,venue_name,place_id,created_at,source_name",
        })
    except Exception as exc:  # noqa: BLE001 - a failed read is a reported state, never a crash
        return None, f"{exc.__class__.__name__}: {str(exc)[:200]}"
    london_today = now.astimezone(quality.LONDON).date()
    today = 0
    for row in rows:
        stamp = quality._parse_timestamp(row.get("created_at"))
        if stamp is not None and stamp.astimezone(quality.LONDON).date() == london_today:
            today += 1
    return PublishHistory(today, list(rows)), None


def finalize(
    routed: list[RoutedDeal],
    verify: Callable[[dict[str, Any]], list[str]],
    *,
    max_checks: int = MAX_FRESH_CHECKS,
    history: PublishHistory | None = None,
    block_reason: str | None = None,
) -> tuple[list[RoutedDeal], set[str], FreshStats]:
    """Apply the limits, then fresh-check every row left routed publish.

    Limits that hold across runs come first: with `history`, a row whose venue (quality.same_venue) had a
    deal auto-published in the last COOLDOWN_DAYS goes to digest, and only the day's remainder of
    DAILY_PUBLISH_LIMIT can publish. `block_reason` (history unreadable while auto-publish is on) sends every
    publish row to digest. Then the per-run limits, then the fresh check.

    `verify(record)` returns the reasons the record no longer matches its source page (empty = it
    does); an exception counts as a failure. A failed row becomes digest with the reason, and the
    limits are applied again so the next best row can take its place (it is checked in turn).
    Returns (final rows in the input order, slugs freshly verified, stats). Only rows in that slug
    set may be published."""
    current = list(routed)
    checked: dict[int, list[str]] = {}
    stats = FreshStats()

    def demote(i: int, reason: str) -> None:
        current[i] = replace(current[i], route="digest", result=QualityResult(current[i].result.score, [*current[i].result.reasons, reason]))

    remaining = quality.DAILY_PUBLISH_LIMIT
    if history is not None:
        stats.already_today = history.published_today
        remaining = max(0, quality.DAILY_PUBLISH_LIMIT - history.published_today)
    for i, item in enumerate(current):
        if item.route != "publish":
            continue
        if block_reason:
            demote(i, block_reason)
            stats.blocked += 1
        elif history is not None:
            recent = next((c for c in history.recent if quality.same_venue(item.record, c)), None)
            if recent is not None:
                when = str(recent.get("created_at") or "")[:10]
                demote(i, f"venue cooldown: '{recent.get('title')}' was auto-published at this venue on {when} "
                          f"(one per venue every {COOLDOWN_DAYS} days): moved to digest")
                stats.cooldown += 1
            elif remaining <= 0:
                demote(i, f"daily limit of {quality.DAILY_PUBLISH_LIMIT} already reached today "
                          f"({history.published_today} auto-published): moved to digest")
                stats.blocked += 1
    while True:
        limited = quality.apply_daily_limit(current, remaining, already_today=stats.already_today)
        todo = [i for i, r in enumerate(limited) if r.route == "publish" and i not in checked]
        if not todo:
            break
        for i in todo:
            if stats.checked >= max_checks:
                failures = ["the per-run limit of page re-checks was reached"]
                stats.skipped_over_limit += 1
            else:
                stats.checked += 1
                try:
                    failures = [str(f) for f in verify(limited[i].record)]
                except Exception as exc:  # a re-check that blows up is a failed re-check
                    failures = [f"re-check error: {exc.__class__.__name__}: {exc}"]
            checked[i] = failures
            if failures:
                stats.failed += 1
                stats.failures.append((str(current[i].record.get("title") or current[i].record.get("slug")), failures))
                reason = PUBLISH_FRESH_REASON + "; ".join(failures)
                current[i] = replace(current[i], route="digest",
                                     result=QualityResult(current[i].result.score, [*current[i].result.reasons, reason[:400]]))
    fresh_ok = {str(limited[i].record.get("slug")) for i, f in checked.items() if not f and limited[i].route == "publish"}
    return limited, fresh_ok, stats


EVIDENCE_QUOTE_MAX = 600


def evidence_quote(record: dict[str, Any]) -> str | None:
    """The deal's main quote from the page (the gate's `_evidence`), else the first field quote. None when
    the record has no in-memory evidence (a topic record)."""
    evidence = record.get("_evidence")
    if not isinstance(evidence, dict):
        return None
    quote = evidence.get("deal_quote")
    if not (isinstance(quote, str) and quote.strip()):
        fields = evidence.get("fields")
        quotes = [v.get("quote") for v in fields.values() if isinstance(v, dict) and isinstance(v.get("quote"), str) and v["quote"].strip()] \
            if isinstance(fields, dict) else []
        quote = quotes[0] if quotes else None
    return " ".join(quote.split())[:EVIDENCE_QUOTE_MAX] if quote else None


def apply_to_records(final: list[RoutedDeal]) -> None:
    """Write quality_score / quality_reasons / quality_route (every route, drops too) and, where the record
    carries the gate's evidence, evidence_quote onto each record, so the staged row shows its proof."""
    for item in final:
        item.record["quality_score"] = item.result.score
        item.record["quality_reasons"] = list(item.result.reasons)
        item.record["quality_route"] = item.route
        quote = evidence_quote(item.record)
        if quote:
            item.record["evidence_quote"] = quote


# --- evidence ----------------------------------------------------------------------------------


def evidence_by_source(records: list[dict[str, Any]]) -> dict[str, tuple[int, int]]:
    """source_name -> (rows, rows that carried `_evidence`). Only in-process records carry it:
    a row read back from the database never does."""
    counts: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for record in records:
        entry = counts[str(record.get("source_name") or "(none)")]
        entry[0] += 1
        if record.get("_evidence"):
            entry[1] += 1
    return {name: (total, with_ev) for name, (total, with_ev) in counts.items()}


# --- the whole routing step ---------------------------------------------------------------------


@dataclass
class RoutingOutcome:
    final: list[RoutedDeal]
    fresh_ok: set[str]
    fresh: FreshStats
    rating: RatingInfo
    evidence: dict[str, tuple[int, int]]
    publishable: list[RoutedDeal]  # routed publish AND freshly verified AND a web source (what auto-publish would touch)


def select_publishable(final: list[RoutedDeal], fresh_ok: set[str]) -> list[RoutedDeal]:
    """The only rows auto-publish may touch: routed publish, freshly verified this run, a web source
    (social and newsletter rows never), and a slug the promote script can be given safely."""
    return [
        r for r in final
        if r.route == "publish"
        and str(r.record.get("slug")) in fresh_ok
        and quality.source_class(r.record) in quality.PUBLISH_SOURCE_CLASSES
        and SLUG_RE.match(str(r.record.get("slug") or ""))
    ]


def run_routing(
    records: list[dict[str, Any]],
    *,
    make_rating_call: Callable[[], Callable[[str], quality.RatingResult]],
    verify: Callable[[dict[str, Any]], list[str]],
    in_rate: float,
    out_rate: float,
    rating_budget_usd: float,
    today: date | None = None,
    now: datetime | None = None,
    history: PublishHistory | None = None,
    history_error: str | None = None,
    fail_safe: bool = False,
    log: Callable[[str], None] = print,
) -> RoutingOutcome:
    """Rate, score, route, limit and fresh-check `records`, and stamp the quality_* fields onto them.
    Does not write anywhere and does not publish.

    `history` is what load_publish_history found (rows published today and in the cooldown window); None
    with `history_error` means it could not be read. With `fail_safe` (auto-publish is on) an unreadable
    history sends every would-be publish to digest and logs it. Without it (shadow mode) the cross-run
    limits are skipped and the report says so."""
    ratings, rating = rate_records(records, make_rating_call, in_rate=in_rate, out_rate=out_rate,
                                   budget_usd=rating_budget_usd, log=log)
    routed = route_records(records, ratings, today=today, now=now)
    block_reason = None
    if history is None and fail_safe:
        block_reason = f"auto-publish limits could not be read ({history_error or 'unknown'}): publishing nothing"
        log(f"[routing] {block_reason}")
    final, fresh_ok, fresh = finalize(routed, verify, history=history, block_reason=block_reason)
    fresh.history_error = history_error if history is None else None
    apply_to_records(final)
    outcome = RoutingOutcome(final, fresh_ok, fresh, rating, evidence_by_source(records), select_publishable(final, fresh_ok))
    counts = Counter(r.route for r in final)
    log(f"[routing] {len(final)} record(s): publish {counts['publish']}, digest {counts['digest']}, drop {counts['drop']}; "
        f"fresh checks {fresh.checked} ({fresh.failed} failed)")
    return outcome


# --- 4. publishing (auto-publish only) ---------------------------------------------------------


@dataclass
class PublishResult:
    approved: list[str] = field(default_factory=list)
    promoted: bool = False
    notes: list[str] = field(default_factory=list)


def approve_staged_rows(batch_id: str, slugs: list[str]) -> tuple[list[str], str | None]:
    """Set approved = true on exactly these staged rows of this batch (never one already promoted).
    Returns (slugs actually approved, error)."""
    import requests  # lazy: tests never reach here

    from weekly_edinburgh import supabase_connection  # lazy: importing it loads the env files

    connection = supabase_connection()
    if not connection:
        return [], "Supabase credentials are unavailable"
    url, key = connection
    quoted = ",".join('"' + s.replace('"', '\\"') + '"' for s in slugs)
    try:
        resp = requests.patch(
            f"{url}/rest/v1/happenings_staging",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                     "Prefer": "return=representation"},
            params={"batch_id": f"eq.{batch_id}", "slug": f"in.({quoted})", "extraction_status": "neq.promoted", "select": "slug"},
            json={"approved": True, "extraction_status": "approved"},
            timeout=30,
        )
        resp.raise_for_status()
        return [row["slug"] for row in resp.json()], None
    except requests.RequestException as exc:
        return [], f"{exc.__class__.__name__}: {exc}"


def promote_staged_rows(batch_id: str, slugs: list[str]) -> str | None:
    """Run scripts/promote-happenings.mjs for exactly these slugs. Returns an error text or None."""
    env_args = ["--env-file=.env.local"] if (REPO_ROOT / ".env.local").is_file() else []
    try:
        subprocess.run(
            ["node", *env_args, "scripts/promote-happenings.mjs", "--batch-id", batch_id, "--slugs", ",".join(slugs)],
            cwd=REPO_ROOT, env=os.environ.copy(), text=True, capture_output=True, check=True,
        )
        return None
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        return detail.strip()[-600:]


def auto_publish(
    outcome: RoutingOutcome,
    batch_id: str,
    *,
    enabled: bool,
    approve: Callable[[str, list[str]], tuple[list[str], str | None]] | None = None,
    promote: Callable[[str, list[str]], str | None] | None = None,
    log: Callable[[str], None] = print,
) -> PublishResult:
    """With `enabled` false this does nothing at all (shadow mode). With it true: approve the
    publishable rows, then promote only the slugs that were really approved."""
    approve = approve or approve_staged_rows  # looked up here, not bound at definition, so tests can swap them
    promote = promote or promote_staged_rows
    result = PublishResult()
    # Recomputed from the final routes rather than trusted from the outcome: the one rule for what may publish.
    wanted = [str(r.record["slug"]) for r in select_publishable(outcome.final, outcome.fresh_ok)]
    if not enabled:
        if wanted:
            log(f"[routing] auto-publish is OFF: {len(wanted)} row(s) would publish; nothing approved or promoted")
        return result
    if not wanted:
        log("[routing] auto-publish is ON: no row qualifies")
        return result
    approved, error = approve(batch_id, wanted)
    if error:
        result.notes.append(f"auto-publish: could not approve rows: {error}")
        log(f"[routing] {result.notes[-1]}")
        return result
    result.approved = [s for s in approved if s in wanted]  # never promote a slug we did not ask for
    if not result.approved:
        result.notes.append("auto-publish: no staged row was approved (not found in happenings_staging)")
        return result
    failure = promote(batch_id, result.approved)
    if failure:
        result.notes.append(f"auto-publish: approved {len(result.approved)} row(s) but promotion failed: {failure}")
        log(f"[routing] {result.notes[-1]}")
        return result
    result.promoted = True
    log(f"[routing] auto-published {len(result.approved)} row(s)")
    return result


# --- report ------------------------------------------------------------------------------------


def _cell(value: Any) -> str:
    return str(value if value not in (None, "") else "-").replace("|", "/").replace("\n", " ")


def markdown_section(outcome: RoutingOutcome, *, auto_publish_on: bool, published: PublishResult | None = None,
                     columns_missing: bool = False) -> list[str]:
    """The report's "Deal quality routing" section."""
    publish_word = "published" if auto_publish_on else "would publish"
    lines = ["## Deal quality routing", ""]
    if auto_publish_on:
        n = len(published.approved) if published else 0
        lines.append(f"**Auto-publish is ON.** Published {n} row(s)" + (" (promoted)." if published and published.promoted else "."))
    else:
        lines.append("**Auto-publish is OFF (shadow mode).** Nothing below was approved or promoted; \"would publish\" rows "
                     "are only reported. Turn it on with the `DEAL_AUTO_PUBLISH` repo variable (docs/weekly-pipeline.md).")
    lines.append("")
    if columns_missing:
        lines += ["**quality_* columns missing** on happenings_staging: run `supabase/add_deal_quality.sql`. Scores were "
                  "computed and reported here but not stored.", ""]
    rating = outcome.rating
    lines.append(f"- AI relevance rating: {rating.status}. Rows asked {rating.asked}, rated {rating.rated}"
                 + (f" ({rating.asked - rating.rated} unrated, so uncapped)" if rating.asked else "")
                 + f". Tokens {rating.input_tokens} in / {rating.output_tokens} out, cost ${rating.cost_usd:.4f}.")
    f = outcome.fresh
    lines.append(f"- Fresh check (source page re-read just before publishing): {f.checked} checked, {f.failed} failed and moved to digest"
                 + (f", {f.skipped_over_limit} over the per-run limit of {MAX_FRESH_CHECKS}" if f.skipped_over_limit else "") + ".")
    lines.append(f"- Limits: {quality.DAILY_PUBLISH_LIMIT} a day across runs (London date), {quality.VENUE_PUBLISH_LIMIT} per venue per run, "
                 f"{quality.SOURCE_PUBLISH_LIMIT} per source per run, and a venue with an auto-published deal in the last {COOLDOWN_DAYS} days goes to digest.")
    if f.history_error:
        lines.append(f"- **Limit history unavailable** ({f.history_error}). "
                     + ("Auto-publish is on, so nothing was published: " if auto_publish_on else
                        "With auto-publish on, nothing would publish; this shadow list ignores the cross-run limits: ")
                     + "the read needs `supabase/add_deal_quality.sql`.")
    else:
        lines.append(f"- Published today before this run: {f.already_today} of {quality.DAILY_PUBLISH_LIMIT}. "
                     f"Moved to digest by the venue cooldown: {f.cooldown}. By the day's limit: {f.blocked}.")
    lines.append("")

    per: dict[str, Counter] = defaultdict(Counter)
    for item in outcome.final:
        per[str(item.record.get("source_name") or "(none)")][item.route] += 1
    pub_by_source = Counter(str(r.record.get("source_name") or "(none)") for r in outcome.publishable)
    lines += [f"| source | rows | {publish_word} | digest | drop | rows with `_evidence` |", "|---|---|---|---|---|---|"]
    for name, counts in sorted(per.items(), key=lambda kv: (-sum(kv[1].values()), kv[0])):
        total, with_ev = outcome.evidence.get(name, (sum(counts.values()), 0))
        lines.append(f"| {_cell(name)} | {total} | {pub_by_source[name]} | {counts['digest'] + counts['publish'] - pub_by_source[name]} | {counts['drop']} | {with_ev} of {total} |")
    totals = Counter(r.route for r in outcome.final)
    all_total = sum(t for t, _ in outcome.evidence.values())
    all_ev = sum(e for _, e in outcome.evidence.values())
    lines += [f"| **all** | {all_total} | {len(outcome.publishable)} | {totals['digest'] + totals['publish'] - len(outcome.publishable)} | {totals['drop']} | {all_ev} of {all_total} |", ""]
    lines.append("`_evidence` is the quote proof a deal source's record carries in memory; topic records have none. "
                 "route_deal only publishes a row with `_evidence` or a validated extraction.")
    lines.append("")

    if outcome.publishable:
        lines += [f"### {publish_word.capitalize()} ({len(outcome.publishable)})", "", "| title | venue | source | score | kind |", "|---|---|---|---|---|"]
        for r in sorted(outcome.publishable, key=lambda r: -r.result.score):
            rec = r.record
            lines.append(f"| {_cell(rec.get('title'))} | {_cell(rec.get('venue_name'))} | {_cell(rec.get('source_name'))} | {r.result.score} | {_cell(rec.get('kind'))} |")
        lines.append("")
    if f.failures:
        lines += ["### Failed the fresh check (moved to digest)", ""]
        lines += [f"- {title}: {'; '.join(reasons)[:200]}" for title, reasons in f.failures]
        lines.append("")
    drops = [r for r in outcome.final if r.route == "drop"]
    if drops:
        lines += [f"### Dropped ({len(drops)}), staged with their reasons", ""]
        for r in sorted(drops, key=lambda r: r.result.score)[:25]:
            lines.append(f"- {r.record.get('title')} ({r.result.score}): {'; '.join(x for x in r.result.reasons if not x.startswith(('base', 'local', 'value')))[:160]}")
        if len(drops) > 25:
            lines.append(f"- ... and {len(drops) - 25} more (see `edinburgh-weekly-candidates.json`)")
        lines.append("")
    if published and published.notes:
        lines += ["### Auto-publish problems", ""] + [f"- {n}" for n in published.notes] + [""]
    return lines


def summary_json(outcome: RoutingOutcome, *, auto_publish_on: bool, published: PublishResult | None) -> dict[str, Any]:
    counts = Counter(r.route for r in outcome.final)
    return {
        "auto_publish": auto_publish_on,
        "routes": dict(counts),
        "would_publish" if not auto_publish_on else "publishable": [str(r.record.get("slug")) for r in outcome.publishable],
        "published": published.approved if published else [],
        "promoted": bool(published and published.promoted),
        "fresh": {"checked": outcome.fresh.checked, "failed": outcome.fresh.failed},
        "rating": {"status": outcome.rating.status, "asked": outcome.rating.asked, "rated": outcome.rating.rated,
                   "cost_usd": outcome.rating.cost_usd},
        "evidence_by_source": {k: {"rows": v[0], "with_evidence": v[1]} for k, v in outcome.evidence.items()},
    }
