#!/usr/bin/env python3
"""
scot_gaps_report.py — live worklist of what's still missing in the Scotland
pilot batch (scot-pilot-2026-07-25) after enrich.py's free automated pass.

For Haiku running in Copilot CLI (or any web-search-capable coding agent):
this script does NOT search the web itself — it only reports, from the
current on-disk state, which records still need lat/lng, image_url,
station, or hours. Re-run it any time; because it reads live state (not a
frozen snapshot), it's naturally resumable — fields you've already filled
and cleared from data_quality_flags just stop showing up.

Your loop, one city at a time:
  1. Run: python scraper/scot_gaps_report.py --city <slug> --limit 15
  2. For each item, web-search the missing field(s) by name + city. Prefer,
     in this order: the place's own official site, VisitScotland, National
     Trust for Scotland, Historic Environment Scotland, ScotRail or
     Traveline Scotland (for "nearest station"), Wikipedia/Wikimedia
     Commons. Do not use Reddit, TripAdvisor, or social posts as fact
     sources. If you can't confidently confirm a field, leave it — don't
     guess.
  3. Edit consolidated/scot-pilot-2026-07-25/<file>.json directly: find the
     record by dedupe_key, fill the field(s) you confirmed, add a
     field_sources[<field>] entry with the URL you used, set
     last_verified_at to the current UTC time, and remove the
     corresponding missing_* flag from data_quality_flags.
  4. Move to the next city (`python scraper/scot_gaps_report.py --list-cities`
     shows what's left). Re-run without --city periodically to see overall
     progress.

Usage:
    python scraper/scot_gaps_report.py                       # full summary, all cities
    python scraper/scot_gaps_report.py --list-cities          # which city files still have gaps, most-gaps first
    python scraper/scot_gaps_report.py --city aberfeldy        # this city's gap items, in full
    python scraper/scot_gaps_report.py --city aberfeldy --limit 10
    python scraper/scot_gaps_report.py --field hours           # only records missing this one field, any city
    python scraper/scot_gaps_report.py --json                  # machine-readable output instead of the printed report
"""

from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

ROOT = Path(__file__).parent
DIR = ROOT / "consolidated" / "scot-pilot-2026-07-25"

FIELD_TO_FLAG = {
    "coords": "missing_coords",
    "image_url": "missing_image_url",
    "station": "missing_station",
    "hours": "missing_hours",
}
TARGET_FLAGS = set(FIELD_TO_FLAG.values())


def _missing(v):
    return v in (None, "", [], {})


def load_gaps():
    """Returns list of gap items across every consolidated city file."""
    items = []
    for path in sorted(glob.glob(str(DIR / "*.json"))):
        name = Path(path).name
        if name.startswith("_"):
            continue
        data = json.loads(Path(path).read_text())
        for r in data.get("records", []):
            flags = set(r.get("data_quality_flags") or [])
            # data_quality_flags is a snapshot from the last enrich.py run;
            # recompute live in case fields were hand-edited since then.
            live_flags = set()
            if _missing(r.get("lat")) or _missing(r.get("lng")):
                live_flags.add("missing_coords")
            if _missing(r.get("image_url")):
                live_flags.add("missing_image_url")
            if _missing(r.get("station")):
                live_flags.add("missing_station")
            if _missing(r.get("hours")):
                live_flags.add("missing_hours")
            gaps = sorted(live_flags & TARGET_FLAGS)
            if not gaps:
                continue
            items.append({
                "dedupe_key": r.get("dedupe_key"),
                "name": r.get("name"),
                "city": r.get("city"),
                "prefecture": r.get("prefecture"),
                "category": r.get("category"),
                "address": r.get("address"),
                "description": r.get("description"),
                "existing_source_urls": r.get("source_urls") or [],
                "missing": gaps,
                "file": name,
            })
            if flags - live_flags:
                # stale flags on the record itself (already fixed but the
                # flag list wasn't updated) — harmless, but worth a nudge.
                pass
    return items


def main():
    p = argparse.ArgumentParser(description="Live worklist of missing lat/lng, image_url, station, hours for the Scotland pilot batch.")
    p.add_argument("--city", help="City slug, matching the filename (e.g. 'aberfeldy' for aberfeldy.json). Shows full items for just this city.")
    p.add_argument("--field", choices=sorted(FIELD_TO_FLAG), help="Only show records missing this field.")
    p.add_argument("--limit", type=int, help="Cap the number of items shown (after --city/--field filtering).")
    p.add_argument("--list-cities", action="store_true", help="Just list city files with remaining gaps, most-gaps first, and exit.")
    p.add_argument("--json", action="store_true", help="Print machine-readable JSON instead of the human report.")
    args = p.parse_args()

    if not DIR.exists():
        print(f"[gaps] {DIR} doesn't exist — run enrich.py first.")
        return

    items = load_gaps()

    if args.field:
        items = [it for it in items if FIELD_TO_FLAG[args.field] in it["missing"]]

    if args.list_cities:
        by_city: dict[str, int] = {}
        for it in items:
            by_city[it["file"]] = by_city.get(it["file"], 0) + 1
        ordered = sorted(by_city.items(), key=lambda kv: -kv[1])
        if args.json:
            print(json.dumps(ordered, indent=2))
        else:
            print(f"{len(ordered)} city file(s) with remaining gaps, {len(items)} record(s) total:")
            for fname, count in ordered:
                print(f"  {count:4d}  {fname}")
        return

    if args.city:
        city_file = args.city if args.city.endswith(".json") else f"{args.city}.json"
        items = [it for it in items if it["file"] == city_file]

    if args.limit:
        items = items[: args.limit]

    if args.json:
        print(json.dumps(items, indent=2, ensure_ascii=False))
        return

    if args.city:
        print(f"{len(items)} item(s) still needing research in {args.city}:\n")
        for it in items:
            print(f"- {it['name']}  [{', '.join(it['missing'])}]")
            print(f"    dedupe_key: {it['dedupe_key']}")
            print(f"    category: {it['category']}   address: {it['address']}")
            if it["description"]:
                print(f"    description: {it['description']}")
            if it["existing_source_urls"]:
                print(f"    existing sources: {', '.join(it['existing_source_urls'])}")
            print()
    else:
        by_field: dict[str, int] = {}
        for it in items:
            for f in it["missing"]:
                by_field[f] = by_field.get(f, 0) + 1
        print(f"{len(items)} record(s) across the batch still need manual research.")
        print("By field:")
        for f, count in sorted(by_field.items(), key=lambda kv: -kv[1]):
            print(f"  {count:5d}  {f}")
        print("\nRun --list-cities to see which city files to tackle first, "
              "or --city <slug> to get the full worklist for one city.")


if __name__ == "__main__":
    main()
