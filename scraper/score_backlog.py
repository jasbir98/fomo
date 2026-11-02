#!/usr/bin/env python3
"""Score the waiting backlog in happenings_staging with the deal quality score.

  python3 scraper/score_backlog.py                 # dry run (default): read, score, print the table, write a report file
  python3 scraper/score_backlog.py --apply         # also write quality_score / quality_reasons / quality_route
  python3 scraper/score_backlog.py --no-ai         # skip the AI relevance rating
  python3 scraper/score_backlog.py --refresh-ai    # re-rate every row (off-peak DeepSeek only)

Which rows: the same selection as the backtest's set A, but every kind (backtest_quality.py takes
deals only): happenings_staging rows that are not approved (false or null), not promoted, with no
happening_id, de-duplicated by slug (the latest created_at wins), minus slugs that are already live.
Older duplicates of a slug are left unscored.

What it writes, with --apply: the three quality columns on those staged rows, one PATCH per row, and
nothing else. It never sets approved, never changes extraction_status and never promotes. The columns
come from supabase/add_deal_quality.sql, run by hand; if they are missing the first PATCH fails and
the script stops with that message.

Backlog routes. A stored row has lost the in-memory `_evidence` a live run carries, so a backlog row
can never route "publish": a publish route becomes "digest" with a reason, because publishing needs a
fresh check inside a run. Backtest assumption, labelled in the reasons: a row whose validation_errors
are exactly ["commercial_source_review"] came out of a deal source and passed its quote gate, so it
gets the evidence bonus it would have had in the run.

The AI rating is one forced-tool call per 25 rows through llm_client.make_research_client, which
refuses to run in DeepSeek's peak hours (the rows are then scored without it). Ratings are cached in
scraper/out/score-backlog/ai-ratings.json, and the backtest's cache is read as a fallback.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from deal_sources import quality  # noqa: E402
import deal_routing  # noqa: E402

SCRAPER_DIR = Path(__file__).resolve().parent
OUT_DIR = SCRAPER_DIR / "out" / "score-backlog"
BACKTEST_CACHE = SCRAPER_DIR / "out" / "backtest-2026-11-02" / "ai-ratings.json"
IN_RATE, OUT_RATE = 0.28, 0.42
RATING_BUDGET_USD = 0.10
GATE_ASSUMED = ["commercial_source_review"]
BANDS = [f"{lo}-{lo + 9}" for lo in range(0, 90, 10)] + ["90-100"]


# --- selection ---------------------------------------------------------------------------------


def select_waiting(staged: list[dict[str, Any]], live_slugs: set[str]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Latest row per slug (by created_at, then batch_id), minus slugs already live."""
    latest: dict[str, dict[str, Any]] = {}
    for row in sorted(staged, key=lambda r: (r.get("created_at") or "", r.get("batch_id") or "")):
        latest[row["slug"]] = row
    waiting = [r for r in latest.values() if r["slug"] not in live_slugs]
    return waiting, {
        "staged_raw": len(staged),
        "after_dedupe": len(latest),
        "excluded_already_live": len(latest) - len(waiting),
        "approved_null": sum(1 for r in waiting if r.get("approved") is None),
    }


# --- scoring -----------------------------------------------------------------------------------


def route_row(row: dict[str, Any], rating: int | None, *, today: date | None, now: datetime | None) -> quality.RoutedDeal:
    """Score and route one stored row. Never returns publish (see the module docstring)."""
    record = dict(row)
    assumed = record.get("validation_errors") == GATE_ASSUMED
    if assumed:
        record["_evidence"] = {"deal_quote": "(backlog: gate assumed from commercial_source_review)"}
    result = quality.score_deal(record, ai_rating=rating, now=now)
    if assumed:
        result.reasons.append("evidence assumed: passed the deal-source quote gate (stored row has no _evidence)")
    route = quality.route_deal(record, result, source_class=quality.source_class(record), today=today)
    if route == "publish":
        route = "digest"
        result.reasons.append("backlog row: publishing needs a fresh check inside a run, so it goes to the digest")
    return quality.RoutedDeal(row, result, route)


def score_rows(rows: list[dict[str, Any]], ratings: dict[str, int], *, today: date | None = None,
               now: datetime | None = None) -> list[quality.RoutedDeal]:
    return [route_row(r, ratings.get(r["slug"]), today=today, now=now) for r in rows]


# --- AI ratings (cached) -----------------------------------------------------------------------


def load_cache(*paths: Path) -> dict[str, int]:
    ratings: dict[str, int] = {}
    for path in paths:
        if path.is_file():
            try:
                ratings.update({s: v for s, v in json.loads(path.read_text()).get("ratings", {}).items() if isinstance(v, int)})
            except (ValueError, OSError):
                pass
    return ratings


def get_ratings(rows: list[dict[str, Any]], mode: str, cache_path: Path,
                make_call: Callable[[], Callable[[str], quality.RatingResult]]) -> tuple[dict[str, int], deal_routing.RatingInfo]:
    """mode: 'none' (no AI), 'cache' (cached ratings, rate only rows missing from it) or 'refresh' (rate all)."""
    if mode == "none":
        info = deal_routing.RatingInfo(status="skipped (--no-ai)", asked=len(rows))
        return {}, info
    cached = {} if mode == "refresh" else load_cache(BACKTEST_CACHE, cache_path)
    wanted = {r["slug"] for r in rows}
    ratings = {s: v for s, v in cached.items() if s in wanted}
    todo = [r for r in rows if r["slug"] not in ratings]
    from_cache = len(ratings)
    info = deal_routing.RatingInfo(status=f"{from_cache} cached", asked=len(rows), rated=from_cache)
    if todo:
        new, ran = deal_routing.rate_records(todo, make_call, in_rate=IN_RATE, out_rate=OUT_RATE, budget_usd=RATING_BUDGET_USD)
        ratings.update(new)
        info = deal_routing.RatingInfo(status=f"{from_cache} cached, {ran.status} for {len(todo)} more", asked=len(rows),
                                       rated=len(ratings), input_tokens=ran.input_tokens, output_tokens=ran.output_tokens,
                                       cost_usd=ran.cost_usd, errors=ran.errors)
        if new:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            merged = load_cache(cache_path)
            merged.update(new)
            cache_path.write_text(json.dumps({"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "ratings": merged}, indent=2) + "\n")
    return ratings, info


# --- report ------------------------------------------------------------------------------------


def _cell(value: Any) -> str:
    return str(value if value not in (None, "") else "-").replace("|", "/").replace("\n", " ")


def _table(headers: list[str], rows: list[list[Any]]) -> list[str]:
    return ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)] + ["| " + " | ".join(_cell(c) for c in r) + " |" for r in rows]


def build_report(routed: list[quality.RoutedDeal], notes: dict[str, int], info: deal_routing.RatingInfo, *, applied: int | None) -> str:
    counts = Counter(r.route for r in routed)
    lines = [f"# Backlog quality scores, {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}", "",
             f"Mode: {'APPLIED, wrote the quality columns only' if applied is not None else 'DRY RUN, nothing written'}. "
             "Never approves, never promotes.", "",
             f"- Waiting rows: {len(routed)} ({notes['staged_raw']} unpromoted unapproved staged rows, {notes['after_dedupe']} after de-duplicating by slug, "
             f"{notes['excluded_already_live']} excluded as already live; {notes['approved_null']} have approved = null).",
             f"- AI rating: {info.status}. Rows asked {info.asked}, rated {info.rated}. Tokens {info.input_tokens} in / {info.output_tokens} out, cost ${info.cost_usd:.4f}.",
             f"- Routes: digest {counts['digest']}, drop {counts['drop']} (publish is not available to a backlog row)."]
    if applied is not None:
        lines.append(f"- Rows written: {applied}.")
    lines += ["", "## Score bands", ""]
    bands: Counter = Counter(BANDS[min(r.result.score // 10, 9)] for r in routed)
    lines += _table(BANDS, [[bands[b] for b in BANDS]]) + [""]

    per: dict[str, Counter] = defaultdict(Counter)
    for r in routed:
        per[str(r.record.get("source_name") or "(none)")][r.route] += 1
    lines += ["## Per source", ""]
    lines += _table(["source", "rows", "digest", "drop"],
                    [[n, sum(c.values()), c["digest"], c["drop"]] for n, c in sorted(per.items(), key=lambda kv: (-sum(kv[1].values()), kv[0]))]) + [""]

    kinds: dict[str, Counter] = defaultdict(Counter)
    for r in routed:
        kinds[str(r.record.get("kind") or "(none)")][r.route] += 1
    lines += ["## Per kind", ""]
    lines += _table(["kind", "rows", "digest", "drop"], [[k, sum(c.values()), c["digest"], c["drop"]] for k, c in sorted(kinds.items())]) + [""]

    drops = Counter()
    for r in routed:
        if r.route == "drop":
            why = next((x for x in r.result.reasons if x.startswith(("expired", "outside Edinburgh"))), f"score under {quality.DROP_BELOW}")
            drops[why.split(":")[0]] += 1
    lines += ["## Why rows drop", ""] + _table(["cause", "rows"], sorted(drops.items())) + [""]

    for route in ("digest", "drop"):
        rows = sorted((r for r in routed if r.route == route), key=lambda r: -r.result.score)
        lines += [f"## Routed {route} ({len(rows)}), best score first", ""]
        lines += _table(["score", "title", "venue", "label", "kind", "source", "reasons"],
                        [[r.result.score, r.record.get("title"), r.record.get("venue_name"), r.record.get("saving_label"), r.record.get("kind"),
                          r.record.get("source_name"), "; ".join(x for x in r.result.reasons if not x.startswith(("base", "local")))[:160]] for r in rows]) + [""]
    return "\n".join(lines)


# --- writing -----------------------------------------------------------------------------------


class ColumnsMissing(RuntimeError):
    pass


def apply_rows(routed: list[quality.RoutedDeal], patch: Callable[[str, dict[str, Any]], None]) -> int:
    """PATCH the three quality columns of each row, by id, and nothing else. `patch(row_id, body)`."""
    written = 0
    for item in routed:
        row_id = item.record.get("id")
        if not row_id:
            continue
        patch(str(row_id), {"quality_score": item.result.score, "quality_reasons": list(item.result.reasons), "quality_route": item.route})
        written += 1
    return written


def make_patch(url: str, key: str) -> Callable[[str, dict[str, Any]], None]:
    import requests

    def patch(row_id: str, body: dict[str, Any]) -> None:
        # Only a waiting row: not approved, not promoted, never linked to a live happening.
        resp = requests.patch(
            f"{url}/rest/v1/happenings_staging",
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=minimal"},
            params={"id": f"eq.{row_id}", "extraction_status": "neq.promoted", "happening_id": "is.null"},
            json=body, timeout=30,
        )
        if resp.status_code >= 300:
            text = resp.text or ""
            if "quality_" in text and ("PGRST204" in text or "42703" in text or "could not find" in text.lower()):
                raise ColumnsMissing("the quality_* columns are not in happenings_staging: run supabase/add_deal_quality.sql, then retry")
            resp.raise_for_status()

    return patch


# --- main --------------------------------------------------------------------------------------


def load_waiting() -> tuple[list[dict[str, Any]], dict[str, int], tuple[str, str]]:
    from weekly_edinburgh import _rest_all, supabase_connection  # noqa: PLC0415 (loads the env files)

    connection = supabase_connection()
    if not connection:
        sys.exit("[score-backlog] no Supabase credentials in the environment")
    url, key = connection
    live = _rest_all(url, key, "happenings", {"select": "slug", "status": "eq.live"})
    staged = _rest_all(url, key, "happenings_staging", {
        "select": "*", "happening_id": "is.null", "extraction_status": "neq.promoted",
        "or": "(approved.eq.false,approved.is.null)",
    })
    waiting, notes = select_waiting(staged, {r["slug"] for r in live})
    return waiting, notes, connection


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write quality_score / quality_reasons / quality_route (nothing else)")
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--refresh-ai", action="store_true")
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = ap.parse_args()
    if args.no_ai and args.refresh_ai:
        ap.error("--no-ai and --refresh-ai contradict each other")

    waiting, notes, (url, key) = load_waiting()

    def make_call() -> Callable[[str], quality.RatingResult]:
        import llm_client  # noqa: PLC0415
        if llm_client.research_provider() == "none":
            raise RuntimeError("no LLM API key set (DEEPSEEK_API_KEY)")
        client, _ = llm_client.make_research_client("score-backlog")  # raises DeepSeekPeakHours in peak
        return quality.make_rating_call(client, llm_client.default_research_model())

    args.out_dir.mkdir(parents=True, exist_ok=True)
    mode = "none" if args.no_ai else ("refresh" if args.refresh_ai else "cache")
    ratings, info = get_ratings(waiting, mode, args.out_dir / "ai-ratings.json", make_call)
    routed = score_rows(waiting, ratings, today=datetime.now(quality.LONDON).date(), now=datetime.now(timezone.utc))

    applied: int | None = None
    if args.apply:
        try:
            applied = apply_rows(routed, make_patch(url, key))
        except ColumnsMissing as exc:
            sys.exit(f"[score-backlog] {exc}")
    report = build_report(routed, notes, info, applied=applied)
    (args.out_dir / "report.md").write_text(report + "\n")
    (args.out_dir / "rows.json").write_text(json.dumps([
        {"id": r.record.get("id"), "slug": r.record["slug"], "title": r.record.get("title"), "source": r.record.get("source_name"),
         "kind": r.record.get("kind"), "score": r.result.score, "route": r.route, "reasons": r.result.reasons} for r in routed],
        ensure_ascii=False, indent=1) + "\n")
    print(report)
    print(f"\n[score-backlog] {'APPLIED' if applied is not None else 'dry run'}: {len(routed)} rows; report at {args.out_dir / 'report.md'}")


if __name__ == "__main__":
    main()
