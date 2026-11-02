#!/usr/bin/env python3
"""Score the waiting backlog in happenings_staging with the deal quality score.

  python3 scraper/score_backlog.py                 # dry run (default): read, score, print the table, write a report file
  python3 scraper/score_backlog.py --apply         # also write quality_score / quality_reasons / quality_route
  python3 scraper/score_backlog.py --no-ai         # skip the AI relevance rating
  python3 scraper/score_backlog.py --refresh-ai    # re-rate every row (off-peak DeepSeek only)
  python3 scraper/score_backlog.py --offline       # no page checks and no live-duplicate check (tests, or no network)

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

Before a row can reach the digest it is looked at (scraper/page_check.py), best score first, at most
page_check.BACKLOG_PAGE_CAP pages a run, one request per page, bot User-Agent, robots.txt obeyed, no retries:
  * HTTP 404/410, or a page whose explicit dates have all passed (a lapsed series): the row routes drop;
  * a block, timeout or other failure: it stays digest, marked "page check: unconfirmed";
  * not reached (over the cap): it stays digest but is marked "page check: not reached", and
    lib/review/digest.ts never emails a row whose reasons lack an ok or unconfirmed page check.
A row that matches a live happening by scraper/identity.py (a confident match) routes drop with
"already live as <slug>"; a merely possible match stays digest with a note. The page excerpt goes to the AI
rating, which is told that a row for a narrow group, or with an unstated condition, rates at most 2.
Page results are cached for the day in scraper/out/score-backlog/page-checks.json so --apply after a dry
run does not hit the sites again.

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
import page_check  # noqa: E402

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


# --- live duplicates ----------------------------------------------------------------------------


def find_live_duplicates(rows: list[dict[str, Any]], catalogue: Any) -> tuple[dict[str, str], dict[str, str]]:
    """(slug -> live slug for a confident match, slug -> live slug for a merely possible one), by scraper/identity.py
    against live happenings only. A confident match is a duplicate; a possible one is only worth a note."""
    sure: dict[str, str] = {}
    maybe: dict[str, str] = {}
    for r in rows:
        found = catalogue.best_match(r)
        if found is None or found.entry.table != "happenings" or found.entry.status != "live" or not found.entry.slug:
            continue
        (sure if found.verdict == "match" else maybe)[r["slug"]] = f"{found.entry.slug}"
    return sure, maybe


def apply_duplicates(routed: list[quality.RoutedDeal], sure: dict[str, str], maybe: dict[str, str]) -> list[quality.RoutedDeal]:
    out = []
    for item in routed:
        slug = item.record.get("slug")
        if item.route != "drop" and slug in sure:
            item = quality.RoutedDeal(item.record, quality.QualityResult(item.result.score, [*item.result.reasons, f"already live as {sure[slug]}"]), "drop")
        elif item.route != "drop" and slug in maybe:
            item = quality.RoutedDeal(item.record, quality.QualityResult(item.result.score, [*item.result.reasons, f"possible duplicate of live {maybe[slug]}"]), item.route)
        out.append(item)
    return out


# --- source page checks (cached for the day) -------------------------------------------------------


def load_page_cache(path: Path, today: date) -> dict[str, page_check.PageCheck]:
    """url -> PageCheck, from today's cache file only (a cache from another day is ignored)."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    if data.get("date") != today.isoformat():
        return {}
    return {u: page_check.PageCheck(v.get("status", "unconfirmed"), v.get("reason", ""), v.get("excerpt", ""))
            for u, v in (data.get("pages") or {}).items() if isinstance(v, dict)}


def save_page_cache(path: Path, today: date, cache: dict[str, page_check.PageCheck]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"date": today.isoformat(), "pages": {u: {"status": c.status, "reason": c.reason, "excerpt": c.excerpt} for u, c in cache.items()}},
                               indent=1) + "\n")


def check_pages(rows: list[dict[str, Any]], today: date, *, get: Callable[[str], Any], cache_path: Path, cap: int,
                reuse_markers: bool = True) -> tuple[dict[str, page_check.PageCheck], int, int]:
    """Page-check `rows` (already sorted best score first). Results seen earlier today (the cache file), or an `ok`
    marker in the row's own quality_reasons from the last 7 days, are reused without a request.
    Returns (slug -> PageCheck, pages requested, rows answered from an earlier check)."""
    cache = load_page_cache(cache_path, today)
    reused = 0

    def already(row: dict[str, Any]) -> page_check.PageCheck | None:
        nonlocal reused
        hit = cache.get(str(row.get("source_url") or ""))
        if hit is None and reuse_markers:
            hit = page_check.check_from_reasons(row.get("quality_reasons"), today)
        if hit is not None:
            reused += 1
        return hit

    checks, requested = page_check.check_rows(rows, get, today, cap=cap, already=already)
    for row in rows:
        c = checks.get(str(row.get("slug") or ""))
        url = str(row.get("source_url") or "")
        if c is not None and url and c.reason != "(reused)":
            cache.setdefault(url, c)
    save_page_cache(cache_path, today, cache)
    return checks, requested, reused


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


def build_report(routed: list[quality.RoutedDeal], notes: dict[str, int], info: deal_routing.RatingInfo, *, applied: int | None,
                 pages: dict[str, Any] | None = None) -> str:
    counts = Counter(r.route for r in routed)
    lines = [f"# Backlog quality scores, {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC}", "",
             f"Mode: {'APPLIED, wrote the quality columns only' if applied is not None else 'DRY RUN, nothing written'}. "
             "Never approves, never promotes.", "",
             f"- Waiting rows: {len(routed)} ({notes['staged_raw']} unpromoted unapproved staged rows, {notes['after_dedupe']} after de-duplicating by slug, "
             f"{notes['excluded_already_live']} excluded as already live; {notes['approved_null']} have approved = null).",
             f"- AI rating: {info.status}. Rows asked {info.asked}, rated {info.rated}. Tokens {info.input_tokens} in / {info.output_tokens} out, cost ${info.cost_usd:.4f}.",
             f"- Routes: digest {counts['digest']}, drop {counts['drop']} (publish is not available to a backlog row)."]
    if pages is not None:
        marks = Counter(next((x.split(" (")[0].replace(page_check.MARKER_PREFIX, "") for x in r.result.reasons if x.startswith(page_check.MARKER_PREFIX)), "none") for r in routed if r.route != "drop")
        lines.append(f"- Source pages: {pages['requested']} requested this run (cap {pages['cap']}, best score first), {pages['cached']} reused from today's cache. "
                     + "Rows still routed digest: " + ", ".join(f"{k} {n}" for k, n in sorted(marks.items())) + ". "
                     "A row \"not reached\" is kept but never emailed until it is checked.")
        lines.append(f"- Live duplicates: {pages['dup_sure']} dropped as already live, {pages['dup_maybe']} possible (kept, noted); live catalogue {pages['catalogue']}.")
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
            why = next((x for x in r.result.reasons if x.startswith(("expired", "outside Edinburgh", "already live", page_check.MARKER_PREFIX))),
                       f"score under {quality.DROP_BELOW}")
            drops[(why.split(":")[0] if not why.startswith("already live") else "already live")] += 1
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


def load_live_catalogue(url: str, key: str) -> Any:
    """Live happenings as an identity.Catalogue (no events: only a live row counts as 'already live')."""
    from identity import Catalogue  # noqa: PLC0415
    from weekly_edinburgh import _rest_all  # noqa: PLC0415

    live = _rest_all(url, key, "happenings", {
        "status": "eq.live",
        "select": "id,slug,title,kind,status,starts_at,recurrence,venue_name,place_id,saving_label,source_url",
    })
    return Catalogue(live, []), len(live)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write quality_score / quality_reasons / quality_route (nothing else)")
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--refresh-ai", action="store_true")
    ap.add_argument("--offline", action="store_true", help="no page checks and no live-duplicate check")
    ap.add_argument("--page-cap", type=int, default=page_check.BACKLOG_PAGE_CAP, help="most pages to request (default %(default)s)")
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = ap.parse_args()
    if args.no_ai and args.refresh_ai:
        ap.error("--no-ai and --refresh-ai contradict each other")

    waiting, notes, (url, key) = load_waiting()
    today = datetime.now(quality.LONDON).date()
    now = datetime.now(timezone.utc)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Live duplicates, then a first score with no rating, to know which rows are worth a page request.
    sure: dict[str, str] = {}
    maybe: dict[str, str] = {}
    catalogue_note = "not checked (--offline)"
    if not args.offline:
        try:
            catalogue, n_live = load_live_catalogue(url, key)
            sure, maybe = find_live_duplicates(waiting, catalogue)
            catalogue_note = f"{n_live} live rows"
        except Exception as exc:  # noqa: BLE001 - reported, never fatal
            catalogue_note = f"UNAVAILABLE ({exc.__class__.__name__}); duplicates not checked"
    prelim = apply_duplicates(score_rows(waiting, {}, today=today, now=now), sure, maybe)
    candidates = sorted((p for p in prelim if p.route != "drop"), key=lambda p: -p.result.score)

    # 2. Look at the source pages of the rows that could reach the digest, best score first.
    checks: dict[str, page_check.PageCheck] = {}
    requested = 0
    cached = 0
    if not args.offline:
        checks, requested, cached = check_pages([p.record for p in candidates], today, get=page_check.make_fetcher(),
                                        cache_path=args.out_dir / "page-checks.json", cap=args.page_cap,
                                        reuse_markers=not args.refresh_ai)

    # 3. Rate the rows that are still in play, with the excerpt of the page where we have one.
    def make_call() -> Callable[[str], quality.RatingResult]:
        import llm_client  # noqa: PLC0415
        if llm_client.research_provider() == "none":
            raise RuntimeError("no LLM API key set (DEEPSEEK_API_KEY)")
        client, _ = llm_client.make_research_client("score-backlog")  # raises DeepSeekPeakHours in peak
        return quality.make_rating_call(client, llm_client.default_research_model())

    in_play = [dict(p.record, page_excerpt=checks[p.record["slug"]].excerpt) if p.record["slug"] in checks and checks[p.record["slug"]].status == "ok"
               else p.record for p in candidates if checks.get(p.record["slug"], page_check.PageCheck("ok")).status not in ("gone", "lapsed")]
    mode = "none" if args.no_ai else ("refresh" if args.refresh_ai else "cache")
    ratings, info = get_ratings(in_play, mode, args.out_dir / "ai-ratings.json", make_call)

    # 4. The final score and route, then the page and duplicate verdicts on top.
    routed = score_rows(waiting, ratings, today=today, now=now)
    routed = apply_duplicates(routed, sure, maybe)
    if not args.offline:
        routed = page_check.apply_checks(routed, checks, today)

    applied: int | None = None
    if args.apply:
        try:
            applied = apply_rows(routed, make_patch(url, key))
        except ColumnsMissing as exc:
            sys.exit(f"[score-backlog] {exc}")
    pages = None if args.offline else {"requested": requested, "cap": args.page_cap, "cached": cached, "dup_sure": len(sure), "dup_maybe": len(maybe),
                                       "catalogue": catalogue_note}
    report = build_report(routed, notes, info, applied=applied, pages=pages)
    (args.out_dir / "report.md").write_text(report + "\n")
    (args.out_dir / "rows.json").write_text(json.dumps([
        {"id": r.record.get("id"), "slug": r.record["slug"], "title": r.record.get("title"), "source": r.record.get("source_name"),
         "kind": r.record.get("kind"), "score": r.result.score, "route": r.route, "reasons": r.result.reasons} for r in routed],
        ensure_ascii=False, indent=1) + "\n")
    print(report)
    print(f"\n[score-backlog] {'APPLIED' if applied is not None else 'dry run'}: {len(routed)} rows; report at {args.out_dir / 'report.md'}")


if __name__ == "__main__":
    main()
