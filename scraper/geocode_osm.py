#!/usr/bin/env python3
"""
geocode_osm.py — fill missing coordinates on a consolidated places batch from
free OpenStreetMap sources, before the batch is upserted to places_staging.

Why not scraper/enrich.py: that script was written for the July Scotland pilot
and is hardcoded to its batch paths. Its geocode sanity check is a bounding box
around ALL of Scotland (so a same-named pub in Glasgow would pass), it queries
Nominatim on name + neighbourhood only even when a street address is known, and
it spends Wikidata lookups on every record first — useful for landmarks, rarely
for pubs, and roughly triple the requests. This script keeps what enrich.py got
right (an identifying User-Agent, a Nominatim throttle over 1 s, a per-run
cache) and fixes those three things.

Lookup order per record, stopping at the first ACCEPTED hit:
  1. A cited Wikipedia article's own coordinates (only if one is in source_urls).
  2. Nominatim for the venue BY NAME, bounded to the city's viewbox, accepted
     only when the returned feature's name actually matches. That lands on the
     venue's own OSM node/way, the most precise result available.
  3. Nominatim for the record's STREET ADDRESS, bounded. A building or POI hit
     is labelled `osm-address`; a hit on the road itself is labelled
     `osm-street`, because a road's coordinate can sit well away from the door
     and several shops on one road collapse onto the same pin.
Anything that fails all three is listed in the report, never guessed.

Every candidate must also pass two guards, or it is rejected and the next
lookup is tried:
  - inside the city's viewbox, and
  - within MAX_KM_FROM_NEIGHBOURHOOD of the record's neighbourhood centre
    (looked up once per neighbourhood, cached).
The distance guard exists because of a real failure in the first trial:
"Twelve Triangles (Bruntsfield)" missed the name match on its "(Bruntsfield)"
qualifier, fell through to the address lookup, and was pinned about 3 km away
near Leith Walk. Parenthetical qualifiers are now stripped before matching and
querying, and the guard catches anything similar that still slips through.

Every accepted coordinate records its exact source in field_sources.lat/lng:
the OpenStreetMap object URL (https://www.openstreetmap.org/node/…) or the
Wikipedia article. OSM data is ODbL-licensed: storable permanently, with
"© OpenStreetMap contributors" attribution where it is displayed — the app's
Mapbox map already carries that attribution.

Nominatim usage policy: at most 1 request/second, an identifying User-Agent,
cache repeated queries. A ~400-record batch is within policy at this rate.
The User-Agent deliberately carries no personal contact details.

Resumable: only records still missing coordinates are processed, and the file
is checkpointed every 25 records, so a crash or Ctrl-C loses at most 25 lookups.

Usage:
    # trial: geocode 15 records, print results, change nothing
    python3 scraper/geocode_osm.py --batch-id edi-local-2026-09-12 --limit 15 --no-write
    # full run, writing coordinates back into the consolidated file
    python3 scraper/geocode_osm.py --batch-id edi-local-2026-09-12

Reads/writes: consolidated/<batch-id>/<city-slug>.json
Also writes:  consolidated/<batch-id>/_geocode_report.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import urllib.parse
from collections import Counter
from pathlib import Path
from typing import Any

import requests

SCRAPER_DIR = Path(__file__).resolve().parent

# City of Edinburgh council area, padded: Corstorphine/Ratho to Portobello,
# Leith to Fairmilehead. Nominatim viewbox order: left(lon),top(lat),right(lon),bottom(lat).
CITY_VIEWBOXES: dict[str, tuple[float, float, float, float]] = {
    "edinburgh": (-3.46, 56.01, -3.05, 55.85),
}

# Adjacent Edinburgh neighbourhood centres sit roughly 1 km apart, and merged
# records carry only their primary neighbourhood, so 2.5 km tolerates a venue on
# a boundary while still rejecting a pin on the wrong side of the city.
MAX_KM_FROM_NEIGHBOURHOOD = 2.5

UA = "FomoGeocoder/1.0 (Fomo Edinburgh app; low-volume batch geocode)"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
WIKIPEDIA_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/"
CHECKPOINT_EVERY = 25

S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept": "application/json"})

_last = {"osm": 0.0, "wp": 0.0}
_gap = {"osm": 1.1, "wp": 0.1}  # Nominatim policy: <= 1 req/s
_cache: dict[str, list[dict[str, Any]]] = {}
_centroids: dict[str, tuple[float, float] | None] = {}

_PARENTHETICAL = re.compile(r"\s*\([^)]*\)")

Candidate = tuple[float, float, str, str]  # lat, lng, source_url, method


def _throttle(kind: str) -> None:
    wait = _gap[kind] - (time.time() - _last[kind])
    if wait > 0:
        time.sleep(wait)
    _last[kind] = time.time()


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")


def clean_name(value: str) -> str:
    """Drop qualifiers like "(Bruntsfield)" — they aren't part of the name OSM stores."""
    return _PARENTHETICAL.sub("", value or "").strip()


def norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", re.sub(r"^the\s+", "", clean_name(value).lower()))


def names_match(wanted: str, got: str) -> bool:
    """Loose containment, but exact for short names — "Bow Bar" must not match
    any feature containing "bar"."""
    a, b = norm(wanted), norm(got)
    if not a or not b:
        return False
    if min(len(a), len(b)) < 5:
        return a == b
    return a in b or b in a


def in_viewbox(lat: float, lng: float, box: tuple[float, float, float, float]) -> bool:
    left, top, right, bottom = box
    return bottom <= lat <= top and left <= lng <= right


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(h))


def nominatim(query: str, box: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    if query in _cache:
        return _cache[query]
    _throttle("osm")
    params = {
        "q": query,
        "format": "jsonv2",
        "limit": 3,
        "addressdetails": 1,
        "viewbox": ",".join(str(v) for v in box),
        "bounded": 1,
    }
    try:
        r = S.get(NOMINATIM, params=params, timeout=20)
        hits = r.json() if r.status_code == 200 else []
        if r.status_code != 200:
            print(f"[geocode] nominatim HTTP {r.status_code} for {query!r}", file=sys.stderr)
    except Exception as exc:  # network blip: log, treat as no hit, keep going
        print(f"[geocode] nominatim error for {query!r}: {exc}", file=sys.stderr)
        hits = []
    _cache[query] = hits
    return hits


def neighbourhood_centre(neighbourhood: str, city: str, box: tuple[float, float, float, float]) -> tuple[float, float] | None:
    key = neighbourhood.lower()
    if key not in _centroids:
        hits = nominatim(f"{neighbourhood}, {city}", box)
        _centroids[key] = (float(hits[0]["lat"]), float(hits[0]["lon"])) if hits else None
    return _centroids[key]


def wikipedia_title(url: str) -> str | None:
    """Article title from a Wikipedia URL, including one wrapped in a web.archive.org snapshot."""
    m = re.search(r"wikipedia\.org/wiki/([^?#]+)", url or "")
    return urllib.parse.unquote(m.group(1)).replace("_", " ") if m else None


def title_is_about(name: str, title: str) -> bool:
    """True when a Wikipedia article is about the venue itself, not its area.

    The full run showed why this matters: research cited "Stockbridge, Edinburgh"
    for ten Stockbridge records (a library, a church, a lane, the baths), and
    taking the article's coordinates stacked all ten on one pin. The record name
    must be contained in the article title (its ", Edinburgh" disambiguator
    dropped), never the reverse — otherwise "Corstorphine Old Parish Church"
    would accept the "Corstorphine" article.
    """
    a, b = norm(name), norm(title.split(",")[0])
    if not a or not b:
        return False
    return a == b if min(len(a), len(b)) < 5 else a in b


def wikipedia_coords(url: str) -> tuple[float, float] | None:
    title = wikipedia_title(url)
    if not title:
        return None
    _throttle("wp")
    try:
        r = S.get(WIKIPEDIA_SUMMARY + urllib.parse.quote(title, safe=""), timeout=15)
        coords = r.json().get("coordinates") if r.status_code == 200 else None
    except Exception:
        return None
    if coords and coords.get("lat") is not None and coords.get("lon") is not None:
        return float(coords["lat"]), float(coords["lon"])
    return None


def osm_url(hit: dict[str, Any]) -> str:
    return f"https://www.openstreetmap.org/{hit['osm_type']}/{hit['osm_id']}"


def geocode(
    record: dict[str, Any], city: str, box: tuple[float, float, float, float], ambiguous_name: bool = False
) -> tuple[Candidate | None, list[str]]:
    """Return (accepted candidate or None, reasons any candidates were rejected)."""
    name = clean_name(record.get("name") or "")
    address = (record.get("address") or "").strip()
    neighbourhood = (record.get("city") or "").strip()
    rejections: list[str] = []

    centre = (
        neighbourhood_centre(neighbourhood, city, box)
        if neighbourhood and neighbourhood.lower() != city.lower()
        else None
    )

    def accept(lat: float, lng: float, source: str, method: str) -> Candidate | None:
        if not in_viewbox(lat, lng, box):
            rejections.append(f"{method}: outside {city} ({source})")
            return None
        if centre is not None:
            km = haversine_km((lat, lng), centre)
            if km > MAX_KM_FROM_NEIGHBOURHOOD:
                rejections.append(f"{method}: {km:.1f} km from {neighbourhood} ({source})")
                return None
        return lat, lng, source, method

    # 1. A cited Wikipedia article's own coordinates — only an article about the venue.
    for url in record.get("source_urls") or []:
        title = wikipedia_title(url)
        if title and title_is_about(name, title):
            coords = wikipedia_coords(url)
            if coords:
                result = accept(coords[0], coords[1], url, "wikipedia")
                if result:
                    return result, rejections
            break

    # 2. The venue itself, by name, with the returned name verified. When the
    # batch holds several branches under one name ("Twelve Triangles (Great
    # Junction Street)" and "Twelve Triangles (Easter Road)"), a name hit could be
    # either branch, so it is accepted only if its road appears in the record's
    # address; otherwise both branches land on the same node.
    queries = []
    if centre is not None:
        queries.append(f"{name}, {neighbourhood}, {city}")
    queries.append(f"{name}, {city}")
    for query in queries:
        for hit in nominatim(query, box):
            hit_name = hit.get("name") or (hit.get("display_name") or "").split(",")[0]
            if not names_match(name, hit_name):
                continue
            if ambiguous_name:
                road = ((hit.get("address") or {}).get("road") or "").lower()
                if not road or road not in address.lower():
                    rejections.append(f"osm-name: branch name, road {road or '?'} not in address ({osm_url(hit)})")
                    continue
            result = accept(float(hit["lat"]), float(hit["lon"]), osm_url(hit), "osm-name")
            if result:
                return result, rejections

    # 3. The street address. A road hit is kept, but labelled street-level. An
    # area hit (an OSM relation, or a boundary/place feature) is rejected: a
    # vague address like "West End, Edinburgh" resolves to a whole district.
    if address:
        for hit in nominatim(address, box):
            if hit.get("osm_type") == "relation" or hit.get("category") in ("boundary", "place"):
                rejections.append(f"osm-address: area-level hit ({osm_url(hit)})")
                continue
            method = "osm-street" if hit.get("category") == "highway" else "osm-address"
            result = accept(float(hit["lat"]), float(hit["lon"]), osm_url(hit), method)
            if result:
                return result, rejections

    return None, rejections


def save_atomically(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Fill missing coordinates on a consolidated batch from OpenStreetMap.")
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--city", default="Edinburgh")
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N records still missing coordinates.")
    parser.add_argument("--no-write", action="store_true", help="Print results without modifying the consolidated file.")
    parser.add_argument(
        "--recheck",
        action="store_true",
        help="First clear coordinates that came from an area-level source (a neighbourhood's Wikipedia "
        "article, an OSM relation) or a branch name shared in the batch, then geocode them again.",
    )
    args = parser.parse_args()

    box = CITY_VIEWBOXES.get(slug(args.city))
    if box is None:
        print(f"[geocode] no viewbox configured for {args.city!r}; add one to CITY_VIEWBOXES", file=sys.stderr)
        sys.exit(1)

    batch_dir = SCRAPER_DIR / "consolidated" / args.batch_id
    path = batch_dir / f"{slug(args.city)}.json"
    if not path.exists():
        print(f"[geocode] {path} not found — run merge_neighbourhood_batch.py first", file=sys.stderr)
        sys.exit(1)

    data = json.load(open(path))
    records = data.get("records", [])

    name_counts = Counter(norm(r.get("name") or "") for r in records)

    if args.recheck:
        cleared = []
        for r in records:
            if r.get("lat") is None:
                continue
            source = (r.get("field_sources") or {}).get("lat") or ""
            title = wikipedia_title(source)
            reason = None
            if title and not title_is_about(r.get("name") or "", title):
                reason = f"area article {title!r}"
            elif "openstreetmap.org/relation/" in source:
                reason = "area-level OSM relation"
            elif name_counts[norm(r.get("name") or "")] > 1 and "openstreetmap.org/" in source:
                reason = "branch name shared in batch"
            if reason:
                cleared.append({"name": r.get("name"), "was": [r["lat"], r["lng"]], "source": source, "reason": reason})
                r["lat"] = r["lng"] = None
                r.get("field_sources", {}).pop("lat", None)
                r.get("field_sources", {}).pop("lng", None)
        for c in cleared:
            print(f"[geocode] recheck: cleared {c['name']} ({c['reason']})", flush=True)
        print(f"[geocode] recheck: cleared {len(cleared)} suspect coordinates", flush=True)

    todo = [r for r in records if r.get("lat") is None or r.get("lng") is None]
    if args.limit:
        todo = todo[: args.limit]
    print(f"[geocode] {len(records)} records, {len(todo)} to geocode, write={'no' if args.no_write else 'yes'}", flush=True)

    hits = {"wikipedia": 0, "osm-name": 0, "osm-address": 0, "osm-street": 0}
    misses: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for i, record in enumerate(todo, start=1):
        try:
            result, reasons = geocode(record, args.city, box, name_counts[norm(record.get("name") or "")] > 1)
        except Exception as exc:  # one bad record must never kill the run
            print(f"[geocode] error on {record.get('name')!r}: {exc}", file=sys.stderr)
            result, reasons = None, [f"error: {exc}"]

        if reasons:
            rejected.append({"name": record.get("name"), "reasons": reasons})

        if result:
            lat, lng, source, method = result
            hits[method] += 1
            note = f" [after rejecting: {'; '.join(reasons)}]" if reasons else ""
            print(f"[geocode] {record.get('name')} -> {lat:.5f},{lng:.5f} via {method} ({source}){note}", flush=True)
            if not args.no_write:
                record["lat"], record["lng"] = round(lat, 6), round(lng, 6)
                sources = record.setdefault("field_sources", {})
                sources["lat"] = source
                sources["lng"] = source
        else:
            misses.append({**{k: record.get(k) for k in ("name", "address", "city", "category")}, "reasons": reasons})
            print(f"[geocode] {record.get('name')} -> no trustworthy match" + (f" [{'; '.join(reasons)}]" if reasons else ""), flush=True)

        if i % CHECKPOINT_EVERY == 0 or i == len(todo):
            print(f"[geocode] progress {i}/{len(todo)} | hits={sum(hits.values())} misses={len(misses)}", flush=True)
            if not args.no_write:
                save_atomically(path, data)

    report = {
        "processed": len(todo),
        "hits_by_method": hits,
        "misses": misses,
        "rejected_candidates": rejected,
        "max_km_from_neighbourhood": MAX_KM_FROM_NEIGHBOURHOOD,
        "attribution": "Coordinates from OpenStreetMap are ODbL: display '© OpenStreetMap contributors'.",
    }
    if not args.no_write:
        save_atomically(batch_dir / "_geocode_report.json", report)
    print(f"[geocode] done. hits={hits} misses={len(misses)}", flush=True)


if __name__ == "__main__":
    main()
