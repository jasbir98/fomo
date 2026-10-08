"""Pure checks on happening records / page text, shared by weekly_edinburgh.py and
scraper/deal_sources/. Moved out of weekly_edinburgh.py unchanged so the deal-source
gate can reuse them without a circular import."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any


def _ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _date_text_variants(d) -> set[str]:
    """Every common way a UK publisher page states a date in prose."""
    month_full, month_abbr = d.strftime("%B"), d.strftime("%b")
    variants = {
        d.isoformat(),
        d.strftime("%d/%m/%Y"), d.strftime("%d-%m-%Y"), d.strftime("%d.%m.%Y"),
        d.strftime("%d/%m/%y"),
        d.strftime("%d %B %Y"), d.strftime("%d %b %Y"),
        d.strftime("%-d %B %Y"), d.strftime("%-d %b %Y"),
        d.strftime("%B %-d, %Y"), d.strftime("%b %-d, %Y"),
        f"{d.day} {month_full}", f"{d.day} {month_abbr}",
        f"{_ordinal(d.day)} {month_full}", f"{_ordinal(d.day)} {month_abbr}",
        f"{_ordinal(d.day)} of {month_full}",
        d.strftime("%A %-d %B"), d.strftime("%a %-d %b"),
        f"{month_full} {d.year}", f"{month_abbr} {d.year}",
    }
    return {v.strip() for v in variants if v and v.strip()}


def _time_text_variants(dt) -> set[str]:
    """Textual variants for a stated release/start TIME (not just the date).

    Empty when the timestamp carries no real time component (midnight is
    used as a "date only" placeholder throughout this pipeline -- see
    build_full_record/booking_opens_at -- so it has nothing to check).
    """
    if dt.hour == 0 and dt.minute == 0:
        return set()
    h12 = dt.strftime("%I:%M%p").lstrip("0")
    variants = {
        dt.strftime("%H:%M"),
        h12.lower(), h12.upper(),
        h12.lower().replace(":00", ""),
        dt.strftime("%I.%M%p").lstrip("0").lower(),
        dt.strftime("%I%p").lstrip("0").lower(),
    }
    return {v.strip() for v in variants if v and v.strip()}


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def stated_on_page(value: str, text: str, is_date: bool = False, is_time: bool = False) -> bool:
    """Hard-fact check. Verbatim/case-sensitive for non-dates (promo codes,
    saving labels); for dates, verbatim OR any common textual format,
    matched case-insensitively since a page writing "26 september" in
    lower-case is not a different fact from "26 September"."""
    if value in text:
        return True
    if not is_date:
        return False
    parsed = _parse_iso(value)
    if parsed is None:
        return False
    lowered = text.lower()
    if any(variant.lower() in lowered for variant in _date_text_variants(parsed.date())):
        return True
    if is_time:
        return any(variant in lowered for variant in _time_text_variants(parsed))
    return False


_WEEKDAY_NAMES = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")


def weekly_days_stated_on_page(days: list[Any], text: str) -> bool:
    """Hard fact for a weekly recurrence: at least one of its stated weekdays
    (schema: 0=Sunday) actually appears on the page, e.g. a ceilidh's page
    saying "every Tuesday"."""
    names = [_WEEKDAY_NAMES[d] for d in days if isinstance(d, int) and 0 <= d <= 6]
    if not names:
        return True  # nothing concrete stated in the record itself to check
    lowered = text.lower()
    return any(name.lower() in lowered for name in names)


def _coerce_date(value: Any):
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return datetime.strptime(value, "%Y-%m-%d").date()
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def record_is_fully_expired(record: dict[str, Any], today) -> bool:
    """True only when this record carries a concrete date that has already
    elapsed, with nothing upcoming behind it.

    Narrower than "a one-off in the past" (already dropped inside
    build_full_record at research time): a record can also carry a stale
    concrete date under an "annual" or "weekly" recurrence label -- e.g.
    this year's already-finished Fringe/Beltane dates tagged "annual", or a
    weekly chain offer whose stated "until" cutoff has passed -- and neither
    is caught by the once-only check. A record with NO concrete date at all
    is never touched here: that is the correct, intended shape for a
    genuine standing "annual"/"always" placeholder (rule 6 -- "next year's
    row, not this year's, with no starts_at"), and inventing next year's
    date ourselves to compare against would itself be a rule-1 violation.
    """
    if record.get("_collection_members"):
        return False
    # A season-bound offer (festival concessions etc.) is often stored as an
    # "always" row with no concrete dates, and its evergreen policy page keeps
    # re-verifying year-round -- season_valid_until is the one date that
    # retires it (supabase/archive/add_season_valid_until.sql).
    season_end = _coerce_date(record.get("season_valid_until"))
    if season_end is not None and season_end < today:
        return True
    recurrence = record.get("recurrence") or {}
    rec_type = recurrence.get("type")
    if rec_type == "weekly":
        until = _coerce_date(recurrence.get("until"))
        return until is not None and until < today
    if rec_type == "dates":
        dates = [d for d in (_coerce_date(d) for d in recurrence.get("dates") or []) if d]
        return bool(dates) and all(d < today for d in dates)
    concrete = _coerce_date(record.get("ends_at")) or _coerce_date(record.get("starts_at"))
    return concrete is not None and concrete < today
