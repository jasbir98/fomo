#!/usr/bin/env python3
"""
run_city_batch.py — batch driver for Stage 2 (discover_and_extract_city.py):
reads a discover_cities.py-shaped JSON file (a flat list of
`{"prefecture", "city", "region", "tier", "reason"}` records — e.g.
`data/japan_cities.json` or `data/scotland_cities.json`) and runs
research_and_extract_city() for every entry, one city at a time, writing
each city's own `out/<batch-id>/<city-slug>.json` exactly like calling
discover_and_extract_city.py by hand per city.

This is the thing to reach for once you have a `discover_cities.py` output
file and want to extract every city in it (or a filtered slice of it)
without typing one `discover_and_extract_city.py` invocation per city.
Country-agnostic — same `--country` flag as the other two stages.

Resumable like discover_cities.py: progress (which (prefecture, city) pairs
are done) is saved after every city to `--progress-file` (default
`data/run_city_batch_progress_<country>_<batch-id>.json`), so a crash or
Ctrl-C partway through a long batch loses at most one city. Re-running skips
cities already marked "done" for this batch-id unless --force. A city whose
Stage 2 call raises is logged and marked "failed" in progress, and the batch
continues with the next city rather than aborting the whole run.

Usage:
    # Everything in the file
    python scraper/run_city_batch.py --country scotland --batch-id scot-pilot-2026-07-25

    # Only major-tier cities, capped at 5, from an explicit file
    python scraper/run_city_batch.py --country scotland --batch-id scot-pilot-2026-07-25 \\
        --cities-file data/scotland_cities.json --tier major --limit 5

    # See what would run without spending any API calls
    python scraper/run_city_batch.py --country scotland --batch-id scot-pilot-2026-07-25 --dry-run

    # Resume a partial run, or re-run everything ignoring prior progress
    python scraper/run_city_batch.py --country scotland --batch-id scot-pilot-2026-07-25 --start-from Glasgow
    python scraper/run_city_batch.py --country scotland --batch-id scot-pilot-2026-07-25 --force
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRAPER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRAPER_DIR))

from countries import COUNTRIES, get_country  # noqa: E402
from discover_and_extract_city import (  # noqa: E402
    DEFAULT_MODEL,
    DEFAULT_OUTPUT_ROOT,
    build_full_record,
    normalize_key,
    research_and_extract_city,
)


def default_cities_file_for(country_key: str) -> Path:
    # Matches discover_cities.py's default_output_for: Japan keeps its bare
    # historic filename, every other country gets a `<country>_` prefix.
    if country_key == "japan":
        return SCRAPER_DIR / "data" / "japan_cities.json"
    return SCRAPER_DIR / "data" / f"{country_key}_cities.json"


def default_progress_file_for(country_key: str, batch_id: str) -> Path:
    safe_batch = normalize_key(batch_id)
    return SCRAPER_DIR / "data" / f"run_city_batch_progress_{country_key}_{safe_batch}.json"


def load_cities(cities_file: Path) -> list[dict[str, Any]]:
    if not cities_file.exists():
        print(f"[batch] cities file not found: {cities_file}", file=sys.stderr)
        sys.exit(1)
    try:
        data = json.loads(cities_file.read_text())
    except json.JSONDecodeError as exc:
        print(f"[batch] couldn't parse {cities_file}: {exc}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(data, list):
        print(f"[batch] expected {cities_file} to contain a JSON array.", file=sys.stderr)
        sys.exit(1)
    return data


def load_progress(progress_file: Path) -> dict[str, Any]:
    if not progress_file.exists():
        return {}
    try:
        return json.loads(progress_file.read_text())
    except (json.JSONDecodeError, OSError):
        print(f"[batch] warning: couldn't read {progress_file}, starting fresh progress.", file=sys.stderr)
        return {}


def save_progress(progress_file: Path, progress: dict[str, Any]) -> None:
    progress_file.parent.mkdir(parents=True, exist_ok=True)
    progress_file.write_text(json.dumps(progress, indent=2, ensure_ascii=False))


def progress_key(entry: dict[str, Any]) -> str:
    return f"{entry.get('prefecture', '')}::{entry.get('city', '')}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run Stage 2 (discover_and_extract_city) over every city in a discover_cities.py output file."
    )
    parser.add_argument(
        "--country", choices=sorted(COUNTRIES), default="japan", help="Which country config to use."
    )
    parser.add_argument("--batch-id", required=True, help="Batch identifier passed through to each city's record, e.g. scot-pilot-2026-07-25")
    parser.add_argument(
        "--cities-file",
        type=Path,
        default=None,
        help="Path to a discover_cities.py-shaped JSON file (default: data/<country>_cities.json, or data/japan_cities.json for Japan).",
    )
    parser.add_argument(
        "--tier",
        action="append",
        choices=["major", "mid", "minor"],
        help="Only run cities at this tier. Repeatable (e.g. --tier major --tier mid). Default: all tiers.",
    )
    parser.add_argument("--region", help="Only run cities in this region (must match the country config's region grouping).")
    parser.add_argument("--prefecture", help="Only run cities in this admin unit (prefecture/council area/etc.).")
    parser.add_argument("--limit", type=int, help="Stop after this many cities have been attempted (for testing).")
    parser.add_argument("--start-from", help="Skip cities before this one in the file's order (inclusive of this city).")
    parser.add_argument("--force", action="store_true", help="Reprocess cities already marked done in the progress file for this batch-id.")
    parser.add_argument("--dry-run", action="store_true", help="List which cities would run, without calling the API.")
    parser.add_argument("--progress-file", type=Path, default=None, help="Path for the resume-progress JSON (default: data/run_city_batch_progress_<country>_<batch-id>.json).")
    parser.add_argument(
        "--profile",
        choices=("tourist", "local"),
        default="tourist",
        help="Extraction profile forwarded to discover_and_extract_city.py's research_and_extract_city. 'tourist' (default) is unchanged existing behaviour.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory for per-city JSON (default: scraper/out/<batch-id>/, same as discover_and_extract_city.py).",
    )
    parser.add_argument("--model", default=os.environ.get("CITY_EXTRACT_MODEL", DEFAULT_MODEL))
    args = parser.parse_args()

    country = get_country(args.country)
    cities_file = args.cities_file or default_cities_file_for(args.country)
    progress_file = args.progress_file or default_progress_file_for(args.country, args.batch_id)
    output_dir = args.output_dir or (DEFAULT_OUTPUT_ROOT / args.batch_id)

    entries = load_cities(cities_file)

    # Filter by tier/region/prefecture before --start-from/--limit, so those
    # two act on the already-filtered queue (matches what you'd expect from
    # "run the first 5 major-tier cities").
    if args.tier:
        entries = [e for e in entries if e.get("tier") in args.tier]
    if args.region:
        entries = [e for e in entries if e.get("region") == args.region]
    if args.prefecture:
        entries = [e for e in entries if e.get("prefecture") == args.prefecture]

    if args.start_from:
        names = [e.get("city") for e in entries]
        if args.start_from not in names:
            print(f"[batch] --start-from {args.start_from!r} not found in the filtered city list.", file=sys.stderr)
            sys.exit(1)
        entries = entries[names.index(args.start_from):]

    unknown_regions = {e.get("region") for e in entries if e.get("region") not in country.regions}
    if unknown_regions:
        print(
            f"[batch] warning: {len(unknown_regions)} region(s) in {cities_file} aren't in "
            f"{country.name}'s config ({', '.join(sorted(unknown_regions))}) — those cities will "
            "still run, but double-check the cities file matches --country.",
            file=sys.stderr,
        )

    progress = load_progress(progress_file)
    if not args.force:
        entries = [e for e in entries if progress.get(progress_key(e), {}).get("status") != "done"]

    if args.limit is not None:
        entries = entries[: args.limit]

    print(f"[batch] {country.name}: {len(entries)} cities queued from {cities_file}, batch-id={args.batch_id}")

    if args.dry_run:
        for e in entries:
            print(f"[batch] would run: {e.get('city')}, {e.get('prefecture')} ({e.get('region')}) tier={e.get('tier')}")
        print(f"[batch] --dry-run: {len(entries)} cities listed, no API calls made.")
        return

    if not entries:
        print("[batch] nothing to do — all cities already done for this batch-id, or the filters matched none.")
        return

    # Provider (DeepSeek or Anthropic) is chosen by which key is set — see
    # scraper/llm_client.py for the precedence rule and the DeepSeek quirks.
    from llm_client import make_research_client

    client, provider = make_research_client("batch")
    print(f"[batch] provider={provider}, model={args.model}")
    output_dir.mkdir(parents=True, exist_ok=True)

    succeeded = 0
    failed = 0
    for i, entry in enumerate(entries, start=1):
        city = str(entry.get("city") or "").strip()
        prefecture = str(entry.get("prefecture") or "").strip()
        region = str(entry.get("region") or "").strip()
        tier = str(entry.get("tier") or "").strip()
        key = progress_key(entry)

        if not city or not prefecture or not region or tier not in ("major", "mid", "minor"):
            print(f"[batch] SKIP malformed entry: {entry!r}", file=sys.stderr)
            progress[key] = {"status": "failed", "error": "malformed entry"}
            save_progress(progress_file, progress)
            failed += 1
            continue

        print(f"[batch] ({i}/{len(entries)}) {city}, {prefecture} ({region}), tier={tier}, profile={args.profile} ...")
        try:
            raw_places = research_and_extract_city(
                client, args.model, country, city, prefecture, region, tier, args.profile
            )
        except Exception as exc:
            print(f"[batch] ERROR {city}: {exc}", file=sys.stderr)
            progress[key] = {"status": "failed", "error": str(exc)}
            save_progress(progress_file, progress)
            failed += 1
            continue

        now = datetime.now(timezone.utc).isoformat()
        records = []
        for place in raw_places:
            record = build_full_record(
                place, args.batch_id, country, region, prefecture, city, args.model, now, args.profile
            )
            if record is not None:
                records.append(record)

        city_slug = normalize_key(city)
        output_path = output_dir / f"{city_slug}.json"
        output_path.write_text(json.dumps({"records": records}, ensure_ascii=False, indent=2) + "\n")

        progress[key] = {"status": "done", "record_count": len(records)}
        save_progress(progress_file, progress)
        succeeded += 1
        print(f"[batch] {city}: wrote {len(records)} record(s) to {output_path}")

    print(f"[batch] done. succeeded={succeeded} failed={failed} (see {progress_file})")


if __name__ == "__main__":
    main()
