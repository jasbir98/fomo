#!/usr/bin/env python3
"""
merge_neighbourhood_batch.py — collapse the duplicates a per-neighbourhood
research batch produces, before anything is geocoded or upserted.

Why this exists: run_city_batch.py researches one neighbourhood at a time, and
neighbourhoods overlap — a Grassmarket pub is also an Old Town pub, a
Bruntsfield bar is also a Tollcross bar. build_dedupe_key() includes the
neighbourhood (`name:city-of-edinburgh:bruntsfield:bennets-bar`), so without
this step each overlap lands in places_staging as a separate row and, after
promotion, as duplicate live places. The first Edinburgh local batch
(edi-local-2026-09-12) had 488 records, 59 duplicate groups, 67 duplicate rows.

Merge rule — deliberately conservative:
  Two records merge when their normalised names match (lowercase, a leading
  "the" dropped, non-alphanumerics removed) AND their postcodes are compatible:
  equal, or at least one record has no postcode. Differing postcodes keep the
  records separate. That is what stops two branches of a chain ("BrewDog" on
  two streets) collapsing into one pin, at the cost of occasionally keeping one
  long feature as two entries (the Water of Leith Walkway's two access points).
  Street-number parsing was rejected as the guard: in the real batch every
  "different address" case was a formatting variant of the same venue
  ("45 Shore" vs "45 The Shore", "32-34 Grassmarket" vs "32 Grassmarket").

Field resolution within a merged group:
  - The primary record is the one with the most source_urls, then a non-null
    price_level, then coordinates. Ties keep file order, so output is stable.
  - Scalars take the first non-null value, primary first.
  - source_urls are unioned (order preserved); field_sources are merged per
    field, primary wins.
  - dedupe_key is rebuilt without the neighbourhood, with a postcode suffix
    when a same-name group had to be split, so every output key is unique.

Reads:  out/<batch-id>/*.json
Writes: consolidated/<batch-id>/<city-slug>.json   ({"records": [...]})
        consolidated/<batch-id>/_merge_report.json  (every merge and split)

No network, no LLM, no database. Idempotent: rerunning overwrites the outputs.

Usage:
    python3 scraper/merge_neighbourhood_batch.py --batch-id edi-local-2026-09-12 --city Edinburgh
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

SCRAPER_DIR = Path(__file__).resolve().parent

_POSTCODE_RE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", re.IGNORECASE)


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")


def name_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", re.sub(r"^the\s+", "", (name or "").strip().lower()))


def postcode(address: str | None) -> str | None:
    m = _POSTCODE_RE.search(address or "")
    return f"{m.group(1)}{m.group(2)}".upper() if m else None


def primary_rank(record: dict[str, Any]) -> tuple[int, int, int]:
    return (
        -len(record.get("source_urls") or []),
        0 if record.get("price_level") is not None else 1,
        0 if record.get("lat") is not None and record.get("lng") is not None else 1,
    )


def cluster_by_postcode(records: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Split one same-name group into clusters whose postcodes don't conflict.
    Records without a postcode join the first cluster (compatible with any)."""
    with_pc: dict[str, list[dict[str, Any]]] = defaultdict(list)
    without_pc: list[dict[str, Any]] = []
    for r in records:
        pc = postcode(r.get("address"))
        (with_pc[pc] if pc else without_pc).append(r)
    if not with_pc:
        return [without_pc]
    clusters = [with_pc[pc] for pc in with_pc]
    clusters[0] = clusters[0] + without_pc
    return clusters


def merge_cluster(cluster: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(cluster, key=primary_rank)
    merged: dict[str, Any] = {}
    for record in ordered:
        for key, value in record.items():
            if key in ("source_urls", "field_sources"):
                continue
            if merged.get(key) is None and value is not None:
                merged[key] = value

    urls: list[str] = []
    for record in ordered:
        for url in record.get("source_urls") or []:
            if url not in urls:
                urls.append(url)
    merged["source_urls"] = urls

    field_sources: dict[str, Any] = {}
    for record in ordered:
        for field, src in (record.get("field_sources") or {}).items():
            field_sources.setdefault(field, src)
    merged["field_sources"] = field_sources
    return merged


# ---------------------------------------------------------------------------
# --post-geocode: a second, location-aware pass over the consolidated file.
#
# The name pass above can't see "The Cameo" and "The Cameo Picturehouse", or
# "Teuchters" and "Teuchters Bar", as one venue: the names differ. After
# geocode_osm.py has run, location settles it. In the first Edinburgh batch this
# found seven such pairs.
#
# Two records merge when their names are compatible AND their locations agree:
#   names:    equal after stripping "the" and parenthetical qualifiers, or one
#             contains the other with at most MAX_QUALIFIER_CHARS extra
#             ("bar", "picturehouse", "henryhalls"). The cap keeps "Bruntsfield
#             Links" apart from "Bruntsfield Links short-hole golf course".
#   location: the same coordinate source object (OSM node/way, or the same
#             Wikipedia article), or the same postcode, or pins within
#             SAME_SPOT_METRES. The distance is tight on purpose: "The Raeburn"
#             and the street "Raeburn Place" are ~140 m apart and must not merge.
# ---------------------------------------------------------------------------

MAX_QUALIFIER_CHARS = 12
SAME_SPOT_METRES = 60

_PARENTHETICAL = re.compile(r"\s*\([^)]*\)")
_OSM_OBJECT = re.compile(r"openstreetmap\.org/(node|way|relation)/(\d+)")
_MAPCARTA_OBJECT = re.compile(r"mapcarta\.com/([NW])(\d+)")
_WIKI_TITLE = re.compile(r"wikipedia\.org/wiki/([^?#]+)")


def venue_name_key(name: str) -> str:
    return name_key(_PARENTHETICAL.sub("", name or ""))


def names_compatible(a: str, b: str) -> bool:
    ka, kb = venue_name_key(a), venue_name_key(b)
    if not ka or not kb:
        return False
    if ka == kb:
        return True
    short, long_ = sorted((ka, kb), key=len)
    return len(short) >= 5 and short in long_ and len(long_) - len(short) <= MAX_QUALIFIER_CHARS


def coordinate_object(record: dict[str, Any]) -> str | None:
    source = (record.get("field_sources") or {}).get("lat") or ""
    if m := _OSM_OBJECT.search(source):
        return f"osm:{m.group(1)}/{m.group(2)}"
    if m := _MAPCARTA_OBJECT.search(source):
        return f"osm:{'node' if m.group(1) == 'N' else 'way'}/{m.group(2)}"
    if m := _WIKI_TITLE.search(source):
        return f"wiki:{m.group(1).lower()}"
    return None


def metres_apart(a: dict[str, Any], b: dict[str, Any]) -> float | None:
    if None in (a.get("lat"), a.get("lng"), b.get("lat"), b.get("lng")):
        return None
    lat1, lng1, lat2, lng2 = map(math.radians, (a["lat"], a["lng"], b["lat"], b["lng"]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 6371000.0 * 2 * math.asin(math.sqrt(h))


# A street or route shares its name, and its pin, with the venues on it: "Thistle
# Street" (the street) sits 23 m from "Thistle Street Bar". Never merge one of
# these into a record that isn't.
STREETLIKE_CATEGORIES = {"street", "walking route", "neighbourhood", "area", "square"}


def same_venue(a: dict[str, Any], b: dict[str, Any]) -> str | None:
    """The reason two records are one venue, or None."""
    if not names_compatible(a.get("name") or "", b.get("name") or ""):
        return None
    streetlike_a = (a.get("category") or "").lower() in STREETLIKE_CATEGORIES
    streetlike_b = (b.get("category") or "").lower() in STREETLIKE_CATEGORIES
    if streetlike_a != streetlike_b:
        return None
    pa, pb = postcode(a.get("address")), postcode(b.get("address"))
    if pa and pb and pa != pb:
        return None
    oa, ob = coordinate_object(a), coordinate_object(b)
    if oa and oa == ob:
        return f"same coordinate source {oa}"
    if pa and pa == pb:
        return f"same postcode {pa}"
    d = metres_apart(a, b)
    if d is not None and d <= SAME_SPOT_METRES:
        return f"pins {d:.0f} m apart"
    return None


def post_geocode_merge(batch_id: str, city: str) -> None:
    dst_dir = SCRAPER_DIR / "consolidated" / batch_id
    path = dst_dir / f"{slug(city)}.json"
    if not path.exists():
        print(f"[merge] {path} not found — run the name merge and geocode_osm.py first", file=sys.stderr)
        sys.exit(1)
    records = json.load(open(path))["records"]

    parent = list(range(len(records)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    reasons: dict[int, list[str]] = defaultdict(list)
    for i in range(len(records)):
        for j in range(i + 1, len(records)):
            reason = same_venue(records[i], records[j])
            if reason:
                parent[find(j)] = find(i)
                reasons[i].append(f"{records[j]['name']}: {reason}")

    clusters: dict[int, list[int]] = defaultdict(list)
    for i in range(len(records)):
        clusters[find(i)].append(i)

    out_records, merges = [], []
    for root, members in clusters.items():
        cluster = [records[i] for i in members]
        if len(cluster) == 1:
            out_records.append(cluster[0])
            continue
        merged = merge_cluster(cluster)
        primary = sorted(cluster, key=primary_rank)[0]
        merged["dedupe_key"] = primary["dedupe_key"]
        # Keep the coordinate and its citation from the same record.
        located = next((r for r in sorted(cluster, key=primary_rank) if r.get("lat") is not None), None)
        if located:
            merged["lat"], merged["lng"] = located["lat"], located["lng"]
            for field in ("lat", "lng"):
                if field in (located.get("field_sources") or {}):
                    merged["field_sources"][field] = located["field_sources"][field]
        merges.append({
            "kept": merged["name"],
            "names": [r["name"] for r in cluster],
            "reasons": [x for i in members for x in reasons.get(i, [])],
        })
        out_records.append(merged)

    keys = [r["dedupe_key"] for r in out_records]
    if len(keys) != len(set(keys)):
        print("[merge] refusing to write: non-unique dedupe_keys after post-geocode merge", file=sys.stderr)
        sys.exit(1)

    json.dump({"records": out_records}, open(path, "w"), indent=2, ensure_ascii=False)
    report_path = dst_dir / "_merge_report.json"
    report = json.load(open(report_path)) if report_path.exists() else {}
    report["post_geocode"] = {"input_records": len(records), "output_records": len(out_records), "merges": merges}
    json.dump(report, open(report_path, "w"), indent=2, ensure_ascii=False)
    for m in merges:
        print(f"[merge] {' + '.join(m['names'])}  ({'; '.join(m['reasons'])})")
    print(f"[merge] post-geocode: {len(records)} -> {len(out_records)} ({len(merges)} merged groups). Wrote {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--city", required=True, help="City name, used for the output filename, e.g. Edinburgh.")
    parser.add_argument(
        "--post-geocode",
        action="store_true",
        help="Instead of merging raw neighbourhood files, merge same-venue records in the geocoded "
        "consolidated file by name + location.",
    )
    args = parser.parse_args()

    if args.post_geocode:
        post_geocode_merge(args.batch_id, args.city)
        return

    src_dir = SCRAPER_DIR / "out" / args.batch_id
    files = sorted(glob.glob(str(src_dir / "*.json")))
    if not files:
        print(f"[merge] no files in {src_dir}", file=sys.stderr)
        sys.exit(1)

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    total_in = 0
    for path in files:
        hood = Path(path).stem
        for record in json.load(open(path)).get("records", []):
            if not record.get("name"):
                continue
            record["_neighbourhood"] = hood
            groups[name_key(record["name"])].append(record)
            total_in += 1

    out_records: list[dict[str, Any]] = []
    merges, splits = [], []
    for key, members in groups.items():
        clusters = cluster_by_postcode(members)
        split = len(clusters) > 1
        if split:
            splits.append({
                "name": members[0]["name"],
                "clusters": [
                    {"postcode": postcode(c[0].get("address")), "neighbourhoods": [r["_neighbourhood"] for r in c]}
                    for c in clusters
                ],
            })
        for cluster in clusters:
            record = merge_cluster(cluster)
            hoods = [r["_neighbourhood"] for r in cluster]
            if len(cluster) > 1:
                merges.append({"name": record["name"], "neighbourhoods": hoods, "rows": len(cluster)})
            prefecture = record.get("prefecture") or args.city
            dedupe = f"name:{slug(prefecture)}:{slug(record['name'])}"
            pc = postcode(record.get("address"))
            if split and pc:
                dedupe += f":{pc.lower()}"
            record["dedupe_key"] = dedupe
            record.pop("_neighbourhood", None)
            out_records.append(record)

    keys = [r["dedupe_key"] for r in out_records]
    if len(keys) != len(set(keys)):
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        print(f"[merge] refusing to write: non-unique dedupe_keys {dupes[:5]}", file=sys.stderr)
        sys.exit(1)

    dst_dir = SCRAPER_DIR / "consolidated" / args.batch_id
    dst_dir.mkdir(parents=True, exist_ok=True)
    out_path = dst_dir / f"{slug(args.city)}.json"
    json.dump({"records": out_records}, open(out_path, "w"), indent=2, ensure_ascii=False)
    json.dump(
        {"input_records": total_in, "output_records": len(out_records), "merges": merges, "splits": splits},
        open(dst_dir / "_merge_report.json", "w"),
        indent=2,
        ensure_ascii=False,
    )
    print(
        f"[merge] {total_in} records from {len(files)} files -> {len(out_records)} "
        f"({len(merges)} merged groups, {len(splits)} split by postcode). Wrote {out_path}"
    )


if __name__ == "__main__":
    main()
