#!/usr/bin/env python3
"""Backtest the deal quality score (scraper/deal_sources/quality.py). Read-only and re-runnable.

  python3 scraper/backtest_quality.py                      # score, reusing cached AI ratings if any
  python3 scraper/backtest_quality.py --refresh-ai         # call DeepSeek again (off-peak only)
  python3 scraper/backtest_quality.py --no-ai              # skip the AI rating entirely

Sets
  A  waiting staged rows: happenings_staging, kind=deal, not approved, not promoted, no happening_id,
     de-duplicated by slug (latest created_at wins), minus slugs that are already live.
  B  live deals: happenings, status=live, kind=deal.
  C  rejected deals: <source-id>-rejected.json files from `weekly_edinburgh.py --deal-sources-preview`
     (--rejected-dir), else the 12-per-source examples in an older deal-sources-report.md (--old-report).

Nothing is written to the database and nothing is staged. Output goes under scraper/out/ (gitignored):
report.md, ai-ratings.json (the cache) and rows.json. The AI rating is one forced-tool DeepSeek call per 25
rows through llm_client.make_research_client, which refuses to run in DeepSeek's peak hours; in peak the
script scores without AI and says so.

Backtest-only assumption (not in route_deal): a stored staged row whose validation_errors are exactly
["commercial_source_review"] is treated as having passed the gate, because stored rows lose the in-memory
`_evidence` a live run would carry. Those rows are labelled "gate assumed" in the report.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import llm_client  # noqa: E402  (loads the .env files through its own code)
from deepseek_hours import DeepSeekPeakHours, peak_message  # noqa: E402
from deal_sources import quality  # noqa: E402

SCRAPER_DIR = Path(__file__).resolve().parent
OUT_DIR = SCRAPER_DIR / "out" / "backtest-2026-11-02"
DEFAULT_REJECTED_DIR = SCRAPER_DIR / "out" / "backtest-2026-11-02-preview" / "deal-sources"
OLD_REPORT = Path("/private/tmp/claude-502/-Users-jasbirsingh-Documents-personal-Roameo/e7f3eee3-5a75-47ed-9408-872b1d10eba1/scratchpad/run26/weekly-research-8/edi-weekly-2026-10-26/deal-sources-report.md")
IN_RATE, OUT_RATE = 0.28, 0.42  # USD per million tokens, the weekly script's defaults
COST_CEILING_USD = 0.50
GATE_ASSUMED = ["commercial_source_review"]
BANDS = [f"{lo}-{lo + 9}" for lo in range(0, 90, 10)] + ["90-100"]

SPOT_CHECKS = [
    ("Nobles of Bellfield", "pint", "Nobles of Bellfield £4 cask pints"),
    ("Lioness of Leith", "IPA", "The Lioness of Leith £5 IPA with any burger"),
    ("film studio hire", "FREAKWORXX", "20% off film studio hire at FREAKWORXX"),
    ("spinal screening", "Chiropractic", "Free spinal screening at Chiropractic Life"),
    ("Tattoo Hospitality", "", "Tattoo Hospitality 2027"),
]


# --- data ------------------------------------------------------------------------------


def source_class(record: dict[str, Any]) -> str:
    return quality.source_class(record)


def load_sets() -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, int]]:
    from weekly_edinburgh import _rest_all, supabase_connection  # noqa: PLC0415

    connection = supabase_connection()
    if not connection:
        sys.exit("[backtest] no Supabase credentials in the environment")
    url, key = connection
    live_all = _rest_all(url, key, "happenings", {"select": "*", "status": "eq.live"})
    live_slugs = {r["slug"] for r in live_all}
    live_deals = [r for r in live_all if r.get("kind") == "deal"]
    staged = _rest_all(url, key, "happenings_staging", {
        "select": "*", "kind": "eq.deal", "approved": "eq.false", "happening_id": "is.null",
        "extraction_status": "neq.promoted",
    })
    notes = {"staged_raw": len(staged)}
    latest: dict[str, dict[str, Any]] = {}
    for row in sorted(staged, key=lambda r: (r.get("created_at") or "", r.get("batch_id") or "")):
        latest[row["slug"]] = row
    notes["staged_after_dedupe"] = len(latest)
    waiting = [r for r in latest.values() if r["slug"] not in live_slugs]
    notes["excluded_already_live"] = len(latest) - len(waiting)
    notes["with_rejected_reason"] = sum(1 for r in waiting if r.get("rejected_reason"))
    for row in waiting:
        if row.get("validation_errors") == GATE_ASSUMED:
            row["_evidence"] = {"deal_quote": "(backtest: stored row, gate assumed from commercial_source_review only)"}
            row["_gate_assumed"] = True
    return waiting, live_deals, notes


def load_rejected(rejected_dir: Path, old_report: Path) -> tuple[list[dict[str, Any]], str]:
    files = sorted(rejected_dir.glob("*-rejected.json")) if rejected_dir.is_dir() else []
    rows: list[dict[str, Any]] = []
    if files:
        for path in files:
            for entry in json.loads(path.read_text()).get("rejected", []):
                rows.append({**entry, "slug": f"rejected:{entry['source_id']}:{len(rows)}"})
        return rows, f"all rejected deals from {len(files)} file(s) in {rejected_dir}"
    if old_report.is_file():
        source_id = None
        for line in old_report.read_text().splitlines():
            heading = re.match(r"### .*\(`([^`]+)`", line)
            if heading:
                source_id = heading.group(1)
                continue
            ex = re.match(r"- (.+?) \[(\w+)\]: (.*)$", line)
            if ex and source_id and "Rejected" not in line:
                rows.append({"source_id": source_id, "url": None, "title": ex.group(1), "saving_label": None,
                             "reason": ex.group(2), "detail": ex.group(3), "quotes": {}, "slug": f"rejected:{source_id}:{len(rows)}"})
        return rows, f"ONLY the 12-per-source examples from {old_report.name} (no preview files); titles only, no saving labels"
    return [], "not available"


def rejected_as_record(entry: dict[str, Any]) -> dict[str, Any]:
    return {"slug": entry["slug"], "title": entry["title"], "kind": "deal", "saving_label": entry.get("saving_label"),
            "source_name": entry["source_id"], "source_url": entry.get("url"), "eligibility": "anyone",
            "extraction_status": "pending", "validation_errors": [entry["reason"]]}


# --- AI rating -------------------------------------------------------------------------


def get_ratings(records: list[dict[str, Any]], mode: str, cache_path: Path) -> tuple[dict[str, int], dict[str, Any]]:
    """slug -> rating, plus facts about the run (status, tokens, cost, rows asked, rows rated)."""
    info: dict[str, Any] = {"status": "", "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "asked": len(records), "rated": 0}
    cache: dict[str, Any] = json.loads(cache_path.read_text()) if cache_path.is_file() else {}
    wanted = {r["slug"] for r in records}
    if mode == "none":
        info["status"] = "skipped (--no-ai)"
        return {}, info
    if mode == "cache" and cache.get("ratings"):
        ratings = {s: v for s, v in cache["ratings"].items() if s in wanted}
        info.update(status=f"cached from {cache.get('at')}", rated=len(ratings), cost_usd=cache.get("cost_usd", 0.0),
                    input_tokens=cache.get("input_tokens", 0), output_tokens=cache.get("output_tokens", 0))
        return ratings, info
    try:
        client, _provider = llm_client.make_research_client("backtest-quality")
    except DeepSeekPeakHours as exc:
        info["status"] = f"NOT RUN: {exc} {peak_message()}"
        return {}, info
    model = llm_client.default_research_model()
    totals = {"in": 0, "out": 0, "errors": []}
    call = quality.make_rating_call(client, model)

    def counted(prompt: str) -> quality.RatingResult:
        if (totals["in"] / 1e6 * IN_RATE + totals["out"] / 1e6 * OUT_RATE) > COST_CEILING_USD / 2:
            return quality.RatingResult([], error="rating budget ceiling reached")
        result = call(prompt)
        totals["in"] += result.input_tokens
        totals["out"] += result.output_tokens
        if result.error:
            totals["errors"].append(result.error)
        return result

    ratings = quality.rate_relevance(records, counted)
    cost = totals["in"] / 1e6 * IN_RATE + totals["out"] / 1e6 * OUT_RATE
    info.update(status=f"ran with {model}", input_tokens=totals["in"], output_tokens=totals["out"], cost_usd=cost,
                rated=len(ratings), errors=totals["errors"])
    cache_path.write_text(json.dumps({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "ratings": ratings,
                                      "cost_usd": cost, "input_tokens": totals["in"], "output_tokens": totals["out"]}, indent=2) + "\n")
    return ratings, info


# --- scoring ---------------------------------------------------------------------------


def score_all(records: list[dict[str, Any]], ratings: dict[str, int]) -> list[dict[str, Any]]:
    out = []
    for record in records:
        cls = source_class(record)
        plain = quality.score_deal(record)
        plain_route = quality.route_deal(record, plain, source_class=cls)
        rating = ratings.get(record["slug"])
        with_ai = quality.score_deal(record, ai_rating=rating)
        ai_route = quality.route_deal(record, with_ai, source_class=cls)
        out.append({"record": record, "class": cls, "rating": rating, "plain": plain, "plain_route": plain_route,
                    "ai": with_ai, "ai_route": ai_route})
    return out


def apply_limits(rows: list[dict[str, Any]]) -> None:
    """Add plain_final / ai_final: the route after the daily, per-venue and per-source limits."""
    for which in ("plain", "ai"):
        routed = [quality.RoutedDeal(r["record"], r[which], r[f"{which}_route"]) for r in rows]
        for r, out in zip(rows, quality.apply_daily_limit(routed)):
            r[f"{which}_final"] = out.route
            r[f"{which}_final_result"] = out.result


def drop_cause(r: dict[str, Any], which: str) -> str:
    reasons = r[which].reasons
    if any(x.startswith("expired") for x in reasons):
        return "expired"
    if any(x.startswith("outside Edinburgh") for x in reasons):
        return "outside Edinburgh"
    return f"score under {quality.DROP_BELOW}"


def route_counts(rows: list[dict[str, Any]], which: str) -> Counter:
    return Counter(r[f"{which}_route"] if which == "ai" else r["plain_route"] for r in rows)


def bands(rows: list[dict[str, Any]], which: str) -> Counter:
    counts: Counter = Counter()
    for r in rows:
        score = r["ai"].score if which == "ai" else r["plain"].score
        counts[BANDS[min(score // 10, 9)]] += 1
    return counts


def cell(value: Any) -> str:
    return str(value if value not in (None, "") else "-").replace("|", "/").replace("\n", " ")


def table(headers: list[str], rows: list[list[Any]]) -> list[str]:
    return ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)] + ["| " + " | ".join(cell(c) for c in row) + " |" for row in rows]


def spread(rows: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    """n rows spread evenly across `rows` ordered by score (deterministic)."""
    ordered = sorted(rows, key=lambda r: (r["plain"].score, r["record"]["slug"]))
    if len(ordered) <= n:
        return ordered
    return [ordered[round(i * (len(ordered) - 1) / (n - 1))] for i in range(n)]


def summary_tables(name: str, rows: list[dict[str, Any]], ai_on: bool) -> list[str]:
    lines = [f"### {name} ({len(rows)} rows)", ""]
    pc, ac = route_counts(rows, "plain"), route_counts(rows, "ai")
    head = ["", "publish", "digest", "drop"]
    body = [["without AI", pc["publish"], pc["digest"], pc["drop"]]]
    body.append(["with AI", ac["publish"], ac["digest"], ac["drop"]] if ai_on else ["with AI", "n/a", "n/a", "n/a"])
    lines += table(head, body) + [""]
    pb, ab = bands(rows, "plain"), bands(rows, "ai")
    lines += table(["score band"] + BANDS, [["without AI"] + [pb[b] for b in BANDS]] + ([["with AI"] + [ab[b] for b in BANDS]] if ai_on else [])) + [""]
    return lines


def row_line(r: dict[str, Any], which: str = "plain") -> list[Any]:
    rec = r["record"]
    return [rec.get("title"), rec.get("venue_name"), rec.get("saving_label"), rec.get("source_name"),
            r[which].score, "gate assumed" if rec.get("_gate_assumed") else ""]


def reasons_line(r: dict[str, Any], which: str = "plain") -> list[Any]:
    rec = r["record"]
    return [rec.get("title"), rec.get("venue_name"), rec.get("saving_label"), rec.get("source_name"),
            r[which].score, "; ".join(r[which].reasons)]


# --- report ----------------------------------------------------------------------------


def limit_sections(a: list[dict[str, Any]], ai_on: bool) -> list[str]:
    L = ["## Daily limits: publish counts before and after", "",
         f"Limits per run: {quality.DAILY_PUBLISH_LIMIT} overall, {quality.VENUE_PUBLISH_LIMIT} per venue (normalised venue_name, else title), "
         f"{quality.SOURCE_PUBLISH_LIMIT} per source. Best score wins; the rest go to digest with a reason.", ""]
    rows = []
    for which, name in (("plain", "without AI"),) + ((("ai", "with AI"),) if ai_on else ()):
        before = sum(1 for r in a if r[f"{which}_route"] == "publish")
        final = [r for r in a if r[f"{which}_final"] == "publish"]
        demoted = Counter()
        for r in a:
            if r[f"{which}_route"] == "publish" and r[f"{which}_final"] != "publish":
                last = r[f"{which}_final_result"].reasons[-1]
                demoted["same venue" if last.startswith("same venue") else "source limit" if last.startswith("source limit") else "daily limit"] += 1
        rows.append([name, before, demoted["same venue"], demoted["source limit"], demoted["daily limit"], len(final)])
    L += table(["", "publish before limits", "moved: same venue", "moved: source limit", "moved: daily limit of 10", "publish after limits"], rows) + [""]
    for which, name in (("ai", "with AI"), ("plain", "without AI")):
        if which == "ai" and not ai_on:
            continue
        final = sorted((r for r in a if r[f"{which}_final"] == "publish"), key=lambda r: -r[which].score)
        title = "with AI, after limits: what would actually publish on day one" if which == "ai" else "without AI, after limits (for comparison)"
        L += [f"## {title} ({len(final)})", ""]
        L += table(["title", "venue", "label", "source", "score", "reasons"], [reasons_line(r, which) for r in final]) + [""]
    return L


def itison_price_section(a: list[dict[str, Any]]) -> list[str]:
    its = [r for r in a if "itison" in str(r["record"].get("source_name") or "").lower()]
    L = ["## itison: what `price_text` holds and whether a price per person is known", ""]
    holds = Counter(("empty" if not r["record"].get("price_text") else "has text") for r in its)
    L += [f"itison rows in set A: {len(its)}. `price_text` empty: {holds['empty']}, filled: {holds['has text']}.", ""]
    for which, name in (("plain", "without AI"), ("ai", "with AI")):
        pub = [r for r in its if r[f"{which}_route"] == "publish"]
        known = []
        for r in pub:
            rec = r["record"]
            prices = quality.current_prices(f"{rec.get('title') or ''} {rec.get('saving_label') or ''} {rec.get('price_text') or ''}")
            if prices:
                known.append((r, min(prices)))
        if which == "ai" and not any(r.get("rating") for r in its):
            continue
        L += [f"itison rows routed publish {name} (before limits): {len(pub)}. With a known current price per person: {len(known)}. "
              f"No price stated: {len(pub) - len(known)}.", ""]
        if which == "plain":
            L += table(["title", "label", "price_text", "per person", "score"],
                       [[r["record"].get("title"), r["record"].get("saving_label"), r["record"].get("price_text"),
                         f"£{p:g}" if p is not None else "unknown", r[which].score]
                        for r, p in [(r, next((pr for rr, pr in known if rr is r), None)) for r in pub]]) + [""]
    return L


def build_report(a: list[dict[str, Any]], b: list[dict[str, Any]], c: list[dict[str, Any]], c_note: str,
                 ai_info: dict[str, Any], notes: dict[str, int], spot: list[list[Any]]) -> str:
    ai_on = bool(ai_info.get("rated"))
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    L: list[str] = [f"# Deal quality backtest, {now}", "",
                    "Read-only. Thresholds are the untuned drafts in `quality.py`: "
                    f"drop under {quality.DROP_BELOW}, publish at {quality.PUBLISH_AT}+ with clean checks. Auto-publish is off.", "",
                    "## Run facts", ""]
    L += [f"- Set A: {len(a)} waiting staged rows ({notes['staged_raw']} unpromoted unapproved deal rows, "
          f"{notes['staged_after_dedupe']} after de-duplicating by slug, {notes['excluded_already_live']} excluded as already live"
          f"; {notes['with_rejected_reason']} of the {len(a)} carry a `rejected_reason`).",
          f"- Set B: {len(b)} live deals.",
          f"- Set C: {len(c)} rejected deals: {c_note}.",
          f"- Gate assumed (backtest only): {sum(1 for r in a if r['record'].get('_gate_assumed'))} set A rows whose stored validation_errors are exactly "
          "[\"commercial_source_review\"] were given `_evidence` so they count as gate-passed. `route_deal` is unchanged. This also gives them the evidence +10.",
          f"- Source class: every row is `web` unless its source URL is on instagram/facebook/tiktok/x (social) or its source name says newsletter.",
          f"- AI rating: {ai_info['status']}. Rows asked {ai_info['asked']}, rows actually rated {ai_info['rated']}"
          + (f" ({ai_info['asked'] - ai_info['rated']} unrated: a failed or partial batch gives no cap)." if ai_info['asked'] else ".")
          + f" Tokens {ai_info['input_tokens']} in / {ai_info['output_tokens']} out, cost ${ai_info['cost_usd']:.4f}."]
    if ai_info.get("errors"):
        L.append(f"- AI batch errors: {'; '.join(sorted(set(ai_info['errors']))[:5])}")
    L += ["", "## Counts and score bands", ""]
    L += summary_tables("Set A: waiting staged", a, ai_on)
    L += summary_tables("Set B: live deals", b, ai_on)
    if c:
        L += summary_tables("Set C: rejected deals (title and saving label only; they failed the gate, so publish is shown as a score only)", c, False)
        hi = sum(1 for r in c if r["plain"].score >= quality.PUBLISH_AT)
        L += [f"Set C rows scoring {quality.PUBLISH_AT}+ (would publish if the gate had passed them): {hi}.", ""]
        by_reason: dict[str, Counter] = defaultdict(Counter)
        for r in c:
            by_reason[r["record"]["validation_errors"][0]][r["plain_route"]] += 1
        L += table(["gate rejection reason", "rows", "score >= 70", "score 40-69", "score < 40"],
                   [[reason, sum(v.values()),
                     sum(1 for r in c if r["record"]["validation_errors"][0] == reason and r["plain"].score >= quality.PUBLISH_AT),
                     sum(1 for r in c if r["record"]["validation_errors"][0] == reason and quality.DROP_BELOW <= r["plain"].score < quality.PUBLISH_AT),
                     sum(1 for r in c if r["record"]["validation_errors"][0] == reason and r["plain"].score < quality.DROP_BELOW)]
                    for reason, v in sorted(by_reason.items())]) + [""]
    else:
        L += ["### Set C: not run", ""]

    # Per source, set A.
    per: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in a:
        per[r["record"].get("source_name") or "(none)"].append(r)
    L += ["## Set A per source", ""]
    ordered = sorted(per.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    hdr = ["source", "rows", "publish", "digest", "drop"]
    body = []
    for name, rows in ordered:
        pc = route_counts(rows, "plain")
        label = f"**{name}**" if "itison" in name.lower() else name
        body.append([label, len(rows), pc["publish"], pc["digest"], pc["drop"]])
    L += table(hdr, body) + [""]
    if ai_on:
        L += ["With AI:", ""]
        body = []
        for name, rows in ordered:
            ac = route_counts(rows, "ai")
            body.append([f"**{name}**" if "itison" in name.lower() else name, len(rows), ac["publish"], ac["digest"], ac["drop"]])
        L += table(hdr, body) + [""]

    # Publish list, set A.
    for which, title in (("plain", "without AI"),) + ((("ai", "with AI"),) if ai_on else ()):
        pub = sorted((r for r in a if r[f"{which}_route"] == "publish"), key=lambda r: -r[which].score)
        L += [f"## Set A routed publish, {title} ({len(pub)})", ""]
        L += table(["title", "venue", "label", "source", "score", "note"], [row_line(r, which) for r in pub]) + [""]

    for route in ("digest", "drop"):
        sample = spread([r for r in a if r["plain_route"] == route], 15)
        L += [f"## Set A sample of {len(sample)} routed {route}, spread across the score range (without AI)", ""]
        L += table(["title", "venue", "label", "source", "score", "reasons"], [reasons_line(r) for r in sample]) + [""]

    # Live deals routed drop, split by cause.
    for which, title in (("plain", "without AI"),) + ((("ai", "with AI"),) if ai_on else ()):
        drops = sorted((r for r in b if r[f"{which}_route"] == "drop"), key=lambda r: r[which].score)
        causes = Counter(drop_cause(r, which) for r in drops)
        L += [f"## Set B live deals routed drop, {title} ({len(drops)}). Report only, nothing changed", "",
              "By cause: " + ", ".join(f"{k} {v}" for k, v in sorted(causes.items())), ""]
        for cause in sorted(causes):
            rows = [r for r in drops if drop_cause(r, which) == cause]
            if which == "ai":  # the without-AI drops are listed above; here only the rows the rating added
                rows = [r for r in rows if r["plain_route"] != "drop"]
                if not rows:
                    continue
            L += [f"### {cause} ({len(rows)}{' added by the AI rating' if which == 'ai' else ''})", ""]
            L += table(["title", "venue", "label", "source", "score", "reasons"], [reasons_line(r, which) for r in rows]) + [""]
    L += [f"Set B note: live rows have no `extraction_status` and no `_evidence`, so `route_deal` can never publish them "
          f"(its publish test needs a validated status or gate evidence). Live rows scoring {quality.PUBLISH_AT}+: "
          f"{sum(1 for r in b if r['plain'].score >= quality.PUBLISH_AT)} of {len(b)}.", ""]

    L += limit_sections(a, ai_on)
    L += itison_price_section(a)

    L += ["## Spot checks", ""] + table(["wanted", "found in", "title", "venue", "label", "score", "route", "with AI", "reasons"], spot) + [""]
    return "\n".join(L)


def spot_rows(sets: dict[str, list[dict[str, Any]]], ai_on: bool) -> tuple[list[list[Any]], list[dict[str, Any]]]:
    out: list[list[Any]] = []
    tattoo: list[dict[str, Any]] = []
    for needle, extra, wanted in SPOT_CHECKS:
        found = False
        for set_name, rows in sets.items():
            for r in rows:
                text = f"{r['record'].get('title')} {r['record'].get('saving_label') or ''} {r['record'].get('venue_name') or ''}".lower()
                if needle.lower() in text and (not extra or extra.lower() in text):
                    found = True
                    rec = r["record"]
                    out.append([wanted, set_name, rec.get("title"), rec.get("venue_name"), rec.get("saving_label"), r["plain"].score,
                                r["plain_route"], f"{r['ai'].score} / {r['ai_route']}" if ai_on and r["rating"] else "-", "; ".join(r["plain"].reasons)])
                    if needle == "Tattoo Hospitality":
                        tattoo.append(r)
        if not found:
            title, label = {"Nobles of Bellfield": ("Nobles of Bellfield", "£4 cask pints"),
                            "Lioness of Leith": ("The Lioness of Leith", "£5 IPA with any burger"),
                            "film studio hire": ("FREAKWORXX", "20% off film studio hire"),
                            "spinal screening": ("Chiropractic Life", "Free spinal screening")}.get(needle, (wanted, None))
            rec = {"slug": "synthetic", "title": f"{title} {label}" if label else title, "saving_label": label, "venue_name": title,
                   "kind": "deal", "eligibility": "anyone", "extraction_status": "pending", "validation_errors": []}
            s = quality.score_deal(rec)
            out.append([wanted, "NOT in any set: synthetic record built from the title", rec["title"], title, label, s.score,
                        quality.route_deal(rec, s, source_class="web"), "-", "; ".join(s.reasons)])
    return out, tattoo


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--refresh-ai", action="store_true", help="call DeepSeek again instead of reusing ai-ratings.json")
    ap.add_argument("--rejected-dir", type=Path, default=DEFAULT_REJECTED_DIR)
    ap.add_argument("--old-report", type=Path, default=OLD_REPORT)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    waiting, live, notes = load_sets()
    rejected, c_note = load_rejected(args.rejected_dir, args.old_report)
    c_records = [rejected_as_record(e) for e in rejected]
    mode = "none" if args.no_ai else ("refresh" if args.refresh_ai else "cache")
    cache = args.out_dir / "ai-ratings.json"
    ratings, ai_info = get_ratings(waiting + live, mode, cache)
    if mode == "cache" and not ratings and not args.no_ai:  # no cache yet: make the one real run
        ratings, ai_info = get_ratings(waiting + live, "refresh", cache)

    a, b, c = score_all(waiting, ratings), score_all(live, ratings), score_all(c_records, {})
    for rows in (a, b):
        apply_limits(rows)
    spot, tattoo = spot_rows({"A": a, "B": b, "C": c}, bool(ratings))
    report = build_report(a, b, c, c_note, ai_info, notes, spot)
    verdicts = args.out_dir / "itison-verdicts.md"  # hand-written notes on the itison rejections, kept beside the report
    if verdicts.is_file():
        report += "\n" + verdicts.read_text()
    (args.out_dir / "report.md").write_text(report + "\n")
    (args.out_dir / "rows.json").write_text(json.dumps([
        {"set": name, "slug": r["record"]["slug"], "title": r["record"].get("title"), "source": r["record"].get("source_name"),
         "score": r["plain"].score, "route": r["plain_route"], "rating": r["rating"], "score_ai": r["ai"].score, "route_ai": r["ai_route"],
         "reasons": r["plain"].reasons}
        for name, rows in (("A", a), ("B", b), ("C", c)) for r in rows], ensure_ascii=False, indent=1) + "\n")
    print(f"[backtest] wrote {args.out_dir / 'report.md'}; AI: {ai_info['status']}; rated {ai_info['rated']}/{ai_info['asked']}; cost ${ai_info['cost_usd']:.4f}")


if __name__ == "__main__":
    main()
