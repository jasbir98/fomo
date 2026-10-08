"""Evidence gate for LLM-extracted deals (pure, unit-tested).

Python port of the rules in scripts/lib/extraction-gate.mjs (normalise, money
figures, "quote must appear verbatim in the saved page text") plus the deal-only
rules from plan §7b:

  * every field comes with a verbatim `quote` that is found on the page;
  * every £ / % figure in a value also appears in that field's quote;
  * a promo code appears verbatim (exact case) on the page and in its quote;
  * dates and weekdays are stated in the quote (or the deal's own quote);
  * the deal is in Edinburgh (EH postcode in the deal's text, or an official
    Edinburgh-only source) and no non-Edinburgh postcode is stated;
  * it has not expired (record_checks.record_is_fully_expired);
  * it passes the app's isGenuineDeal (lib/happenings/groups.ts): a promo code,
    discount wording, or restricted eligibility with a positive saving_amount.
    Plain-price vouchers are dropped as `not_a_deal`.

A field that fails is either fatal (the deal is rejected with that reason) or, for
display-only text, dropped and counted. See CRITICAL_FIELDS.

Nothing here touches the network.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

from deal_sources.textutil import LINK_MARKER_RE
from record_checks import _date_text_variants, record_is_fully_expired, weekly_days_stated_on_page

LONDON = ZoneInfo("Europe/London")

MAX_QUOTE_LEN = 500
MAX_LEN = {
    "summary": 160,
    "price_text": 60,
    "includes": 160,
    "time_note": 200,
    "redemption_note": 200,
    "eligibility_note": 200,
    "allowance_note": 200,
    "venue_name": 200,
    "address": 200,
    "saving_label": 100,
}
TEXT_FIELDS = (
    "saving_label", "price_text", "includes", "summary", "time_note", "redemption_note",
    "eligibility_note", "allowance_note", "venue_name", "address", "promo_code", "booking_url",
)
FIELD_NAMES = TEXT_FIELDS + (
    "saving_amount", "is_free", "eligibility", "starts_at", "ends_at", "season_valid_until", "recurrence",
)
# A failure on one of these rejects the whole deal; any other field (including is_free,
# which only adds a flag the saving_label already carries) is dropped.
CRITICAL_FIELDS = {
    "saving_label", "saving_amount", "promo_code", "price_text", "eligibility",
    "starts_at", "ends_at", "season_valid_until", "recurrence",
}
DATE_FIELDS = ("starts_at", "ends_at", "season_valid_until")
ELIGIBILITY_ENUM = ("anyone", "local_resident", "student", "under_26", "over_60", "member", "cardholder")

REASONS = (
    "no_quote", "quote_not_found", "quote_too_long", "figure_not_in_quote", "promo_code_not_verbatim",
    "date_not_stated", "weekday_not_stated", "eligibility_unsupported", "not_edinburgh", "expired",
    "not_a_deal", "invalid_record",
)


# --- ports of scripts/lib/extraction-gate.mjs -------------------------------------

_ZERO_WIDTH_RE = re.compile("[​-‏⁠﻿­]")


def normalise(s: Any) -> str:
    """Lowercase, unicode quotes/dashes to ascii, strip zero-width chars, collapse whitespace."""
    text = unicodedata.normalize("NFKC", "" if s is None else str(s))
    text = _ZERO_WIDTH_RE.sub("", text)
    text = re.sub("[‘’‚‛′ʼ]", "'", text)
    text = re.sub("[“”„‟″]", '"', text)
    text = re.sub("[‐-―−]", "-", text)
    text = text.replace("…", "...").lower()
    return re.sub(r"\s+", " ", text).strip()


def _canon_number(raw: str) -> str | None:
    try:
        d = Decimal(raw.replace(",", ""))
    except InvalidOperation:
        return None
    return format(d.normalize(), "f")


def money_figures(text: Any) -> set[str]:
    """Canonical £ and % figures: '£12' and '£12.00' both give '£12'; '50p' gives '50p'; '20%' gives '20%'."""
    out: set[str] = set()
    s = unicodedata.normalize("NFKC", "" if text is None else str(text))
    for m in re.finditer(r"£\s?(\d[\d,]*(?:\.\d+)?)", s):
        n = _canon_number(m.group(1))
        if n is not None:
            out.add(f"£{n}")
    for m in re.finditer(r"(?<![\w.£])(\d+(?:\.\d+)?)\s?p\b", s, re.I):
        n = _canon_number(m.group(1))
        if n is not None:
            out.add(f"{n}p")
    for m in re.finditer(r"(\d+(?:\.\d+)?)\s?(?:%|per\s?cent\b)", s, re.I):
        n = _canon_number(m.group(1))
        if n is not None:
            out.add(f"{n}%")
    return out


def clean_value(value: Any) -> str:
    """Replace em dashes (with or without surrounding spaces) by ', ' and collapse whitespace."""
    text = re.sub(r"\s*—\s*", ", ", str(value))
    return re.sub(r"\s+", " ", text).strip()


def strip_markers(quote: str) -> str:
    """Remove the [link: url] markers the extraction view adds after anchors."""
    return LINK_MARKER_RE.sub("", quote)


# --- port of lib/happenings/groups.ts isGenuineDeal -------------------------------

DISCOUNT_SHAPE_RE = re.compile(
    r"\d+(\.\d+)?%|\boff\b|\bdiscount\b|\bconcession\b|half[- ]price|\bfree\b|\bsav(e|es|ing|ings)\b"
    r"|\d+[- ]?for[- ]?\d+|\d+(\.\d+)?\s*tickets?\b",
    re.I,
)


def is_genuine_deal(title: str, saving_label: str | None, saving_amount: float | None,
                    promo_code: str | None, eligibility: str) -> bool:
    if promo_code:
        return True
    if DISCOUNT_SHAPE_RE.search(saving_label or "") or DISCOUNT_SHAPE_RE.search(title or ""):
        return True
    if eligibility != "anyone" and isinstance(saving_amount, (int, float)) and not isinstance(saving_amount, bool) and saving_amount > 0:
        return True
    return False


# --- Edinburgh ---------------------------------------------------------------------

EH_POSTCODE_RE = re.compile(r"\bEH\d{1,2}\s?\d[A-Z]{2}\b", re.I)
UK_POSTCODE_RE = re.compile(r"\b([A-Z]{1,2})\d[A-Z\d]?\s?\d[A-Z]{2}\b", re.I)


def has_eh_postcode(text: str) -> bool:
    return bool(EH_POSTCODE_RE.search(text or ""))


def has_non_eh_postcode(text: str) -> bool:
    return any(m.group(1).upper() != "EH" for m in UK_POSTCODE_RE.finditer(text or ""))


# --- the gate ------------------------------------------------------------------------


@dataclass
class PageContext:
    """The saved text of the page a deal was extracted from."""

    url: str
    text: str  # plain text exactly as hashed (no link markers)
    links: set[str] = field(default_factory=set)  # absolute hrefs on the page
    single_deal: bool = False  # the whole page is about one deal
    norm: str = ""
    repair_text: str = ""  # plain text of the batch the deal came from, for repair_quote()
    repaired: list[str] = field(default_factory=list)  # labels of quotes repaired in this gate run

    def __post_init__(self) -> None:
        if not self.norm:
            self.norm = normalise(self.text)


@dataclass
class GateResult:
    ok: bool
    reason: str | None = None
    detail: str | None = None
    fields: dict[str, Any] = field(default_factory=dict)  # accepted, cleaned values
    evidence: dict[str, dict[str, str]] = field(default_factory=dict)  # field -> {value, quote}
    dropped: dict[str, str] = field(default_factory=dict)  # non-critical field -> why

    def reject(self, reason: str, detail: str) -> "GateResult":
        self.ok = False
        self.reason = reason
        self.detail = detail
        return self


class _FieldFail(Exception):
    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


REPAIR_MIN_RATIO = 0.8
REPAIR_MIN_TOKENS = 3


def repair_quote(quote: str, source_text: str, min_ratio: float = REPAIR_MIN_RATIO) -> str | None:
    """Deterministic repair for a quote that is not verbatim on the page.

    Finds the longest run of consecutive words shared with `source_text` (compared
    after normalising each word) and, when that run covers at least `min_ratio` of
    the quote's words, returns the PAGE's own words for it. The caller still applies
    every other check (figures, promo code) to the returned text, so a quote whose
    missing part carried a number or code is rejected exactly as before."""
    q_tokens = [t for t in (normalise(w) for w in quote.split()) if t]
    if len(q_tokens) < REPAIR_MIN_TOKENS or not source_text:
        return None
    src_words = source_text.split()
    src_tokens = [normalise(w) for w in src_words]
    keep = [i for i, t in enumerate(src_tokens) if t]  # drop words that normalise to nothing
    tokens = [src_tokens[i] for i in keep]
    match = SequenceMatcher(None, tokens, q_tokens, autojunk=False).find_longest_match(0, len(tokens), 0, len(q_tokens))
    if match.size < max(REPAIR_MIN_TOKENS, min_ratio * len(q_tokens)):
        return None
    words = [src_words[keep[i]] for i in range(match.a, match.a + match.size)]
    return " ".join(words)


def _check_quote(raw_quote: Any, page: PageContext, label: str) -> str:
    quote = strip_markers(raw_quote).strip() if isinstance(raw_quote, str) else ""
    if not quote:
        raise _FieldFail("no_quote", f"{label}: no quote")
    if len(quote) > MAX_QUOTE_LEN:
        raise _FieldFail("quote_too_long", f"{label}: quote longer than {MAX_QUOTE_LEN} chars")
    nq = normalise(quote)
    if not nq:
        raise _FieldFail("no_quote", f"{label}: no quote")
    if nq not in page.norm:
        repaired = repair_quote(quote, page.repair_text)
        if repaired and normalise(repaired) in page.norm:
            page.repaired.append(label)
            return repaired
        raise _FieldFail("quote_not_found", f"{label}: quote not found in page text")
    return quote


def _numbers(text: str) -> set[float]:
    out = set()
    for m in re.finditer(r"\d[\d,]*(?:\.\d+)?", text):
        try:
            out.add(float(m.group(0).replace(",", "")))
        except ValueError:
            pass
    return out


def _london_iso(day: str, end: bool) -> str:
    y, m, d = (int(x) for x in day.split("-"))
    dt = datetime(y, m, d, 23, 59, 59, tzinfo=LONDON) if end else datetime(y, m, d, 0, 0, 0, tzinfo=LONDON)
    return dt.isoformat()


def _date_part(value: Any) -> str | None:
    if isinstance(value, str) and re.match(r"^\d{4}-\d{2}-\d{2}", value.strip()):
        return value.strip()[:10]
    return None


def _valid_day(day: str) -> bool:
    try:
        datetime.strptime(day, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def date_variants(d: date) -> set[str]:
    """Every textual way a UK page states this date (record_checks' list plus the
    zero-padded day, which publishers like edinburgh.org use: '01 October')."""
    variants = set(_date_text_variants(d))
    month_full, month_abbr = d.strftime("%B"), d.strftime("%b")
    variants |= {f"{d.day:02d} {month_full}", f"{d.day:02d} {month_abbr}"}
    if d.month == 9:
        variants |= {f"{d.day} Sept", f"{d.day:02d} Sept"}
    # "Month YYYY" alone would accept any day in that month: not a stated date.
    variants -= {f"{month_full} {d.year}", f"{month_abbr} {d.year}"}
    return {v for v in variants if v}


def date_stated(day: str, text: str) -> bool:
    """True when `text` states this ISO day. Word-boundary matched, so '1 October'
    is not found inside '21 October' (record_checks.stated_on_page would accept it)."""
    try:
        d = datetime.strptime(day[:10], "%Y-%m-%d").date()
    except ValueError:
        return False
    lowered = normalise(text)
    if any(re.search(r"(?<![\w])" + re.escape(normalise(v)) + r"(?![\w])", lowered) for v in date_variants(d)):
        return True
    # Day ranges that share a month: "01 to 31 August 2026", "1-3 Oct", "5th and 6th November".
    months = {d.strftime("%B").lower(), d.strftime("%b").lower()} | ({"sept"} if d.month == 9 else set())
    pattern = (r"(?<![\w])(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|to|until|and|&)\s*(\d{1,2})(?:st|nd|rd|th)?\s+("
               + "|".join(sorted(months, key=len, reverse=True)) + r")(?![a-z])")
    return any(d.day in (int(m.group(1)), int(m.group(2))) for m in re.finditer(pattern, lowered))


def _gate_field(name: str, proposal: Any, page: PageContext, deal_quote: str, extra_quotes: str = "") -> tuple[Any, str] | None:
    """Validate one field. Returns (clean value, quote) or None when the field is empty.
    Raises _FieldFail on any violation."""
    if not isinstance(proposal, dict) or proposal.get("value") is None:
        return None
    value = proposal["value"]

    # Typed values first: wrong type is an invalid record, not a quote problem.
    if name == "saving_amount":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise _FieldFail("invalid_record", "saving_amount is not a number")
    elif name == "is_free":
        if not isinstance(value, bool):
            raise _FieldFail("invalid_record", "is_free is not a boolean")
    elif name == "recurrence":
        if not isinstance(value, dict):
            raise _FieldFail("invalid_record", "recurrence is not an object")
    elif not isinstance(value, str):
        raise _FieldFail("invalid_record", f"{name} is not a string")
    elif not clean_value(value):
        return None

    # A bare "once"/"always" recurrence states nothing that needs evidence.
    if name == "recurrence" and value.get("type") in ("once", "always") and not proposal.get("quote"):
        return {"type": value["type"]}, ""

    quote = _check_quote(proposal.get("quote"), page, name)

    if name == "is_free" and value is True and not re.search(r"\bfree\b|£\s?0(?:\.00)?\b", quote, re.I):
        raise _FieldFail("quote_not_found", "is_free: quote does not say free")

    if isinstance(value, str):
        value = clean_value(value)
        wanted = money_figures(value)
        if wanted:
            have = money_figures(quote)
            for fig in sorted(wanted):
                if fig not in have:
                    raise _FieldFail("figure_not_in_quote", f"{name}: figure {fig} not in quote")
        cap = MAX_LEN.get(name)
        if cap and len(value) > cap:
            raise _FieldFail("field_too_long", f"{name}: too long ({len(value)} > {cap})")

    if name == "saving_amount":
        if value <= 0:
            raise _FieldFail("invalid_record", "saving_amount must be positive")
        if float(value) not in _numbers(quote):
            raise _FieldFail("figure_not_in_quote", f"saving_amount: {value} not in quote")

    if name == "promo_code":
        if value not in page.text or value not in quote:
            raise _FieldFail("promo_code_not_verbatim", f"promo_code {value!r} is not verbatim in the page and its quote")

    if name in DATE_FIELDS:
        day = _date_part(value)
        if not day or not _valid_day(day):
            raise _FieldFail("invalid_record", f"{name}: {value!r} is not an ISO date")
        if not date_stated(day, f"{quote} {deal_quote}"):
            raise _FieldFail("date_not_stated", f"{name}: {day} is not stated in its quote")

    if name == "eligibility" and value not in ELIGIBILITY_ENUM:
        raise _FieldFail("invalid_record", f"eligibility {value!r} is not allowed")

    if name == "booking_url":
        url = value.strip()
        if url not in page.links and url.rstrip("/") not in {link.rstrip("/") for link in page.links}:
            raise _FieldFail("invalid_record", "booking_url is not a link on the page")
        value = url

    if name == "recurrence":
        # A weekly offer's `until` is usually the end of the page's date range, which sits in
        # the starts_at/ends_at quotes, not beside the weekday: those (already verified) count.
        value = _check_recurrence(value, quote, f"{deal_quote} {extra_quotes}")

    return value, quote


def _check_recurrence(rec: dict[str, Any], quote: str, deal_quote: str) -> dict[str, Any]:
    rtype = rec.get("type")
    stated = f"{quote} {deal_quote}"
    if rtype in ("once", "always"):
        return {"type": rtype}
    if rtype == "weekly":
        days = [d for d in rec.get("days") or [] if isinstance(d, int) and not isinstance(d, bool) and 0 <= d <= 6]
        if not days:
            raise _FieldFail("invalid_record", "weekly recurrence has no valid days")
        if not weekly_days_stated_on_page(days, stated):
            raise _FieldFail("weekday_not_stated", "recurrence weekday is not stated in its quote")
        until = _date_part(rec.get("until"))
        if rec.get("until") and (not until or not _valid_day(until)):
            raise _FieldFail("invalid_record", "recurrence.until is not an ISO date")
        if until and not date_stated(until, stated):
            raise _FieldFail("date_not_stated", f"recurrence.until {until} is not stated in its quote")
        return {"type": "weekly", "days": sorted(set(days)), "until": until}
    if rtype == "dates":
        dates = [d for d in rec.get("dates") or [] if isinstance(d, str)]
        clean = [d[:10] for d in dates if _date_part(d) and _valid_day(d[:10])]
        if not clean or len(clean) != len(dates):
            raise _FieldFail("invalid_record", "dates recurrence has an invalid or empty date")
        for d in clean:
            if not date_stated(d, stated):
                raise _FieldFail("date_not_stated", f"recurrence date {d} is not stated in its quote")
        return {"type": "dates", "dates": sorted(set(clean))}
    raise _FieldFail("invalid_record", f"recurrence type {rtype!r} is not allowed for deals")


def page_passage(text: str, needle: str, max_len: int = 300) -> str | None:
    """The first line of the page that mentions `needle` (verbatim page text, trimmed)."""
    for line in text.split("\n"):
        if needle.lower() in line.lower() and len(line.strip()) >= 12:
            return line.strip()[:max_len]
    return None


def gate_deal(item: dict[str, Any], page: PageContext, *, today: date, edinburgh_source: bool,
              default_eligibility: str | None = None) -> GateResult:
    """Run one extracted deal through every rule. `item` is the model's dict:
    {title, kind, category, quote, fields: {name: {value, quote}}}."""
    result = GateResult(ok=True)
    title = clean_value(item.get("title") or "")
    if not title:
        return result.reject("invalid_record", "no title")
    if item.get("kind") not in ("deal", "free_access"):
        return result.reject("invalid_record", f"kind {item.get('kind')!r} is not deal/free_access")

    try:
        deal_quote = _check_quote(item.get("quote"), page, "deal")
    except _FieldFail as exc:
        return result.reject(exc.reason, exc.detail)

    proposals = item.get("fields") if isinstance(item.get("fields"), dict) else {}
    # Gate recurrence last so it can lean on the verified date quotes.
    ordered = [n for n in proposals if n != "recurrence"] + (["recurrence"] if "recurrence" in proposals else [])
    for name in ordered:
        proposal = proposals[name]
        if name not in FIELD_NAMES or name == "eligibility":
            continue
        extra = " ".join(result.evidence[n]["quote"] for n in DATE_FIELDS if n in result.evidence)
        try:
            checked = _gate_field(name, proposal, page, deal_quote, extra)
        except _FieldFail as exc:
            # An over-long display value is dropped, never truncated (that would change what the page says).
            if name in CRITICAL_FIELDS and exc.reason != "field_too_long":
                return result.reject(exc.reason, exc.detail)
            result.dropped[name] = exc.detail
            continue
        if checked is None:
            continue
        value, quote = checked
        result.fields[name] = value
        result.evidence[name] = {"value": value if not isinstance(value, dict) else repr(value), "quote": quote}

    fields = result.fields

    # Eligibility is "anyone" unless the page states who qualifies: a restricted
    # value without a verbatim quote rejects the deal (it must never silently
    # become open to everyone).
    eligibility = "anyone"
    proposal = proposals.get("eligibility")
    if isinstance(proposal, dict) and proposal.get("value") not in (None, "anyone"):
        try:
            checked = _gate_field("eligibility", proposal, page, deal_quote)
        except _FieldFail as exc:
            checked = None
            if exc.reason in ("no_quote", "quote_not_found", "quote_too_long") and proposal.get("value") == default_eligibility:
                # A scheme-wide rule (all Resident Rewards offers are for residents) is stated once
                # on the page, not on every offer card: use that statement as the evidence.
                passage = page_passage(page.text, "resident" if default_eligibility == "local_resident" else default_eligibility)
                if passage:
                    checked = (default_eligibility, passage)
            if checked is None:
                reason = "eligibility_unsupported" if exc.reason in ("no_quote", "quote_not_found", "quote_too_long") else exc.reason
                return result.reject(reason, exc.detail)
        if checked:
            eligibility = checked[0]
            result.evidence["eligibility"] = {"value": eligibility, "quote": checked[1]}

    # Edinburgh.
    place_text = " ".join([deal_quote, result.evidence.get("address", {}).get("quote", ""),
                           result.evidence.get("venue_name", {}).get("quote", "")])
    if page.single_deal:
        place_text += " " + page.text
    if has_eh_postcode(place_text):
        pass
    elif has_non_eh_postcode(place_text):
        return result.reject("not_edinburgh", "a non-Edinburgh postcode is stated and no EH postcode")
    elif not edinburgh_source:
        return result.reject("not_edinburgh", "no EH postcode and not an Edinburgh-only source")

    # Expired.
    start, end = _date_part(fields.get("starts_at")), _date_part(fields.get("ends_at"))
    pseudo = {
        "starts_at": start, "ends_at": end, "season_valid_until": fields.get("season_valid_until"),
        "recurrence": fields.get("recurrence") or ({"type": "once"} if (start or end) else {"type": "always"}),
    }
    if record_is_fully_expired(pseudo, today):
        return result.reject("expired", "every stated date has passed")
    if end and start and end < start:
        return result.reject("invalid_record", "ends_at is before starts_at")

    # isGenuineDeal.
    if item["kind"] == "deal":
        if not is_genuine_deal(title, fields.get("saving_label"), fields.get("saving_amount"),
                               fields.get("promo_code"), eligibility):
            return result.reject("not_a_deal", "no promo code, discount wording or restricted-eligibility saving")
    elif fields.get("is_free") is not True:
        return result.reject("not_a_deal", "free_access without a quoted 'free' statement")

    fields["eligibility"] = eligibility
    return result


def to_raw_happening(item: dict[str, Any], gate: GateResult, *, source_name: str, page_url: str) -> dict[str, Any]:
    """Gated fields -> the dict happenings_research.build_full_record expects."""
    f = dict(gate.fields)
    start, end = _date_part(f.get("starts_at")), _date_part(f.get("ends_at"))
    recurrence = f.get("recurrence")
    if recurrence is None:
        recurrence = {"type": "once"} if (start or end) else {"type": "always"}
    if recurrence.get("type") == "weekly" and not recurrence.get("until") and end:
        recurrence = {**recurrence, "until": end}
    venue = f.get("venue_name")
    sources = {name: page_url for name in gate.fields}
    sources["title"] = page_url
    raw: dict[str, Any] = {
        "title": clean_value(item.get("title")),
        "summary": f.get("summary"),
        "kind": item["kind"],
        "category": item.get("category") or "food",
        "scope": "venue" if venue else "city",
        "saving_label": f.get("saving_label"),
        "saving_amount": f.get("saving_amount"),
        "currency": "GBP" if f.get("saving_amount") else None,
        "is_free": f.get("is_free"),
        "promo_code": f.get("promo_code"),
        "redemption_note": f.get("redemption_note"),
        "eligibility": f.get("eligibility", "anyone"),
        "eligibility_note": f.get("eligibility_note"),
        "allowance_note": f.get("allowance_note"),
        "price_text": f.get("price_text"),
        "includes": f.get("includes"),
        "season_valid_until": _date_part(f.get("season_valid_until")),
        "starts_at": _london_iso(start, end=False) if start else None,
        "ends_at": _london_iso(end, end=True) if end else None,
        "recurrence": recurrence,
        "time_note": f.get("time_note"),
        "venue_name": venue,
        "address": f.get("address"),
        "booking_url": f.get("booking_url"),
        "cta_label": "View offer",
        "source_name": source_name,
        "source_url": page_url,
        "source_urls": [page_url],
        "field_sources": sources,
        "confidence": "high",
        "priority": 50,
    }
    return raw
