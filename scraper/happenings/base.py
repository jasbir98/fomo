"""Shared city-config contract for the happenings research pipeline.

Mirrors `scraper/countries/base.py`'s CountryConfig pattern: each city config
supplies only the pieces that differ per city (source domains, known named
fixtures, prompt-guidance fragments); the research loop, schema, and
validation rules stay in `scraper/happenings_research.py`.

Add a new city by creating `scraper/happenings/cities/<slug>.py` with a
`CityHappeningsConfig` instance and registering it in
`scraper/happenings/cities/__init__.py`.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class CityHappeningsConfig:
    # Stored in `happenings.city` / `happenings_staging.city`, used to build
    # the output filename `<slug>-happenings-<mode>.json`.
    slug: str
    # Human-readable city name used in prompts, e.g. "Edinburgh".
    city: str
    # Region/council area, e.g. "Scotland" — used for scope='region' rows.
    region: str
    # ISO 3166-1 alpha-2, e.g. "GB".
    country_code: str
    # IANA tz name, e.g. "Europe/London" — display/validation only, never
    # used to convert a source's stated date.
    timezone: str
    # ISO 4217, e.g. "GBP".
    currency: str
    # Postcode prefix that identifies a local resident for eligibility
    # checks that key off postcode (e.g. Mary King's Close's EHDISCOUNT),
    # e.g. "EH".
    local_postcode_prefix: str
    # Domains that publish dated one-off events / annual fixtures — the
    # `calendar` mode's preferred source list.
    calendar_sources: tuple[str, ...] = field(default_factory=tuple)
    # Domains that publish rolling venue deals/discounts — the `offers`
    # mode's preferred source list.
    offer_sources: tuple[str, ...] = field(default_factory=tuple)
    # Domains for UK/national-scope happenings that apply in this city
    # (national chains, national heritage bodies) — used by both modes.
    national_sources: tuple[str, ...] = field(default_factory=tuple)
    # Named fixtures to search for individually by name (see
    # happenings_research.py's calendar prompt) — named search targets
    # massively outperform an open-ended "find events in <city>" query, and
    # this is the direct fix for missing e.g. National Cinema Weekend.
    known_fixtures: tuple[str, ...] = field(default_factory=tuple)
    # Extra prompt guidance specific to the `calendar` mode for this city.
    calendar_guidance: str = ""
    # Extra prompt guidance specific to the `offers` mode for this city.
    offer_guidance: str = ""

    # --- whats-on mode: recurring/regular things locals often don't know about ---
    # Domains for parkruns, walking tours, museum lates, markets, guided walks.
    whats_on_sources: tuple[str, ...] = field(default_factory=tuple)
    # Named recurring things to search for individually (parkrun venues, named
    # walking tours, named markets) — same "named search beats open query"
    # reasoning as known_fixtures above.
    whats_on_fixtures: tuple[str, ...] = field(default_factory=tuple)
    # Extra prompt guidance specific to the `whats-on` mode for this city.
    whats_on_guidance: str = ""

    # --- book-early mode: upcoming bookable things where booking ahead matters ---
    # Domains for festival/venue ticketing, official event pages.
    book_early_sources: tuple[str, ...] = field(default_factory=tuple)
    # Named upcoming fixtures to search for individually (Hogmanay, Fringe,
    # Tattoo, recurring big-ticket concerts/fixtures).
    book_early_fixtures: tuple[str, ...] = field(default_factory=tuple)
    # Extra prompt guidance specific to the `book-early` mode for this city.
    book_early_guidance: str = ""
