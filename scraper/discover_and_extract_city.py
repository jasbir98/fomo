#!/usr/bin/env python3
"""
discover_and_extract_city.py — Stage 2 of the places pipeline: for a single
city, researches genuine tourist places directly via the Anthropic API's
server-side web_search tool and extracts them into Roameo's places_staging
record shape, writing `scraper/out/<batch-id>/<city-slug>.json` as
`{"records": [...]}`.

Country-specific data (category examples, source guidance — see
`--country`) lives in `scraper/countries/`; the `--region` choices are also
derived from that country's config. Everything else in this script is
country-agnostic.

Why this exists instead of a spawned research subagent: this stage used to be
one Sonnet Agent-tool subagent per city doing manual web research. The plan
is to move this bulk research work to Haiku, but a spawned Haiku Agent-tool
subagent reliably fails in this environment — its 200K context window can't
hold the inherited MCP toolset and errors "prompt too long" before it does
any work. This script does the same job as a per-city research subagent, but
as a plain Python script calling the Anthropic API directly (no Agent tool,
no subagent spawning) — it never inherits any MCP toolset, so it sidesteps
the failure entirely. It supersedes per-city Sonnet subagents starting wave 2
of the Tokyo/Kanto pipeline (see JAPAN_PLACES_PIPELINE.md).

Mirrors the conventions of discover_cities.py (.env loading, Anthropic client
init, DEFAULT_MODEL, forced tool-use JSON output) and reuses the citation
rules and dedupe-key slugification from japan_place_extract.py. Unlike
japan_place_extract.py — which extracts from pre-fetched source text — this
script does its own live web research via the API's server-side web_search
tool, in an open (auto tool-choice) agentic loop, then makes one final
forced tool-use call to get structured output once research is done.

Usage:
    python scraper/discover_and_extract_city.py \\
        --country japan --city Nagatoro --prefecture Saitama --region Kanto \\
        --tier mid --batch-id jp-saitama-wave2-2026-07-24

    python scraper/discover_and_extract_city.py \\
        --country scotland --city Portree --prefecture Highland \\
        --region "Highlands" --tier mid --batch-id scot-highland-pilot-2026-07-25
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
from countries import CountryConfig, COUNTRIES, get_country  # noqa: E402

DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_OUTPUT_ROOT = SCRAPER_DIR / "out"

# Target place counts per tier. "minor" is a range in the brief (15-20); we
# use the top of the range as the nominal target shown to the model and for
# logging, but never force-pad — a genuinely small city returns fewer.
TIER_TARGET_COUNT: dict[str, int] = {"major": 40, "mid": 30, "minor": 20}
TIER_TARGET_DESC: dict[str, str] = {
    "major": "around 40",
    "mid": "around 30",
    "minor": "15 to 20",
}

# Bounds how many web_search calls Claude may issue per city, scaled to tier
# so a "minor" town doesn't burn the same search budget as a "major" city.
TIER_MAX_SEARCHES: dict[str, int] = {"major": 25, "mid": 18, "minor": 12}

# Models that support the dynamic-filtering web_search_20260209 server tool
# (per the claude-api skill's Server Tools reference). Everything else,
# including this script's default claude-haiku-4-5, uses the basic
# web_search_20250305 variant.
_DYNAMIC_FILTERING_MODEL_PREFIXES = (
    "claude-sonnet-4-6",
    "claude-sonnet-5"
)

RESEARCH_MAX_TOKENS = 8000
SUBMIT_MAX_TOKENS = 16000
MAX_PAUSE_RESUMES = 6
MAX_SUBMIT_NUDGES = 2


def web_search_tool_for_model(model: str, max_uses: int) -> dict[str, Any]:
    if model.startswith(_DYNAMIC_FILTERING_MODEL_PREFIXES):
        return {"type": "web_search_20260209", "name": "web_search", "max_uses": max_uses}
    return {"type": "web_search_20250305", "name": "web_search", "max_uses": max_uses}


# --- dedupe key (must match japan_place_extract.py's normalize_key exactly) ---


def normalize_key(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unknown"


def build_dedupe_key(name: str, prefecture: str, city: str) -> str:
    return f"name:{normalize_key(prefecture)}:{normalize_key(city)}:{normalize_key(name)}"


# --- prompts -------------------------------------------------------------


SYSTEM_PROMPT_TEMPLATE = """You are researching tourist-relevant places in {city}, {prefecture}, {country} ({region} region) for a travel app.

Your job in this conversation:
1. Use the web_search tool to research genuine tourist attractions and similar sights in {city}, such as {category_examples}. {source_guidance}
2. Aim for {target_desc} places, but do not pad the list — if {city} genuinely has fewer notable places, return fewer. Do not invent places to hit a count.
3. EXCLUDE restaurants, cafes, bars, and any food or dining establishments entirely. This batch covers attractions only — never use category="food" or any restaurant-type category.
4. Every factual field (description, hours, station, coordinates, address) must be traceable to a source URL you found via web_search. If a fact is not explicitly supported by a source you found, leave that field null (or "unknown" for hours) rather than guessing.
5. Do not invent opening hours, coordinates, or station proximity.
6. Photos: only include a photo if you found one on Wikimedia Commons with a clear url, license, credit, and source_url. Otherwise set photo to null.
7. Write short, neutral descriptions in your own words based on cited facts — do not copy source prose verbatim.
8. category must be lowercase — one of: {category_examples}, or a similarly specific non-food category. Never "food" or any restaurant/dining category.
9. field_sources must map each factual field name you populated (e.g. "description", "hours", "station", "lat", "lng", "address") to the source URL that supports it.

Once you have completed your research, call the submit_places tool with the full list of records. Do not call submit_places until you are done researching.
"""

FINAL_SUBMIT_PROMPT = (
    "You've finished researching. Call submit_places now with every genuine tourist place you "
    "found, following the citation and category rules above. Do not include restaurants, cafes, "
    "or any food/dining establishments."
)


def build_system_prompt(country: CountryConfig, city: str, prefecture: str, region: str, tier: str) -> str:
    return SYSTEM_PROMPT_TEMPLATE.format(
        city=city,
        prefecture=prefecture,
        region=region,
        country=country.name,
        target_desc=TIER_TARGET_DESC[tier],
        category_examples=country.category_examples,
        source_guidance=country.source_guidance,
    )


def build_initial_user_prompt(country: CountryConfig, city: str, prefecture: str, region: str, tier: str) -> str:
    return (
        f"Research tourist-relevant places in {city}, {prefecture}, {country.name} ({region} region). "
        f"Tier: {tier} (target {TIER_TARGET_DESC[tier]} places). Search the web for candidates, "
        f"verify facts against what you find, and exclude restaurants/food entirely."
    )


# --- submit_places tool schema --------------------------------------------

PLACE_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "category": {
            "type": "string",
            "description": "Lowercase, non-food category, e.g. attraction, shrine, temple, park, museum, viewpoint, market, landmark, garden.",
        },
        "description": {"type": "string"},
        "tips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "source_url": {"type": "string"},
                },
                "required": ["text", "source_url"],
            },
        },
        "hours": {"type": ["string", "null"]},
        "hours_status": {"type": "string", "enum": ["known", "unknown"]},
        "station": {"type": ["string", "null"]},
        "lat": {"type": ["number", "null"]},
        "lng": {"type": ["number", "null"]},
        "address": {"type": ["string", "null"]},
        "source_urls": {"type": "array", "items": {"type": "string"}},
        "field_sources": {"type": "object"},
        "photo": {
            "type": ["object", "null"],
            "properties": {
                "url": {"type": "string"},
                "license": {"type": "string"},
                "credit": {"type": "string"},
                "source_url": {"type": "string"},
            },
        },
    },
    "required": ["name", "category", "description", "source_urls", "field_sources"],
}

SUBMIT_TOOL = {
    "name": "submit_places",
    "description": "Submit the researched tourist places for this city, once research is complete.",
    "input_schema": {
        "type": "object",
        "properties": {"places": {"type": "array", "items": PLACE_SCHEMA}},
        "required": ["places"],
    },
}


# --- research + extraction loop -------------------------------------------


def research_and_extract_city(
    client: Any,
    model: str,
    country: CountryConfig,
    city: str,
    prefecture: str,
    region: str,
    tier: str,
) -> list[dict[str, Any]]:
    system_prompt = build_system_prompt(country, city, prefecture, region, tier)
    search_tool = web_search_tool_for_model(model, TIER_MAX_SEARCHES[tier])

    messages: list[dict[str, Any]] = [
        {"role": "user", "content": build_initial_user_prompt(country, city, prefecture, region, tier)}
    ]

    # Phase 1: open research loop. web_search is a server tool, so Claude can
    # issue many searches within a single response; we only need to handle
    # pause_turn (the server-side search loop hit its internal iteration cap)
    # by re-sending to let it continue.
    resumes = 0
    while True:
        response = client.messages.create(
            model=model,
            max_tokens=RESEARCH_MAX_TOKENS,
            system=system_prompt,
            tools=[search_tool],
            messages=messages,
        )

        if response.stop_reason == "refusal":
            raise RuntimeError(f"research call refused for {city}, {prefecture}")

        if response.stop_reason == "pause_turn":
            resumes += 1
            messages.append({"role": "assistant", "content": response.content})
            if resumes > MAX_PAUSE_RESUMES:
                print(
                    f"[discover-extract] {city}: hit max pause_turn resumes ({MAX_PAUSE_RESUMES}), "
                    "proceeding to submission with research so far.",
                    file=sys.stderr,
                )
                break
            continue

        # end_turn, max_tokens, or anything else: research phase is done.
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason == "max_tokens":
            print(
                f"[discover-extract] {city}: research response hit max_tokens; "
                "proceeding to submission with research so far.",
                file=sys.stderr,
            )
        break

    # Phase 2: forced submit_places call. No web_search tool here — research
    # is done, we just want the structured result out of the accumulated
    # conversation context.
    messages.append({"role": "user", "content": FINAL_SUBMIT_PROMPT})

    nudges = 0
    while True:
        with client.messages.stream(
            model=model,
            max_tokens=SUBMIT_MAX_TOKENS,
            system=system_prompt,
            tools=[SUBMIT_TOOL],
            tool_choice={"type": "tool", "name": "submit_places"},
            messages=messages,
        ) as stream:
            submit_response = stream.get_final_message()

        if submit_response.stop_reason == "refusal":
            raise RuntimeError(f"submit_places call refused for {city}, {prefecture}")

        tool_use = next((b for b in submit_response.content if b.type == "tool_use"), None)
        if tool_use is not None:
            result = tool_use.input
            if not isinstance(result, dict) or not isinstance(result.get("places"), list):
                raise RuntimeError(f"submit_places returned an unexpected shape for {city}")
            return [p for p in result["places"] if isinstance(p, dict) and p.get("name")]

        nudges += 1
        if nudges > MAX_SUBMIT_NUDGES:
            raise RuntimeError(
                f"model never called submit_places for {city} after {MAX_SUBMIT_NUDGES} nudges "
                f"(stop_reason={submit_response.stop_reason!r})"
            )
        messages.append({"role": "assistant", "content": submit_response.content})
        messages.append({"role": "user", "content": FINAL_SUBMIT_PROMPT})


def build_full_record(
    place: dict[str, Any],
    batch_id: str,
    country: CountryConfig,
    region: str,
    prefecture: str,
    city: str,
    model: str,
    now: str,
) -> dict[str, Any] | None:
    name = str(place.get("name") or "").strip()
    if not name:
        return None
    source_urls = place.get("source_urls")
    field_sources = place.get("field_sources")
    if not isinstance(source_urls, list) or not source_urls:
        print(f"[discover-extract] dropping {name!r}: no source_urls", file=sys.stderr)
        return None
    if not isinstance(field_sources, dict) or not field_sources:
        print(f"[discover-extract] dropping {name!r}: no field_sources", file=sys.stderr)
        return None

    category = str(place.get("category") or "").strip().lower() or None
    if category and ("food" in category or "restaurant" in category or "cafe" in category):
        print(f"[discover-extract] dropping {name!r}: food/restaurant category {category!r}", file=sys.stderr)
        return None

    photo = place.get("photo")
    if isinstance(photo, dict):
        if not all(photo.get(f) for f in ("url", "license", "credit", "source_url")):
            photo = None
    else:
        photo = None

    return {
        "batch_id": batch_id,
        "dedupe_key": build_dedupe_key(name, prefecture, city),
        "region": region,
        "prefecture": prefecture,
        "city": city,
        "country": country.code,
        "name": name,
        "category": category,
        "description": place.get("description"),
        "tips": place.get("tips") if isinstance(place.get("tips"), list) else [],
        "hours": place.get("hours"),
        "hours_status": place.get("hours_status") or "unknown",
        "station": place.get("station"),
        "google_place_id": None,
        "lat": place.get("lat"),
        "lng": place.get("lng"),
        "address": place.get("address"),
        "rating": None,
        "price_level": None,
        "image_url": None,
        "badges": [],
        "source_urls": source_urls,
        "field_sources": field_sources,
        "photo": photo,
        "extraction_model": model,
        "extraction_status": "extracted",
        "validation_errors": [],
        "approved": False,
        "rejected_reason": None,
        "fetched_at": now,
        "last_verified_at": now,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Research and extract tourist places for a single city via Claude + web_search, no subagent spawning."
    )
    parser.add_argument(
        "--country", choices=sorted(COUNTRIES), default="japan", help="Which country config to use."
    )
    parser.add_argument("--city", required=True, help="City/town/ward/district name, e.g. Nagatoro")
    parser.add_argument("--prefecture", required=True, help="Admin unit name (prefecture/council area/etc.), e.g. Saitama")
    parser.add_argument("--region", required=True, help="Region grouping from the country's config, e.g. Kanto, Highlands")
    parser.add_argument("--tier", required=True, choices=["major", "mid", "minor"], help="Target place-count tier")
    parser.add_argument("--batch-id", required=True, help="Batch identifier, e.g. jp-saitama-wave2-2026-07-24")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory (default: scraper/out/<batch-id>/)",
    )
    parser.add_argument("--model", default=os.environ.get("CITY_EXTRACT_MODEL", DEFAULT_MODEL))
    args = parser.parse_args()

    country = get_country(args.country)
    if args.region not in country.regions:
        print(
            f"[discover-extract] unknown --region {args.region!r} for {country.name}. "
            f"Must be one of: {', '.join(country.regions)}",
            file=sys.stderr,
        )
        sys.exit(1)

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print("[discover-extract] ANTHROPIC_API_KEY is required in scraper/.env", file=sys.stderr)
        sys.exit(1)

    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)

    output_dir = args.output_dir or (DEFAULT_OUTPUT_ROOT / args.batch_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    city_slug = normalize_key(args.city)
    output_path = output_dir / f"{city_slug}.json"

    print(
        f"[discover-extract] {args.city}, {args.prefecture}, {country.name} ({args.region}), tier={args.tier}, "
        f"model={args.model}, target={TIER_TARGET_DESC[args.tier]}"
    )

    try:
        raw_places = research_and_extract_city(
            client, args.model, country, args.city, args.prefecture, args.region, args.tier
        )
    except Exception as exc:
        print(f"[discover-extract] ERROR {args.city}: {exc}", file=sys.stderr)
        sys.exit(1)

    now = datetime.now(timezone.utc).isoformat()
    records = []
    for place in raw_places:
        record = build_full_record(place, args.batch_id, country, args.region, args.prefecture, args.city, args.model, now)
        if record is not None:
            records.append(record)

    output_path.write_text(json.dumps({"records": records}, ensure_ascii=False, indent=2) + "\n")

    target = TIER_TARGET_COUNT[args.tier]
    print(
        f"[discover-extract] {args.city}: wrote {len(records)} record(s) to {output_path} "
        f"(target {TIER_TARGET_DESC[args.tier]}, raw candidates from model: {len(raw_places)})"
    )
    if len(records) < target:
        print(
            f"[discover-extract] note: {len(records)} is below the nominal {target}-place target for "
            f"tier={args.tier} — not force-padded, this may just reflect {args.city}'s actual tourist density.",
        )


if __name__ == "__main__":
    main()
