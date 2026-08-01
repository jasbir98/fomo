#!/usr/bin/env python3
"""
discover_cities.py — Stage 1 of the national places scale-up: asks Claude
Haiku 4.5, once per admin unit (prefecture, council area, etc. — see
`--country`), for the tourist-relevant cities/towns/wards/districts in that
admin unit with a popularity tier and a one-line reason. Writes a flat
national list to `scraper/data/<country>_cities.json` for Stage 2 (per-city
place discovery) to consume.

Country-specific data (the admin-unit -> region grouping, and a couple of
prompt fragments) lives in `scraper/countries/` — see `--country` below.
Everything in this script is otherwise country-agnostic.

Mirrors the Claude-extraction pattern in japan_place_extract.py /
classify_reels.py: Anthropic SDK, ANTHROPIC_API_KEY from scraper/.env,
forced tool-use JSON schema instead of free-text parsing.

Before generating, pulls existing `(prefecture, city)` pairs already covered
in `places` for this country (any source containing "seed", e.g.
'seed-japan-pipeline' or a one-off batch tag like 'seed:jp-tokyo-2026-07-15')
via the Supabase REST API — same pattern as scripts/promote-japan-places.mjs
— and excludes them so already-curated cities (Kamakura, Hakone, Yokohama,
the done Tokyo wards, etc.) don't get rediscovered. This is a best-effort
dedupe: if the Supabase call fails or credentials are missing, this script
logs a warning and continues with an empty exclusion set rather than
hard-failing.

Resumable like scrape_places_batch.py's --progress-file: progress (which
admin units are done) is saved after every admin unit, and the output file
is rewritten incrementally, so a crash or Ctrl-C partway through a full run
loses at most one admin unit's worth of work. Re-running skips admin units
already marked "done" unless --force or --admin-unit is passed.

Usage:
    python scraper/discover_cities.py --country japan
    python scraper/discover_cities.py --country japan --admin-unit Tottori   # single admin unit, for testing
    python scraper/discover_cities.py --country scotland --dry-run          # skip Supabase exclusion fetch
    python scraper/discover_cities.py --country japan --start-from Kyoto     # resume a full run from here
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

SCRAPER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRAPER_DIR.parent
load_dotenv(SCRAPER_DIR / ".env")

sys.path.insert(0, str(SCRAPER_DIR))
from countries import CountryConfig, COUNTRIES, get_country  # noqa: E402

DEFAULT_MODEL = "claude-haiku-4-5"


def default_output_for(country_key: str) -> Path:
    # Japan keeps its original bare filenames (data/japan_cities.json,
    # data/discover_cities_progress.json) for backward compatibility with
    # the in-flight national scale-up's existing output/progress files.
    # Every other country gets a `<country>_` prefixed pair instead.
    if country_key == "japan":
        return SCRAPER_DIR / "data" / "japan_cities.json"
    return SCRAPER_DIR / "data" / f"{country_key}_cities.json"


def default_progress_file_for(country_key: str) -> Path:
    if country_key == "japan":
        return SCRAPER_DIR / "data" / "discover_cities_progress.json"
    return SCRAPER_DIR / "data" / f"discover_cities_progress_{country_key}.json"


SYSTEM_PROMPT_TEMPLATE = """You identify tourist-relevant cities, towns, wards, and districts within a single {admin_unit_label} of {country_name} for a travel app.

Rules:
- Only include places with genuine tourist relevance. Do not pad the list with every municipality in the {admin_unit_label} — most {admin_unit_label_plural} have far more municipalities than tourist-relevant ones.
- tier="major": an internationally or nationally famous tourist draw.
- tier="mid": regionally known, a solid tourist town or city, worth a dedicated stop for interested travelers.
- tier="minor": has at least one genuine notable spot but is niche or mostly local; it is fine and expected to return few or zero minor entries for a small or low-tourism {admin_unit_label}. Do not strain to be exhaustive on this tier.
- Give each place a short one-line reason for its tourist relevance.
- Do not invent places or pad counts. If a {admin_unit_label} genuinely has few tourist-relevant places, return a short list.
"""


def build_system_prompt(country: CountryConfig) -> str:
    return SYSTEM_PROMPT_TEMPLATE.format(
        admin_unit_label=country.admin_unit_label,
        admin_unit_label_plural=f"{country.admin_unit_label}s",
        country_name=country.name,
    )

DISCOVER_TOOL = {
    "name": "submit_cities",
    "description": "Submit the tourist-relevant cities/towns/wards/districts found for this prefecture.",
    "input_schema": {
        "type": "object",
        "properties": {
            "cities": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "tier": {"type": "string", "enum": ["major", "mid", "minor"]},
                        "reason": {"type": "string"},
                    },
                    "required": ["name", "tier", "reason"],
                },
            }
        },
        "required": ["cities"],
    },
}


def build_user_prompt(country: CountryConfig, admin_unit: str, region: str) -> str:
    return f"""{country.admin_unit_label.capitalize()}: {admin_unit}, {country.name} (region: {region}).

List the tourist-relevant cities, towns, wards, or districts within this
{country.admin_unit_label}, each with a tier and a one-line reason."""


def discover_admin_unit(
    client: Any, model: str, country: CountryConfig, admin_unit: str
) -> list[dict[str, Any]]:
    region = country.admin_unit_region[admin_unit]
    response = client.messages.create(
        model=model,
        max_tokens=4000,
        system=build_system_prompt(country),
        tools=[DISCOVER_TOOL],
        tool_choice={"type": "tool", "name": "submit_cities"},
        messages=[{"role": "user", "content": build_user_prompt(country, admin_unit, region)}],
    )

    tool_use = next((b for b in response.content if b.type == "tool_use"), None)
    if tool_use is None:
        raise RuntimeError("empty response from discovery model")
    result = tool_use.input
    if not isinstance(result, dict) or not isinstance(result.get("cities"), list):
        raise RuntimeError("expected discovery response to contain a cities array")
    return [c for c in result["cities"] if isinstance(c, dict) and c.get("name") and c.get("tier")]


# --- Supabase exclusion fetch -------------------------------------------------


def _get_supabase_credentials() -> tuple[str, str] | None:
    """Resolve Supabase REST credentials, trying the scraper's own `.env`
    first (SUPABASE_URL/SUPABASE_KEY, same vars upsert_supabase.py /
    classify_reels.py already use to read/write this project's Supabase),
    then falling back to the Next app's repo-root `.env.local`
    (NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY — public/anon-safe
    values already used client-side, safe to reuse for a read-only query
    here). Returns None if neither source has usable credentials.
    """
    supabase_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    supabase_key = os.environ.get("SUPABASE_KEY", "").strip()
    if supabase_url and supabase_key:
        return supabase_url, supabase_key

    # Fall back to the Next app's env file for the public anon credentials.
    load_dotenv(REPO_ROOT / ".env.local")
    supabase_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "").strip().rstrip("/")
    supabase_key = os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "").strip()
    if supabase_url and supabase_key:
        return supabase_url, supabase_key

    return None


def fetch_covered_pairs(country: CountryConfig, dry_run: bool) -> set[tuple[str, str]]:
    """(prefecture, city) pairs already promoted into `places` for this
    country (any source containing "seed", e.g. 'seed-japan-pipeline'),
    lowercased for case-insensitive dedupe. Filtered by `country=eq.<code>`
    so running this for one country never excludes another country's cities
    that happen to share a name. Best-effort: any failure (missing creds,
    network, bad response) logs a warning and returns an empty set rather
    than hard-failing the run — this exclusion is a dedupe nicety, not a
    correctness requirement.
    """
    if dry_run:
        print("[discover] --dry-run: skipping Supabase exclusion fetch.")
        return set()

    creds = _get_supabase_credentials()
    if creds is None:
        print(
            "[discover] warning: no Supabase credentials found (checked scraper/.env "
            "SUPABASE_URL/SUPABASE_KEY and repo-root .env.local "
            "NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY). Continuing with "
            "an empty exclusion set.",
            file=sys.stderr,
        )
        return set()

    supabase_url, supabase_key = creds
    headers = {"apikey": supabase_key, "Authorization": f"Bearer {supabase_key}"}
    try:
        resp = requests.get(
            f"{supabase_url}/rest/v1/places",
            headers=headers,
            params={
                "source": "like.*seed*",
                "country": f"eq.{country.code}",
                "select": "prefecture,city",
            },
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
    except (requests.RequestException, ValueError) as exc:
        print(f"[discover] warning: Supabase exclusion fetch failed ({exc}). Continuing with an empty exclusion set.", file=sys.stderr)
        return set()

    pairs: set[tuple[str, str]] = set()
    for row in rows:
        prefecture = (row.get("prefecture") or "").strip().lower()
        city = (row.get("city") or "").strip().lower()
        if prefecture and city:
            pairs.add((prefecture, city))

    print(f"[discover] fetched {len(pairs)} already-covered ({country.admin_unit_label}, city) pair(s) to exclude.")
    return pairs


# --- progress + output file handling ------------------------------------------


def load_progress(progress_file: Path) -> dict[str, Any]:
    if not progress_file.exists():
        return {}
    try:
        return json.loads(progress_file.read_text())
    except (json.JSONDecodeError, OSError):
        print(f"[discover] warning: couldn't read {progress_file}, starting fresh progress.", file=sys.stderr)
        return {}


def save_progress(progress_file: Path, progress: dict[str, Any]) -> None:
    progress_file.parent.mkdir(parents=True, exist_ok=True)
    progress_file.write_text(json.dumps(progress, indent=2, ensure_ascii=False))


def load_output(output_file: Path) -> list[dict[str, Any]]:
    if not output_file.exists():
        return []
    try:
        data = json.loads(output_file.read_text())
    except (json.JSONDecodeError, OSError):
        print(f"[discover] warning: couldn't read {output_file}, starting fresh output.", file=sys.stderr)
        return []
    return data if isinstance(data, list) else []


def save_output(output_file: Path, records: list[dict[str, Any]]) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Discover tourist-relevant cities/towns/wards per admin unit with Claude Haiku 4.5."
    )
    parser.add_argument(
        "--country", choices=sorted(COUNTRIES), default="japan", help="Which country config to use."
    )
    parser.add_argument("--output", type=Path, default=None, help="Path for the national city list JSON (default: data/japan_cities.json for Japan, data/<country>_cities.json otherwise).")
    parser.add_argument("--progress-file", type=Path, default=None, help="Path for the resume-progress JSON (default: data/discover_cities_progress.json for Japan, data/discover_cities_progress_<country>.json otherwise).")
    parser.add_argument(
        "--admin-unit",
        "--prefecture",
        dest="admin_unit",
        help="Run just this one admin unit (prefecture/council area/etc., for testing). Ignores progress/skip logic.",
    )
    parser.add_argument("--start-from", help="Resume a full run starting at this admin unit (inclusive).")
    parser.add_argument("--force", action="store_true", help="Reprocess admin units already marked done in the progress file.")
    parser.add_argument("--dry-run", action="store_true", help="Skip the Supabase exclusion fetch (useful without credentials).")
    parser.add_argument("--model", default=os.environ.get("CITY_DISCOVER_MODEL", DEFAULT_MODEL))
    args = parser.parse_args()

    country = get_country(args.country)
    output_file = args.output or default_output_for(args.country)
    progress_file = args.progress_file or default_progress_file_for(args.country)

    if args.admin_unit and args.admin_unit not in country.admin_unit_region:
        print(
            f"[discover] unknown {country.admin_unit_label}: {args.admin_unit!r}. "
            f"Must be one of the {len(country.admin_units)} known {country.admin_unit_label}s for {country.name}.",
            file=sys.stderr,
        )
        sys.exit(1)
    if args.start_from and args.start_from not in country.admin_unit_region:
        print(f"[discover] unknown --start-from {country.admin_unit_label}: {args.start_from!r}.", file=sys.stderr)
        sys.exit(1)

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        print("[discover] ANTHROPIC_API_KEY is required in scraper/.env", file=sys.stderr)
        sys.exit(1)
    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)

    excluded_pairs = fetch_covered_pairs(country, args.dry_run)

    if args.admin_unit:
        units_to_run = [args.admin_unit]
    else:
        units_to_run = list(country.admin_units)
        if args.start_from:
            start_index = units_to_run.index(args.start_from)
            units_to_run = units_to_run[start_index:]

    progress = load_progress(progress_file)
    records = load_output(output_file)

    print(f"[discover] {country.name}: {len(units_to_run)} {country.admin_unit_label}(s) queued, model {args.model}")

    for admin_unit in units_to_run:
        if not args.admin_unit and not args.force and progress.get(admin_unit, {}).get("status") == "done":
            print(f"[discover] skip {admin_unit} (already done)")
            continue

        region = country.admin_unit_region[admin_unit]
        try:
            raw_cities = discover_admin_unit(client, args.model, country, admin_unit)
        except Exception as exc:
            print(f"[discover] ERROR {admin_unit}: {exc}", file=sys.stderr)
            progress[admin_unit] = {"status": "failed", "error": str(exc)}
            save_progress(progress_file, progress)
            continue

        kept = []
        excluded_count = 0
        for city in raw_cities:
            name = str(city.get("name") or "").strip()
            if not name:
                continue
            if (admin_unit.strip().lower(), name.lower()) in excluded_pairs:
                excluded_count += 1
                continue
            kept.append(
                {
                    "prefecture": admin_unit,
                    "city": name,
                    "region": region,
                    "tier": city.get("tier"),
                    "reason": str(city.get("reason") or "").strip(),
                }
            )

        # Replace any prior entries for this admin unit (reprocessing / --force)
        # so re-running never duplicates rows.
        records = [r for r in records if r.get("prefecture") != admin_unit] + kept
        save_output(output_file, records)

        progress[admin_unit] = {"status": "done", "city_count": len(kept), "excluded_count": excluded_count}
        save_progress(progress_file, progress)

        tiers = {"major": 0, "mid": 0, "minor": 0}
        for city in kept:
            if city["tier"] in tiers:
                tiers[city["tier"]] += 1
        print(
            f"[discover] {admin_unit}: {len(kept)} kept "
            f"(major={tiers['major']} mid={tiers['mid']} minor={tiers['minor']}), "
            f"{excluded_count} excluded (already covered)"
        )

    print(f"[discover] done. {len(records)} total record(s) in {output_file}")


if __name__ == "__main__":
    main()
