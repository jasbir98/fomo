"""Score, route and (only when asked) auto-publish a run's final records.

Called from weekly_edinburgh.py after a run's records are final. Everything that touches the
outside world (the DeepSeek rating call, the page re-check, the database, the promote script) is
injected, so the tests use fakes and nothing here writes by default.

Steps, in order:
  0. page check     one request to each non-dropped row's source page, best score first, at most
                    page_check.RUN_PAGE_CAP a run (scraper/page_check.py): a 404/410 or a lapsed series
                    drops the row; a block or timeout leaves it in the digest marked unconfirmed. The
                    marker goes into quality_reasons, which is how the digest knows a row was looked at.
                    The page excerpt also goes to the rating.
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

import page_check
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
    already_non_deal: int = 0  # of those, non-deals
    cooldown: int = 0  # moved to digest: the venue got an auto-published deal in the last COOLDOWN_DAYS
    blocked: int = 0  # moved to digest: the day's limit was used up, or the limit history could not be read
    history_error: str | None = None


COOLDOWN_DAYS = 7  # a venue with an auto-published deal this recently routes to digest


@dataclass
class PublishHistory:
    """Rows this pipeline published recently, for the limits that hold across runs."""
    published_today: int = 0
    recent: list[dict[str, Any]] = field(default_factory=list)  # published within COOLDOWN_DAYS: venue_name, place_id, title, kind, created_at
    published_today_non_deal: int = 0  # of published_today, how many were not deals (the day's cap is quality.NON_DEAL_DAILY_LIMIT)


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
            "created_at": f"gte.{cutoff}", "select": "slug,title,kind,venue_name,place_id,created_at,source_name",
        })
    except Exception as exc:  # noqa: BLE001 - a failed read is a reported state, never a crash
        return None, f"{exc.__class__.__name__}: {str(exc)[:200]}"
    london_today = now.astimezone(quality.LONDON).date()
    today = 0
    non_deal = 0
    for row in rows:
        stamp = quality._parse_timestamp(row.get("created_at"))
        if stamp is not None and stamp.astimezone(quality.LONDON).date() == london_today:
            today += 1
            if quality.is_non_deal(row):
                non_deal += 1
    return PublishHistory(today, list(rows), non_deal), None


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
        stats.already_non_deal = history.published_today_non_deal
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
        limited = quality.apply_daily_limit(current, remaining, already_today=stats.already_today,
                                            already_non_deal=stats.already_non_deal)
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


# --- waiting rows that may fill the day's remaining slots ----------------------------------------

BACKLOG_MAX_CANDIDATES = 40  # waiting rows looked at per run, best stored score first (each costs a page re-check)
BACKLOG_BLOCKING_MARKERS = ("page check: unconfirmed", "page check: gone", "page check: lapsed")
BACKLOG_DONE_STATUSES = ("promoted", "approved", "rejected")


def backlog_blocked_by(row: dict[str, Any]) -> str | None:
    """Why a waiting row may not be tried for publishing, or None. Rows score_backlog.py marked unconfirmed, gone or
    lapsed never are; neither is one a person decided, one already live, or one on social media or a newsletter."""
    if row.get("approved") is True or row.get("happening_id") or row.get("reviewed_at") or row.get("reviewed_action"):
        return "already decided"
    if str(row.get("extraction_status") or "") in BACKLOG_DONE_STATUSES:
        return f"status {row.get('extraction_status')}"
    reasons = [str(r) for r in (row.get("quality_reasons") or []) if isinstance(r, str)]
    marker = next((m for m in BACKLOG_BLOCKING_MARKERS if any(r.startswith(m) for r in reasons)), None)
    if marker:
        return marker
    if quality.source_class(row) not in quality.PUBLISH_SOURCE_CLASSES:
        return "social or newsletter source"
    return None


def load_backlog(
    get_all: Callable[[str, dict[str, str]], list[dict[str, Any]]],
    *,
    batch_id: str,
    run_slugs: set[str],
    catalogue: Any = None,
    limit: int = BACKLOG_MAX_CANDIDATES,
) -> tuple[list[dict[str, Any]], str | None]:
    """(waiting staged rows that score_backlog.py routed publish and nobody has decided, None), or ([], why) when they
    cannot be read. Read-only; never raises. Fail safe: any read failure means no backlog, so nothing extra publishes.
    Left out: rows of this batch or this run's slugs, slugs already live, a confident identity match to a live row,
    and the rows backlog_blocked_by refuses. One row per slug (the newest); best stored score first, at most `limit`."""
    try:
        live = get_all("happenings", {"select": "slug", "status": "eq.live"})
        rows = get_all("happenings_staging", {
            "select": "*", "quality_route": "eq.publish", "happening_id": "is.null",
            "or": "(approved.eq.false,approved.is.null)",
        })
    except Exception as exc:  # noqa: BLE001 - a failed read is a reported state, never a crash
        return [], f"waiting rows could not be read ({exc.__class__.__name__}: {str(exc)[:160]}); nothing extra publishes"
    live_slugs = {str(r.get("slug")) for r in live if r.get("slug")}
    newest: dict[str, dict[str, Any]] = {}
    for row in sorted(rows, key=lambda r: (str(r.get("created_at") or ""), str(r.get("batch_id") or ""))):
        newest[str(row.get("slug"))] = row
    out: list[dict[str, Any]] = []
    for slug, row in newest.items():
        if not slug or slug in live_slugs or slug in run_slugs or row.get("batch_id") == batch_id or backlog_blocked_by(row):
            continue
        if catalogue is not None:
            found = catalogue.best_match(row)
            if found is not None and found.verdict == "match" and found.entry.table == "happenings" and found.entry.status == "live":
                continue
        out.append(row)
    out.sort(key=lambda r: -(r.get("quality_score") if isinstance(r.get("quality_score"), int) else -1))
    return out[:limit], None


def route_backlog(rows: list[dict[str, Any]], *, today: date | None = None, now: datetime | None = None) -> list[RoutedDeal]:
    """Route stored rows as candidates to publish. The score is the stored one (score_backlog.py wrote it with the rating
    and the caps). A stored row has lost its in-memory `_evidence`, so the gate is replaced by the fresh verify_record in
    finalize(): `_evidence` is set to a placeholder here so route_deal can say publish, and nothing publishes unless that
    fresh check passes. Everything else in route_deal still applies: expired, outside Edinburgh, blocking validation
    errors (commercial_source_review is allowed), annual out of season, a weekly row whose text says another pattern."""
    out: list[RoutedDeal] = []
    for row in rows:
        record = dict(row)
        record["_backlog"] = True
        record["_evidence"] = {"deal_quote": "(backlog: relies on the fresh source-page check)"}
        score = record.get("quality_score")
        result = QualityResult(score if isinstance(score, int) else 0, [str(r) for r in (record.get("quality_reasons") or []) if isinstance(r, str)])
        route = quality.route_deal(record, result, source_class=quality.source_class(record), today=today)
        out.append(RoutedDeal(record, result, route))
    return out


def backlog_failures(outcome: "RoutingOutcome") -> list[tuple[dict[str, Any], str]]:
    """Waiting rows that failed the fresh check this run, with the reason text: they stay waiting and keep the reason."""
    out = []
    for item in outcome.backlog:
        reason = next((r for r in item.result.reasons if r.startswith(PUBLISH_FRESH_REASON)), None)
        if reason and item.route != "publish":
            out.append((item.record, reason))
    return out


def record_backlog_failures(
    outcome: "RoutingOutcome",
    patch: Callable[[str, dict[str, Any]], None] | None = None,
    log: Callable[[str], None] = print,
) -> int:
    """Auto-publish only: write each failed waiting row back as routed digest with the reason added to its reasons, so it stays
    waiting (and the weekly email can show it) instead of being retried against a dead page every day. Writes the three
    quality columns of that row and nothing else. Returns how many were written; a failed write is logged, never raised."""
    patch = patch or patch_quality_columns
    written = 0
    for record, reason in backlog_failures(outcome):
        row_id = record.get("id")
        if not row_id:
            continue
        reasons = [r for r in (record.get("quality_reasons") or []) if isinstance(r, str) and not r.startswith(PUBLISH_FRESH_REASON)]
        body = {"quality_score": record.get("quality_score"), "quality_reasons": [*reasons, reason[:400]], "quality_route": "digest"}
        try:
            patch(str(row_id), body)
            written += 1
        except Exception as exc:  # noqa: BLE001
            log(f"[routing] could not record a failed re-check for {record.get('slug')}: {exc.__class__.__name__}")
    return written


def patch_quality_columns(row_id: str, body: dict[str, Any]) -> None:
    """PATCH the quality columns of one waiting staged row (never one that is approved, promoted or linked)."""
    import requests  # lazy: tests inject a fake

    from weekly_edinburgh import supabase_connection  # lazy: importing it loads the env files

    connection = supabase_connection()
    if not connection:
        raise RuntimeError("Supabase credentials are unavailable")
    url, key = connection
    allowed = {k: v for k, v in body.items() if k in ("quality_score", "quality_reasons", "quality_route")}
    resp = requests.patch(
        f"{url}/rest/v1/happenings_staging",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=minimal"},
        params={"id": f"eq.{row_id}", "extraction_status": "neq.promoted", "happening_id": "is.null", "approved": "not.eq.true"},
        json=allowed, timeout=30,
    )
    resp.raise_for_status()


# --- the whole routing step ---------------------------------------------------------------------


@dataclass
class RoutingOutcome:
    final: list[RoutedDeal]
    fresh_ok: set[str]
    fresh: FreshStats
    rating: RatingInfo
    evidence: dict[str, tuple[int, int]]
    publishable: list[RoutedDeal]  # routed publish AND freshly verified AND a web source (what auto-publish would touch)
    pages: dict[str, page_check.PageCheck] = field(default_factory=dict)  # slug -> source page check (empty when not run)
    pages_requested: int = 0
    backlog: list[RoutedDeal] = field(default_factory=list)  # waiting rows considered for the day's remaining slots (final routes)
    backlog_note: str | None = None  # why the backlog was not read or not used, when it was not


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
    page_get: Callable[[str], Any] | None = None,
    page_cap: int = page_check.RUN_PAGE_CAP,
    backlog_rows: list[dict[str, Any]] | None = None,
    backlog_note: str | None = None,
    log: Callable[[str], None] = print,
) -> RoutingOutcome:
    """Rate, score, route, limit and fresh-check `records`, and stamp the quality_* fields onto them.
    Does not write anywhere and does not publish.

    `history` is what load_publish_history found (rows published today and in the cooldown window); None
    with `history_error` means it could not be read. With `fail_safe` (auto-publish is on) an unreadable
    history sends every would-be publish to digest and logs it. Without it (shadow mode) the cross-run
    limits are skipped and the report says so."""
    local_today = today or datetime.now(quality.LONDON).date()
    checks: dict[str, page_check.PageCheck] = {}
    pages_requested = 0
    if page_get is not None:
        # Looked at before rating, so the rating can read the page. Best score (without the rating) first.
        prelim = [r for r in route_records(records, {}, today=today, now=now) if r.route != "drop"]
        prelim.sort(key=lambda r: -r.result.score)
        checks, pages_requested = page_check.check_rows([r.record for r in prelim], page_get, local_today, cap=page_cap)
        by_status = Counter(c.status for c in checks.values())
        log(f"[routing] page check: {pages_requested} page(s) requested (cap {page_cap}): "
            + ", ".join(f"{n} {k}" for k, n in sorted(by_status.items())) + f"; {len(prelim) - len(checks)} not reached")
    rated_records = [{**r, "page_excerpt": checks[str(r.get("slug"))].excerpt} if str(r.get("slug")) in checks else r for r in records]
    ratings, rating = rate_records(rated_records, make_rating_call, in_rate=in_rate, out_rate=out_rate,
                                   budget_usd=rating_budget_usd, log=log)
    routed = route_records(records, ratings, today=today, now=now)
    if page_get is not None:
        routed = page_check.apply_checks(routed, checks, local_today)
    block_reason = None
    if history is None and fail_safe:
        block_reason = f"auto-publish limits could not be read ({history_error or 'unknown'}): publishing nothing"
        log(f"[routing] {block_reason}")
    # Waiting rows go after this run's own rows, in the same limits and with the same fresh check.
    back_routed = route_backlog(backlog_rows or [], today=local_today, now=now)
    everything, fresh_ok, fresh = finalize(routed + back_routed, verify, history=history, block_reason=block_reason)
    final = everything[:len(routed)]
    back_final = everything[len(routed):]
    fresh.history_error = history_error if history is None else None
    apply_to_records(final)
    outcome = RoutingOutcome(final, fresh_ok, fresh, rating, evidence_by_source(records), select_publishable(final, fresh_ok),
                             checks, pages_requested, back_final, backlog_note)
    counts = Counter(r.route for r in final)
    log(f"[routing] {len(final)} record(s): publish {counts['publish']}, digest {counts['digest']}, drop {counts['drop']}; "
        f"fresh checks {fresh.checked} ({fresh.failed} failed)")
    if back_final:
        back_counts = Counter(r.route for r in back_final)
        log(f"[routing] waiting backlog: {len(back_final)} candidate(s), {back_counts['publish']} still publish after the limits and the fresh check")
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
    # This run's rows first, then the waiting rows, each group approved and promoted under its own batch id.
    chosen = select_publishable(outcome.final, outcome.fresh_ok) + select_publishable(outcome.backlog, outcome.fresh_ok)
    groups: dict[str, list[str]] = {}
    for r in chosen:
        groups.setdefault(str(r.record.get("batch_id") or batch_id), []).append(str(r.record["slug"]))
    wanted = [slug for slugs in groups.values() for slug in slugs]
    if not enabled:
        if wanted:
            log(f"[routing] auto-publish is OFF: {len(wanted)} row(s) would publish; nothing approved or promoted")
        return result
    if not wanted:
        log("[routing] auto-publish is ON: no row qualifies")
        return result
    for group_batch, slugs in groups.items():
        approved, error = approve(group_batch, slugs)
        if error:
            result.notes.append(f"auto-publish: could not approve rows of {group_batch}: {error}")
            log(f"[routing] {result.notes[-1]}")
            continue
        really = [s for s in approved if s in slugs]  # never promote a slug we did not ask for
        if not really:
            result.notes.append(f"auto-publish: no staged row of {group_batch} was approved (not found in happenings_staging)")
            continue
        result.approved.extend(really)
        failure = promote(group_batch, really)
        if failure:
            result.notes.append(f"auto-publish: approved {len(really)} row(s) of {group_batch} but promotion failed: {failure}")
            log(f"[routing] {result.notes[-1]}")
            continue
        result.promoted = True
    if result.promoted:
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
    if outcome.pages_requested or outcome.pages:
        by = Counter(c.status for c in outcome.pages.values())
        lines.append(f"- Source page check (digest and publish candidates, best score first, at most {page_check.RUN_PAGE_CAP} pages a run): "
                     f"{outcome.pages_requested} requested; ok {by['ok']}, gone {by['gone']} (dropped), lapsed {by['lapsed']} (dropped), "
                     f"unconfirmed {by['unconfirmed']} (kept, marked); rows over the cap are not shown in the digest until checked.")
    back = outcome.backlog
    if outcome.backlog_note:
        lines.append(f"- **Waiting rows not used:** {outcome.backlog_note}.")
    elif back is not None:
        back_pub = [r for r in back if r.route == "publish"]
        lines.append(f"- Waiting rows (routed publish by score_backlog.py) tried for the day's remaining slots after this run's own rows: "
                     f"{len(back)} considered, {len(back_pub)} {publish_word if not auto_publish_on else 'publish'}, "
                     f"{len(backlog_failures(outcome))} failed the fresh check (they stay waiting with the reason).")
    lines.append(f"- Limits: {quality.DAILY_PUBLISH_LIMIT} a day across runs (London date), {quality.VENUE_PUBLISH_LIMIT} per venue per run, "
                 f"{quality.SOURCE_PUBLISH_LIMIT} per source per run, at most {quality.NON_DEAL_DAILY_LIMIT} of the day's non-deals (events, activities and the like), "
                 f"and a venue with an auto-published deal in the last {COOLDOWN_DAYS} days goes to digest.")
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

    back_ok = select_publishable(outcome.backlog, outcome.fresh_ok)
    if outcome.publishable or back_ok:
        lines += [f"### {publish_word.capitalize()} ({len(outcome.publishable) + len(back_ok)}, of which {len(back_ok)} from the waiting rows)", "",
                  "| title | venue | source | score | kind |", "|---|---|---|---|---|"]
        for r in sorted([*outcome.publishable, *back_ok], key=lambda r: -r.result.score):
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
        "backlog": {"considered": len(outcome.backlog), "publishable": [str(r.record.get("slug")) for r in select_publishable(outcome.backlog, outcome.fresh_ok)],
                    "failed": len(backlog_failures(outcome)), "note": outcome.backlog_note},
        "published": published.approved if published else [],
        "promoted": bool(published and published.promoted),
        "fresh": {"checked": outcome.fresh.checked, "failed": outcome.fresh.failed},
        "rating": {"status": outcome.rating.status, "asked": outcome.rating.asked, "rated": outcome.rating.rated,
                   "cost_usd": outcome.rating.cost_usd},
        "evidence_by_source": {k: {"rows": v[0], "with_evidence": v[1]} for k, v in outcome.evidence.items()},
    }
