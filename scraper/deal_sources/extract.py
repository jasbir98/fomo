"""One DeepSeek forced-tool call per page: page text -> a list of deals.

Every factual field comes back as {value, quote}: the quote is text copied from the
page, which gate.py then checks against the saved page text. Records built from the
gated output go through happenings_research.build_full_record, so they have exactly
the shape of the topic pipeline's records.

DeepSeek facts (scraper/llm_client.py): thinking must be disabled on a forced
tool_choice call (SUBMIT_CALL_KWARGS), the json_schema output_config is ignored (so a
forced tool call is the only structured-output route), and calls must not run
concurrently.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from typing import Any

from happenings_research import CATEGORY_ENUM, SUBMIT_MAX_TOKENS
from llm_client import SUBMIT_CALL_KWARGS

from deal_sources.gate import ELIGIBILITY_ENUM, MAX_LEN, MAX_QUOTE_LEN

TOOL_NAME = "submit_deals"


def _fq(value_schema: dict[str, Any], description: str) -> dict[str, Any]:
    return {
        "type": "object",
        "description": description,
        "properties": {
            "value": value_schema,
            "quote": {"type": "string", "description": f"Text copied word for word from the page that states this value (max {MAX_QUOTE_LEN} characters)."},
        },
        "required": ["value", "quote"],
    }


_STR = {"type": "string"}

FIELDS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "description": "Only include a field when the page states it. Leave it out otherwise.",
    "properties": {
        "saving_label": _fq(_STR, f"The offer in the page's own words, e.g. '20% off', 'Kids eat free', '2 for 1', '£35.00 per person' (max {MAX_LEN['saving_label']} chars)."),
        "saving_amount": _fq({"type": "number"}, "The amount SAVED in pounds, only when the page states it (e.g. 'save £10' gives 10). Never a menu price. Never convert a percentage."),
        "promo_code": _fq(_STR, "A code the customer must enter or quote, copied exactly (same case) from the page. Leave out if no code is printed."),
        "price_text": _fq(_STR, f"The price as the page states it, e.g. '£35.00 per person', 'From £15' (max {MAX_LEN['price_text']} chars)."),
        "includes": _fq(_STR, f"What the price or offer covers, e.g. '1 large brunch dish and 5 drinks' (max {MAX_LEN['includes']} chars)."),
        "summary": _fq(_STR, f"One sentence describing the offer in your own words (max {MAX_LEN['summary']} chars). Every number must be in the quote."),
        "is_free": _fq({"type": "boolean"}, "true only when the page says the thing is free (the quote must say so)."),
        "eligibility": _fq({"type": "string", "enum": list(ELIGIBILITY_ENUM)}, "Who can claim it. 'anyone' unless the page says otherwise; any other value needs a quote saying who qualifies."),
        "eligibility_note": _fq(_STR, f"Any condition on who can claim it (max {MAX_LEN['eligibility_note']} chars)."),
        "redemption_note": _fq(_STR, f"How to claim it: booking rules, proof needed, minimum spend (max {MAX_LEN['redemption_note']} chars)."),
        "time_note": _fq(_STR, f"Hours or days it applies, e.g. '11am to 5pm', 'Monday to Thursday' (max {MAX_LEN['time_note']} chars)."),
        "starts_at": _fq(_STR, "First valid date, YYYY-MM-DD. Only when the page states it."),
        "ends_at": _fq(_STR, "Last valid date, YYYY-MM-DD. Only when the page states it."),
        "season_valid_until": _fq(_STR, "A last valid date for an otherwise standing offer, YYYY-MM-DD."),
        "recurrence": _fq(
            {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["once", "always", "weekly", "dates"]},
                    "days": {"type": "array", "items": {"type": "integer"}, "description": "Weekdays 0=Sunday .. 6=Saturday (weekly only)."},
                    "until": {"type": ["string", "null"], "description": "Last date YYYY-MM-DD (weekly only)."},
                    "dates": {"type": "array", "items": {"type": "string"}, "description": "Every date YYYY-MM-DD the page lists (dates only)."},
                },
                "required": ["type"],
            },
            "When it runs. once = a dated range or single date (use starts_at/ends_at). always = a standing offer. "
            "weekly = only on certain weekdays. dates = a fixed list of dates. Every weekday and date must be in the quote.",
        ),
        "venue_name": _fq(_STR, "The business or venue that provides the offer."),
        "address": _fq(_STR, "Its address exactly as the page gives it, including the postcode."),
        "booking_url": _fq(_STR, "A link from the page for booking or claiming, copied from a [link: ...] marker. Leave out if none fits."),
    },
}

DEAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "At most 8 words, e.g. 'Irish boozy brunch for £35 at Malones Leith'."},
        "kind": {"type": "string", "enum": ["deal", "free_access"], "description": "deal = a saving or special price. free_access = free entry."},
        "category": {"type": "string", "enum": list(CATEGORY_ENUM)},
        "quote": {"type": "string", "description": f"The page passage (max {MAX_QUOTE_LEN} characters) that states this offer and its saving, copied word for word."},
        "fields": FIELDS_SCHEMA,
    },
    "required": ["title", "kind", "category", "quote", "fields"],
}

SUBMIT_TOOL: dict[str, Any] = {
    "name": TOOL_NAME,
    "description": "Submit every genuine deal found on this page (an empty list if there are none).",
    "input_schema": {
        "type": "object",
        "properties": {"deals": {"type": "array", "items": DEAL_SCHEMA}},
        "required": ["deals"],
    },
}

SYSTEM_PROMPT = """You extract deals from one web page for Fomo, an Edinburgh app for cheap and free things to do and local or student deals.

A deal is a real saving or special price a person can claim: a percentage or amount off, a 2-for-1, a free item or free entry, a set price below the normal price, or a price that needs a code. A plain price (a menu item, a ticket, a hotel stay or a voucher at its normal price) is NOT a deal. If the page has no deal, return an empty list.

Rules. Breaking any of them makes a row that misleads people, which is worse than no row.
1. Copy, never invent. Every field is {value, quote}. The quote is copied word for word from the page, short, and states that value. Do not include [link: ...] markers in a quote.
2. Every number in a value (a price, a percentage, a saving) must appear in its quote.
3. Dates: only use a date the page states. Write it as YYYY-MM-DD. If the page gives a day and month without a year, use the year that makes it the next occurrence from today. If you cannot tell, leave the date out.
4. Promo codes are copied exactly, with the same capital letters. If a discount has no printed code, leave promo_code out.
5. Eligibility is 'anyone' unless the page states who qualifies (for example Edinburgh residents, students, over 60s). Do not guess.
6. Prefer leaving a field out to guessing it. A field with no quote on the page must be left out.
7. Offers that run only on certain weekdays are recurrence type 'weekly' with those days. A fixed list of dates is type 'dates'. A single date range is type 'once' with starts_at and ends_at. A standing offer is 'always'.
8. One entry per distinct offer. Do not repeat an offer.
9. Titles are short and plain: the venue and the offer. No hype.
"""


@dataclass
class ExtractResult:
    deals: list[dict[str, Any]]
    input_tokens: int = 0
    output_tokens: int = 0
    error: str | None = None
    truncated: bool = False


def build_user_prompt(*, source_name: str, hints: str, page_url: str, today: date, text: str,
                      chunk_note: str | None = None) -> str:
    parts = [
        f"Today's date is {today.isoformat()} (Europe/London).",
        f"Source: {source_name}",
        f"Page: {page_url}",
    ]
    if hints:
        parts.append(f"About this source: {hints}")
    if chunk_note:
        parts.append(chunk_note)
    parts.append("PAGE TEXT (a [link: URL] marker follows each link):\n" + text)
    return "\n\n".join(parts)


def extract_deals(client: Any, model: str, user_prompt: str, max_tokens: int = SUBMIT_MAX_TOKENS) -> ExtractResult:
    """One forced submit_deals call. Never raises: an API failure is returned as `error`."""
    try:
        with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=SYSTEM_PROMPT,
            tools=[SUBMIT_TOOL],
            tool_choice={"type": "tool", "name": TOOL_NAME},
            messages=[{"role": "user", "content": user_prompt}],
            temperature=0,  # extraction, not creative writing: keeps repeat runs stable
            **SUBMIT_CALL_KWARGS,
        ) as stream:
            response = stream.get_final_message()
    except Exception as exc:  # reportable per page, never fatal for the run
        return ExtractResult([], error=f"{exc.__class__.__name__}: {exc}")

    usage = getattr(response, "usage", None)
    result = ExtractResult(
        [],
        input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
        output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
        truncated=getattr(response, "stop_reason", None) == "max_tokens",
    )
    tool = next((b for b in getattr(response, "content", []) if getattr(b, "type", "") == "tool_use"), None)
    data = getattr(tool, "input", None) if tool else None
    if isinstance(data, str):  # some gateways hand back the JSON as a string
        try:
            data = json.loads(data)
        except ValueError:
            data = None
    deals = data.get("deals") if isinstance(data, dict) else None
    if not isinstance(deals, list):
        result.error = "no usable submit_deals call" + (" (output truncated)" if result.truncated else "")
        return result
    result.deals = [d for d in deals if isinstance(d, dict)]
    return result
