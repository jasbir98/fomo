"""Look at a row's source page before it can reach the review digest.

Used by scraper/score_backlog.py (the waiting backlog) and scraper/deal_routing.py (a run's new rows).
One request per page, never retried, through deal_sources.fetch.PoliteFetcher: the bot's real
User-Agent, robots.txt obeyed, a 1 second gap between hits on one host, blocks and challenge pages
skipped rather than worked around.

What one check says (PageCheck.status):
  ok           the page loaded. `excerpt` is a short slice of its text around the deal, for the AI rating.
  gone         HTTP 404 or 410: the page no longer exists. The row routes drop.
  lapsed       the page loaded but states explicit dates and every one has passed (see lapsed_reason).
               The row routes drop.
  unconfirmed  a block, a timeout, robots.txt, a 5xx or anything else: we could not look. The row stays
               in the digest and says so. Never a reason to drop.
  not_checked  not reached this run (over the page cap, or no source URL).

The result is written into quality_reasons as one marker string (see marker()), because the quality
columns are the only ones the backlog scorer may write. lib/review/digest.ts reads it back: the email
shows a row only when its marker says the page was checked.

Pure apart from the injected `get`. The tests use fakes and never touch the network.
"""

from __future__ import annotations

import html as html_lib
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Callable

MARKER_PREFIX = "page check: "
MARKER_OK = MARKER_PREFIX + "ok"
MARKER_UNCONFIRMED = MARKER_PREFIX + "unconfirmed"
MARKER_NOT_REACHED = MARKER_PREFIX + "not reached"
EXCERPT_CHARS = 700
BACKLOG_PAGE_CAP = 150  # pages looked at per backlog run, best score first
RUN_PAGE_CAP = 40  # pages looked at per daily run, best score first


@dataclass
class PageCheck:
    status: str  # ok | gone | lapsed | unconfirmed | not_checked
    reason: str = ""
    excerpt: str = ""


# --- text and dates ---------------------------------------------------------------------------

_SCRIPT_STYLE_RE = re.compile(r"(?is)<(script|style|noscript|svg|template)\b[^>]*>.*?</\1>")
_TAG_RE = re.compile(r"(?s)<[^>]+>")

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], 1)}
for _full, _n in list(MONTHS.items()):
    MONTHS.setdefault(_full[:3], _n)
MONTHS["sept"] = 9
_MONTH_WORD = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"

# 8 Aug 2026, 8th August 2026, 8 th May 2026 (Bonnie & Wild's page spells it that way)
_DMY_RE = re.compile(rf"\b(\d{{1,2}})\s*(?:st|nd|rd|th)?\s+(?:of\s+)?({_MONTH_WORD})\.?,?\s+(20\d\d)\b", re.I)
# August 8, 2026 / August 8th 2026
_MDY_RE = re.compile(rf"\b({_MONTH_WORD})\.?\s+(\d{{1,2}})\s*(?:st|nd|rd|th)?,?\s+(20\d\d)\b", re.I)
_ISO_RE = re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b")
_SLASH_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(20\d\d)\b")
# Structured event dates in the page's JSON/ld+json: "startDate": "2026-08-08T15:00", "EndDateTime":"2026-08-08T15:00:00.000Z"
_STRUCTURED_RE = re.compile(r'"[a-z]*(?:start|end)[a-z]*(?:date|time)[a-z]*"\s*:\s*"(20\d\d)-(\d\d)-(\d\d)', re.I)
_YEAR_RE = re.compile(r"\b(20\d\d)\b")

# Words that say a thing has no end date. Their presence means "do not call it lapsed".
_OPEN_ENDED_RE = re.compile(
    r"\b(?:ongoing|on-going|until further notice|all year|year[- ]round|throughout the year|every month|each month|monthly|"
    r"(?:first|second|third|fourth|last)\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day of (?:the|every|each) month|"
    r"permanent|always available|no end date)\b",
    re.I,
)
_RECURRING_RE = re.compile(
    r"\b(?:every|each)\s+(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|week|night|evening|day|weekend)s?\b|\bweekly\b|\bnightly\b|\bdaily\b",
    re.I,
)


def page_text(markup: str) -> str:
    """Visible text of an HTML page: scripts, styles and tags removed, whitespace collapsed."""
    text = _TAG_RE.sub(" ", _SCRIPT_STYLE_RE.sub(" ", markup or ""))
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def _month(word: str) -> int | None:
    return MONTHS.get(word.lower().rstrip("."))


def _make_date(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


_NOISE_WORDS_BEFORE_RE = re.compile(r"(?:published|posted|updated|modified|©|copyright|last reviewed|written|since|established|founded|opened|est\.?)\W*$", re.I)
RECENT_PAST_DAYS = 400  # a visible date older than this is a history date ("since 2019"), not an event date


def stated_dates(text: str, markup: str = "") -> tuple[set[date], set[date]]:
    """(dates in the visible `text`, structured occurrence dates in the raw `markup`), all with a year.
    A visible date right after "published", "updated", "since", "established" or a copyright sign is not an
    event date and is skipped. Dates without a year ("27 Nov - 20 Dec") are never counted. Structured dates are
    the start/end dates a page embeds as data (JSON, JSON-LD): a machine-readable list of occurrences."""
    visible: set[date] = set()

    def noisy(start: int) -> bool:
        return bool(_NOISE_WORDS_BEFORE_RE.search(text[max(0, start - 20):start]))

    for m in _DMY_RE.finditer(text):
        mon = _month(m.group(2))
        d = _make_date(int(m.group(3)), mon, int(m.group(1))) if mon else None
        if d and not noisy(m.start()):
            visible.add(d)
    for m in _MDY_RE.finditer(text):
        mon = _month(m.group(1))
        d = _make_date(int(m.group(3)), mon, int(m.group(2))) if mon else None
        if d and not noisy(m.start()):
            visible.add(d)
    for m in _ISO_RE.finditer(text):
        d = _make_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if d and not noisy(m.start()):
            visible.add(d)
    for m in _SLASH_RE.finditer(text):
        d = _make_date(int(m.group(3)), int(m.group(2)), int(m.group(1)))  # UK order: day/month/year
        if d and not noisy(m.start()):
            visible.add(d)
    structured: set[date] = set()
    for m in _STRUCTURED_RE.finditer(markup or ""):
        d = _make_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if d:
            structured.add(d)
    return visible, structured


def explicit_dates(text: str, markup: str = "") -> set[date]:
    visible, structured = stated_dates(text, markup)
    return visible | structured


def lapsed_reason(text: str, markup: str, today: date, record: dict[str, Any] | None = None) -> str | None:
    """Why a page that loaded is over, or None. When in doubt: None (the row stays in the digest).

    It is over only when the page states explicit dates (with a year), every one is before `today`, it
    mentions no later year and uses no open-ended wording ("ongoing", "monthly", "year-round", ...), and one of:
      * a machine-readable list of three or more occurrences (structured start/end dates, as a Fringe or
        ticketing page embeds them) has all passed, even though the page says "every Saturday and Sunday": the
        wording describes that run, which is over; or
      * the record and the page are not recurring (no weekly/always/annual record, no "every Monday" on the
        page) and the visible dates, recent ones only, have all passed.
    Visible dates beside a recurring pattern (a pub quiz's old posts, one stale date next to "last Thursday of
    every month") prove nothing, so those rows are left in the digest."""
    visible, structured = stated_dates(text, markup)
    visible = {d for d in visible if (today - d).days <= RECENT_PAST_DAYS}  # history dates ("since 2019") are not event dates
    dates = visible | structured
    if not dates or max(dates) >= today:
        return None
    if _OPEN_ENDED_RE.search(text):
        return None
    if any(int(y) > max(dates).year for y in _YEAR_RE.findall(text)):
        return None  # the page mentions a later year: something is still to come
    recurring = bool(_RECURRING_RE.search(text)) or (
        isinstance((record or {}).get("recurrence"), dict) and record["recurrence"].get("type") in ("weekly", "always", "annual"))
    if len(structured) >= 3 or (not recurring and visible):
        return f"series lapsed: the page states {len(dates)} date(s), the last on {max(dates).isoformat()}, and none is still to come"
    return None


def excerpt_for(text: str, record: dict[str, Any], limit: int = EXCERPT_CHARS) -> str:
    """A short slice of page text around the record's quote, else its title, else its venue. Never the whole page."""
    lowered = text.lower()
    quote = " ".join(str(record.get("evidence_quote") or "").split())
    needles = [quote[:60], str(record.get("title") or ""), str(record.get("venue_name") or "")]
    for needle in needles:
        needle = needle.strip().lower()
        if len(needle) < 4:
            continue
        at = lowered.find(needle)
        if at >= 0:
            start = max(0, at - limit // 4)
            return text[start:start + limit].strip()
    return text[:limit].strip()


# --- the check ---------------------------------------------------------------------------------


def _source_url(record: dict[str, Any]) -> str:
    url = str(record.get("source_url") or "").strip()
    return url if url.lower().startswith(("http://", "https://")) else ""


def _outcome(record: dict[str, Any], resp: Any, today: date) -> PageCheck:
    """Turn one response (deal_sources.fetch.Response: ok, status, text, reason) into a PageCheck."""
    status = getattr(resp, "status", None)
    if not getattr(resp, "ok", False):
        if status in (404, 410):
            return PageCheck("gone", f"HTTP {status}")
        return PageCheck("unconfirmed", str(getattr(resp, "reason", None) or "could not be read")[:80])
    markup = getattr(resp, "text", "") or ""
    text = page_text(markup)
    why = lapsed_reason(text, markup, today, record)
    if why:
        return PageCheck("lapsed", why, excerpt_for(text, record))
    return PageCheck("ok", "", excerpt_for(text, record))


def check_page(record: dict[str, Any], get: Callable[[str], Any], today: date) -> PageCheck:
    """Look at record["source_url"] once. `get(url)` returns a deal_sources.fetch.Response. Never raises."""
    url = _source_url(record)
    if not url:
        return PageCheck("unconfirmed", "no usable source URL")
    try:
        resp = get(url)
    except Exception as exc:  # noqa: BLE001 - a failed look is a reported state, never a crash
        return PageCheck("unconfirmed", f"{exc.__class__.__name__}")
    return _outcome(record, resp, today)


def check_rows(
    rows: list[dict[str, Any]],
    get: Callable[[str], Any],
    today: date,
    *,
    cap: int,
    already: Callable[[dict[str, Any]], PageCheck | None] = lambda row: None,
) -> tuple[dict[str, PageCheck], int]:
    """Check `rows` in the order given (the caller sorts best score first), looking at no more than `cap`
    distinct pages. Rows that share a source URL share one request. `already(row)` may return an earlier
    result to reuse without a request. Returns (slug -> PageCheck, pages requested). A row not reached
    gets no entry."""
    out: dict[str, PageCheck] = {}
    responses: dict[str, Any] = {}
    requested = 0
    for row in rows:
        slug = str(row.get("slug") or "")
        if not slug:
            continue
        earlier = already(row)
        if earlier is not None:
            out[slug] = earlier
            continue
        url = _source_url(row)
        if not url:
            out[slug] = PageCheck("unconfirmed", "no usable source URL")
            continue
        if url not in responses:
            if requested >= cap:
                continue
            requested += 1
            try:
                responses[url] = get(url)
            except Exception as exc:  # noqa: BLE001
                out[slug] = PageCheck("unconfirmed", exc.__class__.__name__)
                responses[url] = None
                continue
        resp = responses[url]
        out[slug] = _outcome(row, resp, today) if resp is not None else PageCheck("unconfirmed", "request failed")
    return out, requested


def marker(check: PageCheck | None, today: date) -> str:
    """The reason string that records a check. No check (not reached) is its own marker."""
    if check is None or check.status == "not_checked":
        return f"{MARKER_NOT_REACHED} (over the page limit)"
    if check.status == "ok":
        return f"{MARKER_OK} {today.isoformat()}"
    if check.status == "gone":
        return f"{MARKER_PREFIX}gone ({check.reason}): the source page no longer exists"
    if check.status == "lapsed":
        return f"{MARKER_PREFIX}lapsed: {check.reason}"
    return f"{MARKER_UNCONFIRMED} ({check.reason or 'could not look'})"


def check_from_reasons(reasons: Any, today: date, max_age_days: int = 7) -> PageCheck | None:
    """An earlier ok / unconfirmed result stored in quality_reasons, if it is recent enough to reuse.
    Only an `ok` marker with a date is reused (so a block gets another try on the next run)."""
    for r in reasons if isinstance(reasons, list) else []:
        if isinstance(r, str) and r.startswith(MARKER_OK + " "):
            try:
                when = datetime.fromisoformat(r[len(MARKER_OK) + 1:].strip()[:10]).date()
            except ValueError:
                continue
            if 0 <= (today - when).days <= max_age_days:
                return PageCheck("ok", "(reused)", "")
    return None


def apply_checks(routed: list[Any], checks: dict[str, PageCheck], today: date) -> list[Any]:
    """Fold page checks into routed deals (quality.RoutedDeal). A page that is gone or lapsed makes the row
    drop; every other row not already dropped gets its marker (ok, unconfirmed or not reached) appended to
    its reasons. Returns a new list in the same order; the inputs are not changed."""
    from dataclasses import replace  # local: keeps the top of this module free of the quality import

    from deal_sources.quality import QualityResult

    out = []
    for item in routed:
        if item.route == "drop":
            out.append(item)
            continue
        check = checks.get(str(item.record.get("slug") or ""))
        route = "drop" if check is not None and check.status in ("gone", "lapsed") else item.route
        out.append(replace(item, route=route, result=QualityResult(item.result.score, [*item.result.reasons, marker(check, today)])))
    return out


def make_fetcher() -> Callable[[str], Any]:
    """A fetcher with the bot identity and robots.txt rules. Each call is one request, no retry."""
    from deal_sources.fetch import PoliteFetcher  # lazy: importing it loads requests

    fetcher = PoliteFetcher()
    return fetcher.get
