#!/usr/bin/env python3
"""
happenings_research.py — researches Edinburgh (or another configured city's)
"happenings": time-limited money/access opportunities — via the Anthropic
API's server-side web_search tool, and extracts them into the
`happenings_staging` record shape, writing
`scraper/out/<batch-id>/<city>-happenings-<mode>.json` as `{"records": [...]}`.

Why this exists: the app (Fomo) exists because its own user missed National
Cinema Weekend — a real, £4-ticket, UK-wide event — simply because nobody
surfaced it to them in time. Inventing a fake happening is worse than
missing a real one, so this script is built around the opposite failure
mode from discover_and_extract_city.py's places pipeline: instead of
"find genuinely interesting places," the job here is "find genuinely real,
currently-true offers and dates, and refuse to guess when unsure."

Five modes, because each has a different failure mode and needs a
different prompt:

  calendar   — dated one-offs + annual fixtures, next 12 months, ~40 rows,
               larger search budget. Walks each city's known_fixtures by name
               (see scraper/happenings/cities/<slug>.py) before doing any
               broader search — named search targets massively outperform
               open-ended "find events in <city>" queries, and this is the
               direct fix for the missed Cinema Weekend. Catastrophic error
               to guard against: a hallucinated date.

  offers     — rolling venue deals, recurrence-first (starts_at usually
               null), ~30 rows. Also covers student deals, chain pub/food
               offers, cheap cinema days, and permanently-free museums
               (free_access, recurrence "always") — broadened coverage, same
               prompt family as the original deals-only version. Catastrophic
               error to guard against: a hallucinated promo code.

  whats-on   — recurring/regular things locals often don't know about:
               parkruns, free walking tours, free museum lates/talks, weekly
               markets, free guided walks, ceilidhs. kind is usually
               activity/tour/event/free_access. Catastrophic error to guard
               against: a wrong recurrence (e.g. guessing a parkrun's day
               instead of verifying it).

  book-early — upcoming (≈12 months) bookable events/festivals/tours where
               booking ahead matters (Hogmanay, Fringe, Tattoo, big
               concerts, Murrayfield fixtures). Unlike calendar/offers these
               CAN be paid. The whole point of this mode is
               booking_opens_at precision — full ISO 8601 WITH the release
               time and Europe/London offset when a source states one, not
               just a bare date. sellout_risk/sellout_note are optional and
               strictly source-backed (both null or both set — never a
               guessed risk level with no citation). Catastrophic error to
               guard against: a hallucinated or imprecise release time.

  verify     — takes a worklist JSON ([{slug, source_url, title}], from
               `scripts/sweep-happenings.mjs --emit-worklist`) on stdin or
               `--worklist <path>`, re-checks each against its source, and
               emits {"records": [{slug, still_live, verified_at, changes}]}.
               Exists from day one, not added later: without it, "checked 3
               days ago" silently rots into "checked 4 months ago" and the
               whole point of a "still current" badge collapses.

Mirrors the conventions of discover_and_extract_city.py (.env loading,
DEFAULT_MODEL, web_search_tool_for_model(), the open agentic research loop,
pause_turn resume handling, the final forced-tool-use call for structured
output) and classify_reels.py (strict rubric system prompt with a
"prefer false/null when uncertain" bias, forced-tool-use + shape
validation). City-specific data (source domains, known_fixtures, prompt
guidance) lives in `scraper/happenings/` — see that package's base.py for
the CityHappeningsConfig contract and README.md for the end-to-end workflow.

Usage:
    python scraper/happenings_research.py --mode calendar --batch-id edi-happenings-2026-09-12
    python scraper/happenings_research.py --mode offers --batch-id edi-happenings-2026-09-12
    python scraper/happenings_research.py --mode whats-on --batch-id edi-whatson-2026-09-13
    python scraper/happenings_research.py --mode book-early --batch-id edi-whatson-2026-09-13
    python scraper/happenings_research.py --mode verify --batch-id edi-happenings-2026-09-12 \\
        --worklist scraper/out/edi-happenings-2026-09-12/worklist.json

    # Static/no-network sanity check of CLI wiring and prompt construction:
    python scraper/happenings_research.py --mode calendar --batch-id test --dry-run

Requires DEEPSEEK_API_KEY (in .env.local or scraper/.env) or ANTHROPIC_API_KEY
(in scraper/.env) for any non-dry-run invocation; DeepSeek is used whenever its
key is set. See scraper/llm_client.py for the provider rules and DeepSeek quirks.
--dry-run makes no network calls and needs no key.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

SCRAPER_DIR = Path(__file__).resolve().parent
load_dotenv(SCRAPER_DIR / ".env")

sys.path.insert(0, str(SCRAPER_DIR))
from happenings import CityHappeningsConfig, CITIES, get_city  # noqa: E402
from llm_client import (  # noqa: E402
    RESEARCH_CALL_KWARGS,
    SUBMIT_CALL_KWARGS,
    default_research_model,
    make_research_client,
    sanitize_history,
)

# Provider-aware: "deepseek-flash" when DEEPSEEK_API_KEY is set, otherwise
# "claude-haiku-4-5". See scraper/llm_client.py.
DEFAULT_MODEL = default_research_model()
DEFAULT_OUTPUT_ROOT = SCRAPER_DIR / "out"

# Search budget per mode. calendar gets the larger budget: it walks
# known_fixtures one at a time (each fixture is its own small search) before
# any broader search, so it needs more total web_search calls than offers'
# flatter "check these few source domains" job.
MODE_MAX_SEARCHES: dict[str, int] = {
    "calendar": 30, "offers": 20, "verify": 15,
    "whats-on": 25, "book-early": 25,
}
MODE_TARGET_DESC: dict[str, str] = {
    "calendar": "around 40", "offers": "around 30",
    "whats-on": "around 25", "book-early": "around 20",
}

RESEARCH_MAX_TOKENS = 8000
# whats-on/book-early/offers fixtures (parkrun pages, ticketing announcements,
# resident-rewards pages) tend to produce more verbose per-search synthesis
# than calendar's terser fixture blurbs, which was observed live to exhaust
# the default 8000-token research budget after only the first couple of a
# mode's guidance categories and stop the research loop early — reproduced
# repeatedly on whats-on (stuck on parkruns) before this was raised, and on
# offers (stuck on resident-rewards deals, never reaching the broadened
# student/chain/cinema/free-museum guidance appended after it). Modes that
# need it get a larger budget instead of raising it globally, to keep
# calendar's behavior unchanged.
RESEARCH_MAX_TOKENS_WIDE = 16000
SUBMIT_MAX_TOKENS = 16000
MAX_PAUSE_RESUMES = 6
MAX_SUBMIT_NUDGES = 2

# --- enums (validated in build_full_record / build_verification_record) ---

# Extended per the "What's on" / "Book early" Home sections contract: three
# kinds added (activity/tour/event) and three categories (wellness/outdoors/
# tours) — see supabase/archive/add_happenings_booking.sql's vocab note. Still no DB
# CHECK; this tuple plus lib/happenings/types.ts's unions are the only
# enforcement, so the two must be kept in sync by hand.
KIND_ENUM = ("deal", "free_access", "festival", "activity", "tour", "event")
CATEGORY_ENUM = (
    "music", "nightlife", "festival", "arts", "comedy", "sports", "food",
    "family", "museum", "cinema", "other", "wellness", "outdoors", "tours",
)
SCOPE_ENUM = ("venue", "city", "region", "national")
# "family" = only someone bringing children can use the offer (kids eat free, a
# child free with a paying adult). Must be kept in step with lib/ (types.ts) and
# deal_sources/gate.py's copy by hand.
ELIGIBILITY_ENUM = (
    "anyone", "local_resident", "student", "under_26", "over_60", "member", "cardholder", "family",
)
# Who a happening suits, separate from category: 'kids' = aimed at children,
# 'all_ages' = fine with young children but for anyone, null = not for kids /
# unknown. Mirrors the happenings.family_fit column and lib/ types.
FAMILY_FIT_ENUM = ("kids", "all_ages")
FAMILY_FIT_DESCRIPTION = (
    "Who it suits: 'kids' when aimed at children (a kids' workshop, Bookbug, soft play, kids eat free); "
    "'all_ages' when the page shows it's suitable for young children as well as adults (free museum, garden, "
    "family-friendly attraction); null otherwise or when unsure."
)
CONFIDENCE_ENUM = ("low", "medium", "high")
RECURRENCE_TYPES = ("once", "always", "weekly", "annual", "dates")
# high | medium | low only — a bare/unset sell-out story is represented by
# leaving both sellout_risk and sellout_note null, never by a 4th enum value.
SELLOUT_RISK_ENUM = ("high", "medium", "low")


def web_search_tool_for_model(model: str, max_uses: int) -> dict[str, Any]:
    """Copied verbatim from discover_and_extract_city.py — see there for why
    only sonnet-4-6+/sonnet-5 get the dynamic-filtering variant."""
    _DYNAMIC_FILTERING_MODEL_PREFIXES = ("claude-sonnet-4-6", "claude-sonnet-5")
    if model.startswith(_DYNAMIC_FILTERING_MODEL_PREFIXES):
        return {"type": "web_search_20260209", "name": "web_search", "max_uses": max_uses}
    return {"type": "web_search_20250305", "name": "web_search", "max_uses": max_uses}


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "happening"


# --- prompts ---------------------------------------------------------------

COMMON_RULES = """Ten rules (plus family_fit, below). All ten are equally load-bearing — breaking any one of them
produces a row that actively misleads a user, which is worse than no row at all.

1. NEVER INVENT A DATE. If the source does not state an exact date, starts_at and
   ends_at stay null — put the real timing in `recurrence` and `time_note` instead.
   A date copied over from last year's page IS an invented date: if the page hasn't
   been updated for the next occurrence, leave the date null rather than reusing the
   old one. If the source DOES give an exact day+month for a one-off (e.g. "Sun 26
   October") but not the year, you must still resolve it to a full ISO starts_at
   yourself — pick the year that makes it the NEXT occurrence from today, not a
   date that's already passed — rather than leaving starts_at null and stranding
   the date in time_note only, where the "no expired one-offs" check can't see it.
   If you cannot tell whether the date has already passed (e.g. the page gives no
   clue whether it's this year's or last year's listing), leave starts_at null and
   say so in time_note rather than guessing a year.
2. PROMO CODES ARE VERBATIM, exact case. Never construct, guess, normalise, or
   complete a promo code. A discount described in prose with no code actually printed
   on the page means promo_code is null — not your best guess at what it "probably" is.
3. ELIGIBILITY MUST BE EXPLICIT. eligibility is anything other than "anyone" only
   when the source itself states who qualifies. Never infer "probably residents only"
   just because a place or offer sounds local. eligibility "family" means the offer is
   only usable by someone bringing children (kids eat free, a child goes free with a
   paying adult, under-5s free); a plain family ticket price with no saving is not a deal.
4. PREFER NULL OVER GUESSING, on every field, no exceptions. An empty field is
   honest; a guessed one is a bug that looks like data.
5. SAVINGS ARE THE SOURCE'S OWN FIGURE, verbatim. Never round a number the source
   gave you, and never convert a percentage discount into a currency amount yourself.
6. NO EXPIRED ONE-OFFS. Do not record a one-off event whose date has already passed
   — unless it is a genuine annual fixture, in which case record it with
   recurrence type "annual" and no starts_at (next year's row, not this year's).
7. field_sources MUST MAP EVERY POPULATED FACTUAL FIELD to the URL that actually
   supports it. A row with no source_urls, or no field_sources, gets discarded
   outright before it ever reaches the database.
8. source_url STATES THE TERMS; booking_url IS WHERE YOU REDEEM. Never conflate the
   two. A ticketing/booking page is not automatically the page that states the terms.
9. A permanent menu price is not a happening. A permanently-free museum IS one, if
   free entry is itself the notable fact worth surfacing.
10. NEVER CITE AN AGGREGATOR that merely links elsewhere without itself stating the
    terms — find and cite the actual page that states them.

Also set family_fit: "kids" when the happening is aimed at children (a kids' workshop,
Bookbug, soft play, kids eat free), "all_ages" when the page shows it suits young children
as well as adults (a free museum, a garden, a family-friendly attraction), otherwise null.
Prefer null over guessing — family_fit is separate from category.
"""

CALENDAR_SYSTEM_TEMPLATE = """You are researching time-limited "happenings" — money and access
opportunities — in {city}, {region}, {country_code} for a travel app called Fomo. Fomo exists
because its own user missed National Cinema Weekend, a real UK-wide £4-cinema-ticket weekend,
simply because nobody surfaced it to them in time. Missing a genuine happening is this product's
core failure; inventing a fake one to compensate is worse.

Mode: calendar — dated one-offs and annual fixtures, next 12 months.

Your job in this conversation:

1. Work through this exact list of named fixtures for {city}, one at a time, searching for each
   by name rather than lumping them into one broad query: {known_fixtures_list}
2. {calendar_guidance}
3. After known_fixtures, run a modest number of broader searches to catch other dated one-offs
   and annual fixtures in the next 12 months. Prioritise these domains: {calendar_sources_list}.
   For UK/national-scope fixtures relevant to {city} (e.g. a UK-wide cinema or heritage
   promotion), also check: {national_sources_list}.
4. Aim for {target_desc} happenings, but never pad the list — return fewer if {city} genuinely
   has fewer real, verifiable ones right now.
5. Every factual field must be traceable to a source URL you found via web_search — see rule 7
   below. If a fact isn't explicitly supported by something you found, leave it null.

{common_rules}

Once you have completed your research, call submit_happenings with the full list of records.
Do not call submit_happenings until you are done researching.
"""

OFFERS_SYSTEM_TEMPLATE = """You are researching time-limited "happenings" — specifically rolling
venue deals and standing discounts — in {city}, {region}, {country_code} for a travel app called
Fomo.

Mode: offers — rolling venue deals and standing discounts, recurrence-first.

Your job in this conversation:

1. Search these domains for rolling venue deals, resident discounts, and standing offers:
   {offer_sources_list}. For UK/national chains active in {city}, also check:
   {national_sources_list}.
2. {offer_guidance}
3. Recurrence first: most rows here are standing deals, not dated events. starts_at and
   ends_at should usually be null — capture the real timing in `recurrence` and `time_note`
   instead (e.g. "every Monday", "year-round", "while stocks last").
4. Aim for {target_desc} happenings, but never pad the list — return fewer if genuinely fewer
   real, verifiable offers exist.
5. Every factual field must be traceable to a source URL you found via web_search — see rule 7
   below. If a fact isn't explicitly supported by something you found, leave it null.

{common_rules}

Once you have completed your research, call submit_happenings with the full list of records.
Do not call submit_happenings until you are done researching.
"""

WHATS_ON_SYSTEM_TEMPLATE = """You are researching recurring and regular things that happen in
{city}, {region}, {country_code} that locals themselves often don't know about, for a travel app
called Fomo. This is NOT about discounts or money-saving — it's about genuinely worthwhile things
a visitor or resident could do this week that aren't already obvious from a generic "things to do"
list: a free weekly parkrun, a tip-based walking tour, a free museum lates night, a weekly market,
a free guided nature walk.

Mode: whats-on — recurring/regular activities, tours, and free-access happenings.

Your job in this conversation:

1. Work through this exact list of named recurring things for {city}, one at a time, searching for
   each by name rather than lumping them into one broad query: {whats_on_fixtures_list}
2. {whats_on_guidance}
3. Prioritise these domains: {whats_on_sources_list}. For UK/national-scope recurring things
   relevant to {city}, also check: {national_sources_list}.
4. kind is usually "activity" (parkruns, guided walks, markets, free sessions), "tour" (walking
   tours), "event" (one-off-feeling but actually regular things like a monthly ceilidh), or
   "free_access" (free museum talks/lates). category should reflect what it actually is — a
   parkrun or nature walk is "outdoors", a walking tour is "tours", a free museum talk stays
   "museum".
5. Get the recurrence right — this is the whole point of the mode. A parkrun is
   {{"type":"weekly","days":[6]}} (Saturday) if that's genuinely when it runs — verify the actual
   day from parkrun.org.uk's own event page, never assume Saturday. A monthly market or ceilidh is
   "dates" with the actual announced dates, not "weekly". Put exact times ("09:00 start, meet at
   the bandstand") in time_note — never parsed, display only.
6. Aim for {target_desc} happenings, but never pad the list — return fewer if {city} genuinely
   has fewer real, verifiable ones right now.
7. Every factual field must be traceable to a source URL you found via web_search — see rule 7
   below. If a fact isn't explicitly supported by something you found, leave it null.

{common_rules}

Once you have completed your research, call submit_happenings with the full list of records.
Do not call submit_happenings until you are done researching.
"""

BOOK_EARLY_SYSTEM_TEMPLATE = """You are researching upcoming {city}, {region}, {country_code}
events, festivals, and tours over roughly the next 12 months where booking ahead genuinely
matters, for a travel app called Fomo. The user this section serves wants to catch fast-selling
things the moment tickets go on sale — the value of a row here is almost entirely in getting
booking_opens_at right, down to the exact time, not just the date.

Mode: book-early — upcoming bookable events/festivals/tours, ranked by how likely/fast they sell
out. Unlike calendar/offers mode, these CAN be paid — do not apply any "must be cheap" filter here.

Your job in this conversation:

1. Work through this exact list of named fixtures for {city}, one at a time, searching for each
   by name rather than lumping them into one broad query: {book_early_fixtures_list}
2. {book_early_guidance}
3. Prioritise these domains: {book_early_sources_list}. For UK/national-scope fixtures relevant to
   {city} (e.g. a touring concert, a national rugby fixture), also check: {national_sources_list}.
4. BOOKING TIMING IS THE POINT OF THIS MODE. When a source states an exact release moment for
   tickets — a date AND a time, e.g. "on sale 10:00, Wednesday 1 October" — record it in
   booking_opens_at as a full ISO 8601 timestamp with the Europe/London offset (BST/GMT as
   applicable to that date), not just the date at midnight. If the source only gives a bare date
   with no time, use that date at 00:00 in booking_opens_at and say so in time_note (e.g.
   "exact release time not stated, only the date"). If tickets are already on general sale, leave
   booking_opens_at null — it means "not yet on sale", not "unknown". If a source distinguishes a
   presale (member/app presale) from general sale, capture that distinction in time_note (e.g.
   "app presale 09:00 Tue, general sale 10:00 Wed") or sellout_note if it's about sell-out speed —
   never invent a separate column or field for it.
5. Prefer items whose ticket release is genuinely upcoming (not yet happened) or happened within
   roughly the last few weeks — those are the ones worth surfacing right now. A festival whose
   general sale opened six months ago and is still available is lower priority than one about to
   open.
6. sellout_risk (high/medium/low) and sellout_note are OPTIONAL and STRICTLY SOURCE-BACKED — set
   them only when you find a citable fact about how fast this specific thing has sold out before
   (e.g. a news article, the venue's own past-events page, a forum post citing official info), and
   put that source's own words/figure in sellout_note (e.g. "Sold out within 10 days in 2025" —
   cite what you found, don't paraphrase into a vaguer claim). If you find no such evidence, leave
   both null — null is not "low risk", it's "no evidence found", and a guessed risk level is worse
   than an absent one.
7. Set starts_at/ends_at for when the EVENT ITSELF happens (never invented — rule 1 below still
   applies), which is distinct from booking_opens_at (when you can buy a ticket for it) and from
   booking_url (where you buy it, distinct from source_url which states the terms).
8. is_free/saving_label are optional here — most of these are paid, which is fine; only set them
   when a happening genuinely has a free or discounted strand (e.g. a free festival fringe event
   within a paid festival).
9. Aim for {target_desc} happenings, but never pad the list — return fewer if {city} genuinely
   has fewer real, verifiable ones right now.
10. Every factual field must be traceable to a source URL you found via web_search — see rule 7
    below (the ten common rules). If a fact isn't explicitly supported by something you found,
    leave it null.

{common_rules}

Once you have completed your research, call submit_happenings with the full list of records.
Do not call submit_happenings until you are done researching.
"""

VERIFY_SYSTEM_PROMPT = """You are re-checking a worklist of previously-recorded "happenings" for
a travel app, to confirm whether each one is still accurate. You do this by using web_search to
look for each item's source_url and title and finding current evidence about it.

For each worklist item, decide:

- still_live: true only if you find current evidence the source still shows this happening as
  active/valid right now — a standing offer still described on the page, an annual fixture whose
  page has been updated for its upcoming occurrence, a dated event that hasn't passed and hasn't
  been cancelled. false if the page is gone, the offer has visibly ended with no replacement, the
  date has passed with no evidence of recurrence, or the terms changed enough that the original
  record no longer holds.
- changes: a short note on anything that changed since the original record was made — e.g. "next
  occurrence now 28-29 Nov 2026" or "promo code changed to WINTER24" — or null if nothing of
  substance changed.

Being wrong in either direction is bad: do not mark still_live=false just because a page got a
redesign, and do not mark still_live=true on a guess if you can't actually find current evidence
either way. If you cannot find the page or any current evidence at all, use still_live=false with
changes noting "source unreachable / no current evidence found" — a silently-trusted stale row is
worse than one flagged for a human to check by hand.

Once you have checked every item in the worklist, call submit_verifications with one entry per
item, matched by slug. Do not call submit_verifications until you've searched for each one.
"""


def _fmt_list(items: tuple[str, ...]) -> str:
    return ", ".join(items) if items else "(none configured)"


def build_calendar_system_prompt(city: CityHappeningsConfig) -> str:
    return CALENDAR_SYSTEM_TEMPLATE.format(
        city=city.city,
        region=city.region,
        country_code=city.country_code,
        known_fixtures_list=_fmt_list(city.known_fixtures),
        calendar_guidance=city.calendar_guidance,
        calendar_sources_list=_fmt_list(city.calendar_sources),
        national_sources_list=_fmt_list(city.national_sources),
        target_desc=MODE_TARGET_DESC["calendar"],
        common_rules=COMMON_RULES,
    )


def build_offers_system_prompt(city: CityHappeningsConfig) -> str:
    return OFFERS_SYSTEM_TEMPLATE.format(
        city=city.city,
        region=city.region,
        country_code=city.country_code,
        offer_sources_list=_fmt_list(city.offer_sources),
        national_sources_list=_fmt_list(city.national_sources),
        offer_guidance=city.offer_guidance,
        target_desc=MODE_TARGET_DESC["offers"],
        common_rules=COMMON_RULES,
    )


def build_whats_on_system_prompt(city: CityHappeningsConfig) -> str:
    return WHATS_ON_SYSTEM_TEMPLATE.format(
        city=city.city,
        region=city.region,
        country_code=city.country_code,
        whats_on_fixtures_list=_fmt_list(city.whats_on_fixtures),
        whats_on_guidance=city.whats_on_guidance,
        whats_on_sources_list=_fmt_list(city.whats_on_sources),
        national_sources_list=_fmt_list(city.national_sources),
        target_desc=MODE_TARGET_DESC["whats-on"],
        common_rules=COMMON_RULES,
    )


def build_book_early_system_prompt(city: CityHappeningsConfig) -> str:
    return BOOK_EARLY_SYSTEM_TEMPLATE.format(
        city=city.city,
        region=city.region,
        country_code=city.country_code,
        book_early_fixtures_list=_fmt_list(city.book_early_fixtures),
        book_early_guidance=city.book_early_guidance,
        book_early_sources_list=_fmt_list(city.book_early_sources),
        national_sources_list=_fmt_list(city.national_sources),
        target_desc=MODE_TARGET_DESC["book-early"],
        common_rules=COMMON_RULES,
    )


def build_initial_user_prompt(mode: str, city: CityHappeningsConfig) -> str:
    if mode == "calendar":
        return (
            f"Research dated one-off and annual-fixture happenings in {city.city}, {city.region} "
            f"for the next 12 months. Start with the named known_fixtures list before any broader "
            f"search."
        )
    if mode == "whats-on":
        fixtures_count = len(city.whats_on_fixtures)
        return (
            f"Research recurring/regular things locals often don't know about in {city.city}, "
            f"{city.region}. There are {fixtures_count} named items in the known list, spanning "
            f"FOUR different categories. Work through them in THIS order, spending your search "
            f"budget on all four rather than exhausting it on the first one or two — parkruns and "
            f"walking tours are the easiest to confirm, so do them LAST, briefly, and only if "
            f"budget remains:\n"
            f"  1. Free guided nature walks FIRST (Royal Botanic Garden Edinburgh's own guided "
            f"     walks programme, Water of Leith Conservation Trust guided walks) — search "
            f"     each by name, on rbge.org.uk and waterofleith.org.uk specifically.\n"
            f"  2. Markets and museum/gallery lates or free talks SECOND (farmers market, "
            f"     Stockbridge Market, National Museum of Scotland, National Galleries of "
            f"     Scotland) — search each by name.\n"
            f"  3. Free/tip-based walking tours THIRD (Edinburgh Free Tour, Sandemans) — one or "
            f"     two searches is enough, this category is well-documented online.\n"
            f"  4. Parkruns LAST (Cramond, Portobello, Holyrood) — one search per venue is "
            f"     enough, parkrun.org.uk pages are short and load fast.\n"
            f"It's fine to end up with no row for a specific named item if you genuinely find no "
            f"current evidence, but you must actually search across all four categories in the "
            f"order above, not spend your whole budget confirming the easy ones first. Only after "
            f"covering all four, do a few broader searches to catch anything else genuinely worth "
            f"surfacing."
        )
    if mode == "book-early":
        return (
            f"Research upcoming bookable events/festivals/tours in {city.city}, {city.region} "
            f"over the next ~12 months where booking ahead matters. Start with the named fixtures "
            f"list, and get booking_opens_at (with exact time when published) right above all "
            f"else."
        )
    return (
        f"Research rolling venue deals and standing discounts in {city.city}, {city.region}. "
        f"Most of these will have no fixed date — focus on recurrence and exact promo codes."
    )


FINAL_SUBMIT_PROMPT = (
    "You've finished researching. Call submit_happenings now with every genuine happening you "
    "found and verified, following the ten rules above exactly — especially: never invent a "
    "date, never construct a promo code, and prefer null over guessing on any field."
)

FINAL_VERIFY_PROMPT = (
    "You've finished checking. Call submit_verifications now with one entry per worklist item, "
    "matched by slug, following the still_live / changes guidance above."
)


# --- submit_happenings tool schema ------------------------------------------

RECURRENCE_DESCRIPTION = (
    "A plain flat object describing when this happening recurs — deliberately NOT a nested "
    "oneOf/anyOf schema (models emit garbage for those); the shape is validated in Python after "
    "you submit, so match one of these exactly:\n"
    '  {"type":"once"} — a single dated occurrence (the actual date goes in starts_at/ends_at).\n'
    '  {"type":"always"} — a standing offer with no expiry.\n'
    '  {"type":"weekly","days":[0-6,...],"until":"YYYY-MM-DD"|null} — recurs on these weekdays, '
    "0=Sunday, until an optional end date.\n"
    '  {"type":"annual","month":1-12,"day":1-31,"endDay":1-31|null} — recurs on this date every '
    "year, optionally spanning to endDay within the same month.\n"
    '  {"type":"dates","dates":["YYYY-MM-DD",...]} — a fixed, explicitly announced set of dates.\n'
    "Never invent a date to fill one of these shapes — if you genuinely don't know it, use "
    '"once" with starts_at left null plus a time_note, or "always" for a standing offer.'
)

HAPPENING_SCHEMA = {
    "type": "object",
    "properties": {
        "slug": {
            "type": "string",
            "description": (
                "Kebab-case, scope-prefixed identifier, e.g. 'national-cinema-weekend-uk' or "
                "'venue-brewdog-2-for-1-mondays'. Leave blank to have it derived from scope+title."
            ),
        },
        "title": {"type": "string", "description": "<=8 words."},
        "summary": {
            "type": "string",
            "description": "One sentence, in your own words — do not copy source prose verbatim.",
        },
        "kind": {"type": "string", "enum": list(KIND_ENUM)},
        "category": {"type": "string", "enum": list(CATEGORY_ENUM)},
        "scope": {"type": "string", "enum": list(SCOPE_ENUM)},
        "editorial_tag": {"type": ["string", "null"], "description": "Short editorial hook, e.g. 'Locals only', 'Ends this weekend'."},
        "saving_label": {
            "type": ["string", "null"],
            "description": "The source's OWN figure, verbatim, e.g. '£4 tickets', '2-for-1', '£5 off'. Never your own paraphrase or estimate.",
        },
        "saving_amount": {"type": ["number", "null"]},
        "currency": {"type": ["string", "null"], "description": "ISO 4217, e.g. GBP."},
        "is_free": {"type": ["boolean", "null"]},
        "promo_code": {
            "type": ["string", "null"],
            "description": (
                "VERBATIM from the source page, exact case. Null if no code is printed. NEVER "
                "construct, guess, or normalise one."
            ),
        },
        "redemption_note": {"type": ["string", "null"]},
        "eligibility": {"type": "string", "enum": list(ELIGIBILITY_ENUM)},
        "family_fit": {"type": ["string", "null"], "enum": list(FAMILY_FIT_ENUM) + [None], "description": FAMILY_FIT_DESCRIPTION},
        "eligibility_note": {"type": ["string", "null"]},
        "allowance_note": {"type": ["string", "null"], "description": "e.g. 'max 2 tickets per household'."},
        "starts_at": {
            "type": ["string", "null"],
            "description": "ISO 8601, ONLY when the source states an exact date. Otherwise null.",
        },
        "ends_at": {
            "type": ["string", "null"],
            "description": "ISO 8601, ONLY when the source states an exact date. Otherwise null.",
        },
        "recurrence": {
            "type": "object",
            "description": RECURRENCE_DESCRIPTION,
            "properties": {
                "type": {"type": "string", "enum": list(RECURRENCE_TYPES)},
                "days": {"type": "array", "items": {"type": "integer"}},
                "until": {"type": ["string", "null"]},
                "month": {"type": "integer"},
                "day": {"type": "integer"},
                "endDay": {"type": ["integer", "null"]},
                "dates": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["type"],
        },
        "time_note": {"type": ["string", "null"], "description": "Display only, never parsed programmatically."},
        "booking_opens_at": {
            "type": ["string", "null"],
            "description": (
                "ISO 8601 WITH TIME AND THE Europe/London OFFSET when a source states an exact "
                "ticket-release moment (date AND time), e.g. '2026-10-01T10:00:00+01:00'. If only "
                "a bare date is published, use that date at 00:00 and note the imprecision in "
                "time_note. Null means already on general sale / no booking needed — never a "
                "placeholder for 'unknown'."
            ),
        },
        "sellout_risk": {
            "type": ["string", "null"],
            "enum": list(SELLOUT_RISK_ENUM) + [None],
            "description": (
                "high | medium | low, ONLY when sellout_note cites a real source for it. Null "
                "means no sell-out evidence found — not 'low risk'. Never inferred from venue "
                "popularity alone."
            ),
        },
        "sellout_note": {
            "type": ["string", "null"],
            "description": (
                "Display copy citing the source's own fact, e.g. 'Sold out within 10 days in "
                "2025'. Also the place for a stated presale-vs-general-sale distinction. Never "
                "set without sellout_risk, never invented."
            ),
        },
        "venue_name": {"type": ["string", "null"]},
        "address": {"type": ["string", "null"]},
        "district": {"type": ["string", "null"], "description": "e.g. 'Old Town', 'Leith Shore'."},
        "city": {"type": ["string", "null"]},
        "region": {"type": ["string", "null"]},
        "country_code": {"type": ["string", "null"]},
        "lat": {"type": ["number", "null"]},
        "lng": {"type": ["number", "null"]},
        "booking_url": {"type": ["string", "null"], "description": "Where you redeem — DISTINCT from source_url."},
        "cta_label": {"type": ["string", "null"]},
        "source_name": {"type": ["string", "null"]},
        "source_url": {"type": ["string", "null"], "description": "The page that states the terms."},
        "source_urls": {"type": "array", "items": {"type": "string"}},
        "field_sources": {
            "type": "object",
            "description": "Maps each populated factual field name to the URL that supports it.",
        },
        "confidence": {"type": "string", "enum": list(CONFIDENCE_ENUM)},
        "priority": {
            "type": "integer",
            "description": "0-100, 50 is neutral. 80+ reserved for once-a-year, city-wide fixtures.",
        },
    },
    "required": ["title", "kind", "category", "scope", "eligibility", "source_urls", "field_sources"],
}

SUBMIT_TOOL = {
    "name": "submit_happenings",
    "description": "Submit the researched happenings for this city, once research is complete.",
    "input_schema": {
        "type": "object",
        "properties": {"happenings": {"type": "array", "items": HAPPENING_SCHEMA}},
        "required": ["happenings"],
    },
}

VERIFICATION_SCHEMA = {
    "type": "object",
    "properties": {
        "slug": {"type": "string"},
        "still_live": {"type": "boolean"},
        "changes": {"type": ["string", "null"], "description": "Short note on what changed, or null."},
    },
    "required": ["slug", "still_live"],
}

VERIFY_TOOL = {
    "name": "submit_verifications",
    "description": "Submit re-verification results for this worklist of happenings.",
    "input_schema": {
        "type": "object",
        "properties": {"verifications": {"type": "array", "items": VERIFICATION_SCHEMA}},
        "required": ["verifications"],
    },
}


# --- generic two-phase agentic-research + forced-submit loop ---------------
# Mirrors discover_and_extract_city.py's research_and_extract_city() exactly
# (open research loop with pause_turn resume handling, then one forced
# tool-use call for structured output), generalized so calendar/offers/verify
# share one implementation instead of three near-identical copies.


def run_research_and_submit(
    client: Any,
    model: str,
    system_prompt: str,
    initial_user_prompt: str,
    max_searches: int,
    submit_tool: dict[str, Any],
    final_submit_prompt: str,
    result_list_key: str,
    label: str,
    research_max_tokens: int = RESEARCH_MAX_TOKENS,
) -> list[dict[str, Any]]:
    search_tool = web_search_tool_for_model(model, max_searches)
    messages: list[dict[str, Any]] = [{"role": "user", "content": initial_user_prompt}]

    # Phase 1: open research loop.
    resumes = 0
    while True:
        # RESEARCH_CALL_KWARGS disables thinking: DeepSeek ignores
        # thinking.budget_tokens, so thinking can't be capped and would eat
        # RESEARCH_MAX_TOKENS. See scraper/llm_client.py.
        #
        # Streamed (like the submit call below): a wide research budget
        # (RESEARCH_MAX_TOKENS_WIDE, used by whats-on/book-early) trips the
        # SDK's "Streaming is required for operations that may take longer
        # than 10 minutes" guard on a plain .create() call. Streaming removes
        # that cap; it changes nothing else about the response we get back.
        with client.messages.stream(
            model=model,
            max_tokens=research_max_tokens,
            system=system_prompt,
            tools=[search_tool],
            messages=messages,
            **RESEARCH_CALL_KWARGS,
        ) as stream:
            response = stream.get_final_message()

        if response.stop_reason == "refusal":
            raise RuntimeError(f"research call refused for {label}")

        if response.stop_reason == "pause_turn":
            resumes += 1
            messages.append({"role": "assistant", "content": response.content})
            if resumes > MAX_PAUSE_RESUMES:
                print(
                    f"[happenings-research] {label}: hit max pause_turn resumes "
                    f"({MAX_PAUSE_RESUMES}), proceeding to submission with research so far.",
                    file=sys.stderr,
                )
                break
            continue

        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason == "max_tokens":
            print(
                f"[happenings-research] {label}: research response hit max_tokens; "
                "proceeding to submission with research so far.",
                file=sys.stderr,
            )
        break

    # Phase 2: forced submit call.
    #
    # A research response cut off at max_tokens can end with a search call that
    # never got its result, and the provider then rejects the whole history.
    # Prune those first — here only, never between pause_turn resumes.
    messages = sanitize_history(messages)
    messages.append({"role": "user", "content": final_submit_prompt})

    nudges = 0
    while True:
        # SUBMIT_CALL_KWARGS disables thinking: DeepSeek's deepseek-flash thinks
        # by default and rejects a forced tool_choice in thinking mode (400).
        # Disabling it is equally valid on Anthropic. See scraper/llm_client.py.
        with client.messages.stream(
            model=model,
            max_tokens=SUBMIT_MAX_TOKENS,
            system=system_prompt,
            tools=[submit_tool],
            tool_choice={"type": "tool", "name": submit_tool["name"]},
            messages=messages,
            **SUBMIT_CALL_KWARGS,
        ) as stream:
            submit_response = stream.get_final_message()

        if submit_response.stop_reason == "refusal":
            raise RuntimeError(f"{submit_tool['name']} call refused for {label}")

        tool_use = next((b for b in submit_response.content if b.type == "tool_use"), None)
        if tool_use is not None:
            result = tool_use.input
            if not isinstance(result, dict) or not isinstance(result.get(result_list_key), list):
                raise RuntimeError(f"{submit_tool['name']} returned an unexpected shape for {label}")
            return [item for item in result[result_list_key] if isinstance(item, dict)]

        nudges += 1
        if nudges > MAX_SUBMIT_NUDGES:
            raise RuntimeError(
                f"model never called {submit_tool['name']} for {label} after {MAX_SUBMIT_NUDGES} "
                f"nudges (stop_reason={submit_response.stop_reason!r})"
            )
        messages.append({"role": "assistant", "content": submit_response.content})
        messages.append({"role": "user", "content": final_submit_prompt})


# --- validation --------------------------------------------------------

_PLACEHOLDER_CODE_RE = re.compile(r"^[<\[{X*]|CODE|XXXX", re.IGNORECASE)


def is_placeholder_promo_code(code: str) -> bool:
    """True for a whitespace-only code, or one matching the ^[<\\[{X*]|CODE|XXXX
    placeholder pattern from the spec (a model-hallucinated 'YOURCODEHERE',
    '<code>', 'XXXX-XXXX' etc. rather than a real printed code)."""
    stripped = code.strip()
    if not stripped:
        return True
    return bool(_PLACEHOLDER_CODE_RE.search(stripped))


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    v = value.strip()
    if v.endswith("Z"):
        v = v[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def validate_recurrence(rec: Any, has_real_date: bool) -> dict[str, Any] | None:
    """Normalizes/validates a recurrence object per the shapes documented in
    RECURRENCE_DESCRIPTION. Returns the normalized dict, {"type": "once"} as a
    coercion fallback when the row has a real starts_at/ends_at to fall back
    on, or None (meaning: drop the row) when it doesn't."""
    fallback = {"type": "once"} if has_real_date else None

    if not isinstance(rec, dict):
        return fallback
    rec_type = rec.get("type")
    if rec_type not in RECURRENCE_TYPES:
        return fallback

    if rec_type in ("once", "always"):
        return {"type": rec_type}

    if rec_type == "weekly":
        days = rec.get("days")
        if not isinstance(days, list) or not days:
            return fallback
        clean_days = [d for d in days if isinstance(d, int) and 0 <= d <= 6]
        if not clean_days:
            return fallback
        until = rec.get("until")
        out: dict[str, Any] = {"type": "weekly", "days": clean_days}
        out["until"] = until if isinstance(until, str) and until.strip() else None
        return out

    if rec_type == "annual":
        month, day = rec.get("month"), rec.get("day")
        if not (isinstance(month, int) and 1 <= month <= 12):
            return fallback
        if not (isinstance(day, int) and 1 <= day <= 31):
            return fallback
        out = {"type": "annual", "month": month, "day": day}
        end_day = rec.get("endDay")
        if isinstance(end_day, int) and 1 <= end_day <= 31:
            out["endDay"] = end_day
        return out

    if rec_type == "dates":
        dates = rec.get("dates")
        if not isinstance(dates, list):
            return fallback
        clean_dates = [d for d in dates if isinstance(d, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", d)]
        if not clean_dates:
            return fallback
        return {"type": "dates", "dates": clean_dates}

    return fallback  # pragma: no cover — unreachable given the RECURRENCE_TYPES check above


def _clean_text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _clean_date(value: Any) -> str | None:
    """YYYY-MM-DD or None (season_valid_until is a plain date column)."""
    if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()):
        return value.strip()
    return None


def coerce_family_fit(raw: Any, eligibility: str, category: str, label: str = "") -> str | None:
    """family_fit is a soft hint: a value outside the enum becomes null (the row is kept).
    Post-rules: eligibility 'family' forces 'kids'; category 'family' with no usable
    family_fit becomes 'kids'."""
    value = raw if raw in FAMILY_FIT_ENUM else None
    if raw not in (None, "") and value is None:
        print(f"[happenings-research] {label!r}: invalid family_fit {raw!r} - nulling it, keeping the row", file=sys.stderr)
    if eligibility == "family":
        return "kids"
    if value is None and category == "family":
        return "kids"
    return value


def build_full_record(
    happening: dict[str, Any],
    batch_id: str,
    city: CityHappeningsConfig,
    mode: str,
    model: str,
    now: str,
) -> dict[str, Any] | None:
    title = str(happening.get("title") or "").strip()
    label = title or "(untitled)"

    source_urls = happening.get("source_urls")
    field_sources = happening.get("field_sources")
    if not isinstance(source_urls, list) or not source_urls:
        print(f"[happenings-research] dropping {label!r}: no source_urls", file=sys.stderr)
        return None
    if not isinstance(field_sources, dict) or not field_sources:
        print(f"[happenings-research] dropping {label!r}: no field_sources", file=sys.stderr)
        return None

    kind = str(happening.get("kind") or "")
    if kind not in KIND_ENUM:
        print(f"[happenings-research] dropping {label!r}: invalid kind {kind!r}", file=sys.stderr)
        return None

    scope = str(happening.get("scope") or "")
    if scope not in SCOPE_ENUM:
        print(f"[happenings-research] dropping {label!r}: invalid scope {scope!r}", file=sys.stderr)
        return None

    eligibility = str(happening.get("eligibility") or "")
    if eligibility not in ELIGIBILITY_ENUM:
        print(f"[happenings-research] dropping {label!r}: invalid eligibility {eligibility!r}", file=sys.stderr)
        return None

    category = str(happening.get("category") or "")
    if category not in CATEGORY_ENUM:
        print(f"[happenings-research] dropping {label!r}: invalid category {category!r}", file=sys.stderr)
        return None

    family_fit = coerce_family_fit(happening.get("family_fit"), eligibility, category, label)

    # happenings.source_name is NOT NULL in supabase/archive/add_happenings.sql (it's
    # rendered on every card) even though submit_happenings' own schema
    # doesn't force the model to populate it — enforce it here instead of
    # letting a null slip through to a promotion-time DB error.
    source_name = happening.get("source_name")
    if not (isinstance(source_name, str) and source_name.strip()):
        print(f"[happenings-research] dropping {label!r}: missing source_name (required, rendered on every card)", file=sys.stderr)
        return None

    starts_at = happening.get("starts_at") if isinstance(happening.get("starts_at"), str) else None
    ends_at = happening.get("ends_at") if isinstance(happening.get("ends_at"), str) else None
    has_real_date = bool(starts_at or ends_at)

    recurrence = validate_recurrence(happening.get("recurrence"), has_real_date)
    if recurrence is None:
        print(f"[happenings-research] dropping {label!r}: invalid recurrence and no real date to fall back on", file=sys.stderr)
        return None

    if recurrence["type"] == "once":
        check_date = _parse_iso(ends_at or starts_at)
        if check_date is not None and check_date < datetime.now(timezone.utc):
            print(f"[happenings-research] dropping {label!r}: one-off happening's date is in the past", file=sys.stderr)
            return None

    promo_code = happening.get("promo_code")
    if isinstance(promo_code, str) and promo_code.strip():
        if is_placeholder_promo_code(promo_code):
            print(
                f"[happenings-research] {label!r}: promo_code looked like a placeholder "
                f"({promo_code!r}) — nulling it, keeping the row",
                file=sys.stderr,
            )
            promo_code = None
    else:
        promo_code = None

    confidence = happening.get("confidence")
    if confidence not in CONFIDENCE_ENUM:
        confidence = "low"

    # booking_opens_at must parse as a real timestamp or it's dropped (never
    # silently kept as a malformed string) — null is the correct value for
    # "already on sale", so an unparsable non-null value is a model error,
    # not something to coerce into a fallback.
    booking_opens_at_raw = happening.get("booking_opens_at")
    booking_opens_at = None
    if isinstance(booking_opens_at_raw, str) and booking_opens_at_raw.strip():
        if _parse_iso(booking_opens_at_raw) is not None:
            booking_opens_at = booking_opens_at_raw.strip()
        else:
            print(
                f"[happenings-research] {label!r}: booking_opens_at {booking_opens_at_raw!r} "
                "did not parse as ISO 8601 — nulling it, keeping the row",
                file=sys.stderr,
            )

    # sellout_risk/sellout_note are a pair: strictly source-backed per the
    # book-early prompt, so a risk level with no supporting note (or vice
    # versa) is treated as unsupported and dropped rather than kept half-set.
    sellout_risk = happening.get("sellout_risk")
    sellout_note = happening.get("sellout_note")
    sellout_note = sellout_note.strip() if isinstance(sellout_note, str) and sellout_note.strip() else None
    if sellout_risk not in SELLOUT_RISK_ENUM or sellout_note is None:
        if sellout_risk in SELLOUT_RISK_ENUM or sellout_note is not None:
            print(
                f"[happenings-research] {label!r}: sellout_risk/sellout_note only one was set "
                "(must both be present and sourced) — nulling both, keeping the row",
                file=sys.stderr,
            )
        sellout_risk = None
        sellout_note = None

    priority = happening.get("priority")
    if not isinstance(priority, int) or not (0 <= priority <= 100):
        priority = 50

    slug = str(happening.get("slug") or "").strip()
    if not slug:
        slug = slugify(f"{scope}-{title}")

    # happenings.city is null at region/national scope (see add_happenings.sql's
    # `scope` column comment) — a scope='region'/'national' row like Doors
    # Open Days or National Cinema Weekend must not have a city read-path
    # silently swallow it.
    city_value = happening.get("city") or (None if scope in ("region", "national") else city.city)

    return {
        "batch_id": batch_id,
        "research_mode": mode,
        "slug": slug,
        "title": title,
        "summary": happening.get("summary"),
        "kind": kind,
        "category": category,
        "scope": scope,
        "editorial_tag": happening.get("editorial_tag"),
        "saving_label": happening.get("saving_label"),
        "saving_amount": happening.get("saving_amount") if isinstance(happening.get("saving_amount"), (int, float)) else None,
        "currency": happening.get("currency") or city.currency,
        "is_free": happening.get("is_free") if isinstance(happening.get("is_free"), bool) else None,
        "promo_code": promo_code,
        "redemption_note": happening.get("redemption_note"),
        "eligibility": eligibility,
        "family_fit": family_fit,
        "eligibility_note": happening.get("eligibility_note"),
        "allowance_note": happening.get("allowance_note"),
        # Not part of HAPPENING_SCHEMA (the topic prompts never ask for them):
        # only the page-grounded deal sources (scraper/deal_sources/) fill these,
        # each backed by a verbatim page quote.
        "price_text": _clean_text(happening.get("price_text")),
        "includes": _clean_text(happening.get("includes")),
        "season_valid_until": _clean_date(happening.get("season_valid_until")),
        "starts_at": starts_at,
        "ends_at": ends_at,
        "recurrence": recurrence,
        "time_note": happening.get("time_note"),
        "booking_opens_at": booking_opens_at,
        "sellout_risk": sellout_risk,
        "sellout_note": sellout_note,
        "venue_name": happening.get("venue_name"),
        "address": happening.get("address"),
        "district": happening.get("district"),
        "city": city_value,
        "region": happening.get("region") or city.region,
        "country_code": happening.get("country_code") or city.country_code,
        "lat": happening.get("lat") if isinstance(happening.get("lat"), (int, float)) else None,
        "lng": happening.get("lng") if isinstance(happening.get("lng"), (int, float)) else None,
        "booking_url": happening.get("booking_url"),
        "cta_label": happening.get("cta_label"),
        "source_name": source_name,
        "source_url": happening.get("source_url") or source_urls[0],
        "source_urls": source_urls,
        "field_sources": field_sources,
        "confidence": confidence,
        "priority": priority,
        "extraction_model": model,
        "extraction_status": "extracted",
        "validation_errors": [],
        "approved": False,
        "status": "live",
        "verified_at": now,
    }


def build_verification_record(item: dict[str, Any], worklist_slugs: set[str], now: str) -> dict[str, Any] | None:
    slug = str(item.get("slug") or "").strip()
    if not slug or slug not in worklist_slugs:
        print(f"[happenings-research] dropping verification result for unrecognized slug {item.get('slug')!r}", file=sys.stderr)
        return None
    still_live = item.get("still_live")
    if not isinstance(still_live, bool):
        print(f"[happenings-research] dropping verification result for {slug!r}: still_live not a bool", file=sys.stderr)
        return None
    changes = item.get("changes") if isinstance(item.get("changes"), str) and item.get("changes").strip() else None
    return {"slug": slug, "still_live": still_live, "verified_at": now, "changes": changes}


# --- main --------------------------------------------------------------


def _load_worklist(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.worklist:
        raw = Path(args.worklist).read_text()
    else:
        print("[happenings-research] reading worklist JSON from stdin (use --worklist to read a file instead)...", file=sys.stderr)
        raw = sys.stdin.read()
    if not raw.strip():
        return []
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("worklist JSON must be a list of {slug, source_url, title} objects")
    return [item for item in data if isinstance(item, dict) and item.get("slug")]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Research Edinburgh (or another configured city's) happenings via Claude or DeepSeek + "
        "web_search, in calendar / offers / whats-on / book-early / verify mode."
    )
    parser.add_argument("--city", default="edinburgh", choices=sorted(CITIES), help="City config to use.")
    parser.add_argument(
        "--mode", required=True,
        choices=["calendar", "offers", "whats-on", "book-early", "verify"],
    )
    parser.add_argument("--batch-id", required=True, help="Batch identifier, e.g. edi-happenings-2026-09-12")
    parser.add_argument("--limit", type=int, default=None, help="Cap the number of items processed this run.")
    parser.add_argument("--model", default=os.environ.get("HAPPENINGS_RESEARCH_MODEL", DEFAULT_MODEL))
    parser.add_argument("--dry-run", action="store_true", help="Build prompts/config and exit — no API calls, no file written.")
    parser.add_argument("--out", type=Path, default=None, help="Override the output JSON path.")
    parser.add_argument(
        "--worklist", type=Path, default=None,
        help="verify mode only: path to worklist JSON (default: read from stdin).",
    )
    args = parser.parse_args()

    city = get_city(args.city)
    output_path = args.out or (DEFAULT_OUTPUT_ROOT / args.batch_id / f"{city.slug}-happenings-{args.mode}.json")

    if args.mode in ("calendar", "offers", "whats-on", "book-early"):
        if args.mode == "calendar":
            system_prompt = build_calendar_system_prompt(city)
        elif args.mode == "offers":
            system_prompt = build_offers_system_prompt(city)
        elif args.mode == "whats-on":
            system_prompt = build_whats_on_system_prompt(city)
        else:
            system_prompt = build_book_early_system_prompt(city)
        initial_user_prompt = build_initial_user_prompt(args.mode, city)

        print(f"[happenings-research] city={city.city} mode={args.mode} model={args.model} batch={args.batch_id}")

        if args.dry_run:
            print(f"[happenings-research] DRY RUN — no API calls made, no file written.\n--- system prompt ---\n{system_prompt}")
            return

        # Provider (DeepSeek or Anthropic) is chosen by which key is set — see
        # scraper/llm_client.py for the precedence rule and the DeepSeek quirks.
        client, _provider = make_research_client("happenings-research")

        try:
            raw_happenings = run_research_and_submit(
                client, args.model, system_prompt, initial_user_prompt,
                MODE_MAX_SEARCHES[args.mode], SUBMIT_TOOL, FINAL_SUBMIT_PROMPT,
                "happenings", f"{city.city}/{args.mode}",
                research_max_tokens=(
                    RESEARCH_MAX_TOKENS_WIDE
                    if args.mode in ("whats-on", "book-early", "offers")
                    else RESEARCH_MAX_TOKENS
                ),
            )
        except Exception as exc:
            print(f"[happenings-research] ERROR {city.city}/{args.mode}: {exc}", file=sys.stderr)
            sys.exit(1)

        if args.limit is not None:
            raw_happenings = raw_happenings[: args.limit]

        now = datetime.now(timezone.utc).isoformat()
        records = []
        failed = 0
        for happening in raw_happenings:
            try:
                record = build_full_record(happening, args.batch_id, city, args.mode, args.model, now)
            except Exception as exc:
                failed += 1
                print(f"[happenings-research] error building record for {happening.get('title')!r}: {exc}", file=sys.stderr)
                continue
            if record is not None:
                records.append(record)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps({"records": records}, ensure_ascii=False, indent=2) + "\n")

        print(
            f"[happenings-research] {city.city}/{args.mode}: wrote {len(records)} record(s) to {output_path} "
            f"(raw candidates from model: {len(raw_happenings)})"
        )
        print(f"[happenings-research] succeeded={len(records)} failed={failed + (len(raw_happenings) - failed - len(records))}")
        return

    # mode == "verify"
    try:
        worklist = _load_worklist(args)
    except Exception as exc:
        print(f"[happenings-research] ERROR reading worklist: {exc}", file=sys.stderr)
        sys.exit(1)

    if args.limit is not None:
        worklist = worklist[: args.limit]

    print(f"[happenings-research] city={city.city} mode=verify model={args.model} batch={args.batch_id} items={len(worklist)}")

    if not worklist:
        print("[happenings-research] nothing to verify.")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps({"records": []}, ensure_ascii=False, indent=2) + "\n")
        return

    if args.dry_run:
        sample = ", ".join(str(i.get("slug")) for i in worklist[:5])
        print(f"[happenings-research] DRY RUN — no API calls made, no file written. {len(worklist)} item(s), e.g.: {sample}")
        return

    # Provider (DeepSeek or Anthropic) is chosen by which key is set — see
    # scraper/llm_client.py for the precedence rule and the DeepSeek quirks.
    client, _provider = make_research_client("happenings-research")

    worklist_slugs = {str(item["slug"]) for item in worklist}
    initial_user_prompt = (
        "Re-check this worklist of previously-recorded happenings against their sources:\n"
        + json.dumps(worklist, ensure_ascii=False)
    )

    try:
        raw_results = run_research_and_submit(
            client, args.model, VERIFY_SYSTEM_PROMPT, initial_user_prompt,
            MODE_MAX_SEARCHES["verify"], VERIFY_TOOL, FINAL_VERIFY_PROMPT,
            "verifications", f"{city.city}/verify",
        )
    except Exception as exc:
        print(f"[happenings-research] ERROR {city.city}/verify: {exc}", file=sys.stderr)
        sys.exit(1)

    now = datetime.now(timezone.utc).isoformat()
    records = []
    failed = 0
    for item in raw_results:
        try:
            record = build_verification_record(item, worklist_slugs, now)
        except Exception as exc:
            failed += 1
            print(f"[happenings-research] error building verification record: {exc}", file=sys.stderr)
            continue
        if record is not None:
            records.append(record)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps({"records": records}, ensure_ascii=False, indent=2) + "\n")

    print(f"[happenings-research] {city.city}/verify: wrote {len(records)} record(s) to {output_path}")
    print(f"[happenings-research] succeeded={len(records)} failed={failed + (len(worklist) - len(records) - failed)}")


if __name__ == "__main__":
    main()
