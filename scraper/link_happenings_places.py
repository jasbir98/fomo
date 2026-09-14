#!/usr/bin/env python3
"""
link_happenings_places.py — finds the live `places` row a `happenings` row's
venue actually refers to, and (only with --apply) writes `place_id` onto the
happening. This is the ONE write path the happenings pipeline is allowed to
make directly against live `happenings` (never `happenings_staging`'s content
columns, never `places`) — see the task brief this script was written for.

Why this exists: `happenings.place_id uuid references places(id)` has
existed since supabase/add_happenings.sql but was never backfilled — all 18
live rows have it null. Linking it lets the app join a happening onto its
place page (so e.g. Camera Obscura's resident discount shows up on Camera
Obscura's own place page) instead of the happening floating unattached.

Matching evidence, in order of what makes a link trustworthy:
  1. Normalized venue name match (strip "The", parentheticals, punctuation,
     common venue-word noise) between happenings.venue_name and places.name.
  2. Postcode match, when both addresses carry a UK postcode.
  3. Coordinate proximity (<=150m, haversine) when both rows have lat/lng.
A link needs name evidence PLUS at least one of postcode/distance to count as
"high" confidence; name evidence alone (no corroborating postcode/distance,
because one or both rows lack coordinates/postcode) is "medium". Nothing
below that is proposed at all — this script is a proposal tool, not an
auto-linker; a human reviews every proposed row before --apply (see
--min-confidence).

Area-level places (a street, a neighbourhood, a district-wide entry) are
explicitly rejected even on a strong name match — see AREA_NAME_RE — because
a happening's venue is a specific building/business, never a street.

Usage:
    python3 scraper/link_happenings_places.py                      # dry-run (default)
    python3 scraper/link_happenings_places.py --dry-run
    python3 scraper/link_happenings_places.py --apply                        # high-confidence only
    python3 scraper/link_happenings_places.py --apply --min-confidence medium
    python3 scraper/link_happenings_places.py --apply --batch-id edi-whatson-2026-09-13

--batch-id also patches place_id onto matching records (by normalized
venue_name) inside scraper/out/<batch-id>/*.json in place, so newly
researched happenings arrive at upsert_happenings.py already linked — the
brief's "sets place_id on the corresponding new JSON records before upsert".

Requires (read): SUPABASE_URL / SUPABASE_KEY (scraper/.env, anon key — both
happenings and places have an anon select policy).
Requires (--apply only, write): SUPABASE_SERVICE_ROLE_KEY, same credential
this pipeline's other write scripts use (see scripts/promote-happenings.mjs)
— happenings has no anon write policy. Read from .env.local if present,
falling back to scraper/.env, via the same precedence as llm_client.py.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

SCRAPER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRAPER_DIR.parent
OUT_ROOT = SCRAPER_DIR / "out"

load_dotenv(SCRAPER_DIR / ".env")
load_dotenv(REPO_ROOT / ".env.local", override=False)

import os  # noqa: E402 — after load_dotenv so os.environ is populated first.

sys.path.insert(0, str(SCRAPER_DIR))
from upsert_supabase import _get_credentials  # noqa: E402 — same anon-key loader as the rest of the pipeline.

MAX_DISTANCE_M = 150.0

# Rejects a place whose ENTIRE name is an area/street/neighbourhood
# reference rather than a specific venue — a happening's venue is always a
# building or business, never "Old Town" or "Princes Street" itself. Applied
# to the PLACE name only (a happening's venue_name failing this is fine —
# "Royal Mile" as a venue_name would just fail to match any place).
AREA_NAME_RE = re.compile(
    r"^(the\s+)?("
    r"old town|new town|southside|leith( shore)?|stockbridge|morningside|marchmont|"
    r"bruntsfield|portobello|corstorphine|newington|tollcross|dean village|"
    r"[a-z' ]+\s(street|road|avenue|place|walk|way|lane|terrace|gardens|crescent|row)|"
    r"[a-z' ]+\s(district|neighbourhood|neighborhood|area)"
    r")$",
    re.IGNORECASE,
)

UK_POSTCODE_RE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", re.IGNORECASE)

_STOPWORDS = {"the", "edinburgh", "cafe", "restaurant", "bar", "pub", "hotel", "shop", "store"}


def normalize_name(name: str | None) -> str:
    """Lowercase, strip parentheticals, strip punctuation, strip 'the'/city-noise
    words, collapse whitespace. Used for BOTH venue_name and place.name so the
    two sides are comparable — e.g. 'The Real Mary King's Close' and 'Real Mary
    King's Close (Edinburgh)' both normalize to 'real mary kings close'."""
    if not name:
        return ""
    n = name.lower()
    n = re.sub(r"\([^)]*\)", " ", n)  # parentheticals
    n = re.sub(r"[^a-z0-9\s]", " ", n)  # punctuation -> space (keeps word boundaries, e.g. king's -> kings)
    words = [w for w in n.split() if w and w not in _STOPWORDS]
    return " ".join(words)


def extract_postcode(address: str | None) -> str | None:
    if not address:
        return None
    m = UK_POSTCODE_RE.search(address)
    if not m:
        return None
    return f"{m.group(1).upper()} {m.group(2).upper()}"


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def name_match(happening_norm: str, place_norm: str) -> bool:
    """Exact match, or one fully contains the other as whole words — NOT a bare
    substring check (e.g. 'Bar' must not match inside 'Barony'). Requires the
    contained side to have AT LEAST 2 WORDS, deliberately no single-word
    exception: a single generic landmark word ("Castle", "Gardens", "Park",
    "Market") is exactly the false-positive this guards against — e.g. a
    happening venue_name of "Castle Terrace" (a street) must NOT match a
    place named "Edinburgh Castle" just because both contain the word
    "castle". Caught live on this exact pair during dry-run review — do not
    reintroduce a single-word path without a denylist of landmark nouns."""
    if not happening_norm or not place_norm:
        return False
    if happening_norm == place_norm:
        return True
    a_words, b_words = happening_norm.split(), place_norm.split()
    shorter, longer = (a_words, b_words) if len(a_words) <= len(b_words) else (b_words, a_words)
    if len(shorter) < 2:
        return False
    return " ".join(shorter) in " ".join(longer)


# --- REST helpers (anon read, service-role write) --------------------------


def rest_get_all(base_url: str, key: str, path: str) -> list[dict[str, Any]]:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    rows: list[dict[str, Any]] = []
    page_size = 1000
    offset = 0
    sep = "&" if "?" in path else "?"
    while True:
        resp = requests.get(
            f"{base_url}{path}{sep}limit={page_size}&offset={offset}", headers=headers, timeout=30
        )
        if resp.status_code >= 300:
            print(f"[link-happenings-places] GET {path} -> {resp.status_code}: {resp.text}", file=sys.stderr)
            resp.raise_for_status()
        page = resp.json()
        if not page:
            break
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows


def rest_patch(base_url: str, service_key: str, path: str, body: dict[str, Any]) -> None:
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    resp = requests.patch(f"{base_url}{path}", headers=headers, json=body, timeout=30)
    if resp.status_code >= 300:
        print(f"[link-happenings-places] PATCH {path} -> {resp.status_code}: {resp.text}", file=sys.stderr)
        resp.raise_for_status()


# --- matching ----------------------------------------------------------

PlaceIndexEntry = tuple[dict[str, Any], str, str | None]  # (place, normalized name, postcode)


def build_place_index(places: list[dict[str, Any]]) -> list[PlaceIndexEntry]:
    index = []
    for p in places:
        norm = normalize_name(p.get("name"))
        if not norm or AREA_NAME_RE.match((p.get("name") or "").strip()):
            continue
        index.append((p, norm, extract_postcode(p.get("address"))))
    return index


def match_venue(
    venue_name: str | None,
    address: str | None,
    lat: Any,
    lng: Any,
    place_index: list[PlaceIndexEntry],
) -> list[dict[str, Any]]:
    """Returns every candidate place match for one venue (name_match hits),
    each tagged with confidence + evidence. Same evidence rule everywhere in
    this script: name match alone is "medium"; name match PLUS a postcode or
    <=150m coordinate corroboration is "high"."""
    venue_norm = normalize_name(venue_name)
    if not venue_norm:
        return []
    venue_postcode = extract_postcode(address)

    hits = []
    for place, p_norm, p_postcode in place_index:
        if not name_match(venue_norm, p_norm):
            continue

        evidence = [f"name: {venue_name!r} ~ {place.get('name')!r}"]
        corroborated = False

        if venue_postcode and p_postcode and venue_postcode == p_postcode:
            evidence.append(f"postcode match: {venue_postcode}")
            corroborated = True

        if isinstance(lat, (int, float)) and isinstance(lng, (int, float)) \
                and isinstance(place.get("lat"), (int, float)) and isinstance(place.get("lng"), (int, float)):
            dist = haversine_m(lat, lng, place["lat"], place["lng"])
            if dist <= MAX_DISTANCE_M:
                evidence.append(f"distance: {dist:.0f}m")
                corroborated = True

        hits.append(
            {
                "place_id": place["id"],
                "place_name": place.get("name"),
                "confidence": "high" if corroborated else "medium",
                "evidence": "; ".join(evidence),
            }
        )
    return hits


def _best_per_key(items: list[dict[str, Any]], key: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Keeps the highest-confidence item per `key`, flags the rest (a venue
    matching >1 place, e.g. a chain) as ambiguous instead of silently
    dropping them. Returns (best, ambiguous_extras)."""
    best: dict[Any, dict[str, Any]] = {}
    for item in items:
        existing = best.get(item[key])
        if existing is None or (item["confidence"] == "high" and existing["confidence"] != "high"):
            best[item[key]] = item
    extra = [item for item in items if item is not best.get(item[key])]
    return list(best.values()), extra


def find_candidates(
    happenings: list[dict[str, Any]], places: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    place_index = build_place_index(places)

    candidates = []
    for h in happenings:
        if h.get("place_id"):
            continue  # already linked
        for hit in match_venue(h.get("venue_name"), h.get("address"), h.get("lat"), h.get("lng"), place_index):
            candidates.append(
                {
                    "happening_id": h["id"],
                    "happening_slug": h.get("slug"),
                    "happening_title": h.get("title"),
                    "venue_name": h.get("venue_name"),
                    **hit,
                }
            )

    best, extra = _best_per_key(candidates, "happening_id")
    for c in extra:
        c["evidence"] += " [AMBIGUOUS — another candidate place also matched; not auto-selected]"
    return best + extra


# --- batch JSON patch ----------------------------------------------------


def patch_batch_json(batch_id: str, places: list[dict[str, Any]], min_confidence: str) -> None:
    """Independently matches every record's OWN venue_name (not just the ones
    that happened to also be live happenings) against the full places index —
    so e.g. a brand-new whats-on record for a venue with no prior happening
    still gets place_id set here."""
    batch_dir = OUT_ROOT / batch_id
    if not batch_dir.is_dir():
        print(f"[link-happenings-places] no such batch dir: {batch_dir}", file=sys.stderr)
        return

    place_index = build_place_index(places)
    accept = {"high"} if min_confidence == "high" else {"high", "medium"}

    for json_path in sorted(batch_dir.glob("*.json")):
        try:
            data = json.loads(json_path.read_text())
        except Exception as exc:
            print(f"[link-happenings-places] skipping {json_path}: {exc}", file=sys.stderr)
            continue
        records = data.get("records") if isinstance(data, dict) else None
        if not isinstance(records, list):
            continue

        record_matches = []
        for idx, record in enumerate(records):
            if not isinstance(record, dict) or record.get("place_id"):
                continue
            for hit in match_venue(record.get("venue_name"), record.get("address"), record.get("lat"), record.get("lng"), place_index):
                record_matches.append({"idx": idx, **hit})
        best, _extra = _best_per_key(record_matches, "idx")

        changed = 0
        for m in best:
            if m["confidence"] not in accept:
                continue
            records[m["idx"]]["place_id"] = m["place_id"]
            changed += 1
            print(
                f"[link-happenings-places] batch {batch_id}: {records[m['idx']].get('title')!r} -> "
                f"{m['place_name']!r} ({m['confidence']})"
            )

        if changed:
            json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            print(f"[link-happenings-places] set place_id on {changed} record(s) in {json_path}")


# --- main --------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="Write place_id onto matched live happenings. Default is dry-run.")
    parser.add_argument(
        "--min-confidence", choices=["high", "medium"], default="high",
        help="Minimum confidence tier to actually --apply (dry-run always shows both). Default: high.",
    )
    parser.add_argument(
        "--batch-id", default=None,
        help="Also patch place_id onto matching records in scraper/out/<batch-id>/*.json (only with --apply).",
    )
    parser.add_argument(
        "--prefecture", default="City of Edinburgh",
        help="places.prefecture filter for candidate venues (default: 'City of Edinburgh').",
    )
    args = parser.parse_args()

    supabase_url, anon_key = _get_credentials()

    print(f"[link-happenings-places] fetching live happenings with a venue (scope=venue or venue_name set)...")
    happenings = rest_get_all(
        supabase_url, anon_key,
        "/rest/v1/happenings?status=eq.live"
        "&or=(scope.eq.venue,venue_name.not.is.null)"
        "&select=id,slug,title,scope,venue_name,address,district,city,lat,lng,place_id",
    )
    print(f"[link-happenings-places] {len(happenings)} live happening(s) have a venue.")

    print(f"[link-happenings-places] fetching live places (prefecture={args.prefecture!r})...")
    places = rest_get_all(
        supabase_url, anon_key,
        f"/rest/v1/places?prefecture=eq.{requests.utils.quote(args.prefecture)}"
        "&select=id,name,category,address,city,prefecture,lat,lng",
    )
    print(f"[link-happenings-places] {len(places)} live place(s) in scope.")

    candidates = find_candidates(happenings, places)
    already_linked = sum(1 for h in happenings if h.get("place_id"))
    unmatched = [h for h in happenings if not h.get("place_id") and h["id"] not in {c["happening_id"] for c in candidates}]

    print(f"\n[link-happenings-places] {len(candidates)} proposed link(s) "
          f"({already_linked} happening(s) already had a place_id):\n")
    for c in sorted(candidates, key=lambda c: (c["confidence"] != "high", c["happening_title"] or "")):
        print(f"  [{c['confidence']:>6}] {c['happening_title']!r} ({c['happening_slug']}) -> "
              f"{c['place_name']!r} ({c['place_id']})")
        print(f"           evidence: {c['evidence']}")

    if unmatched:
        print(f"\n[link-happenings-places] {len(unmatched)} venue happening(s) with NO matching live place "
              f"(do NOT create places for these — report them):")
        for h in unmatched:
            print(f"  - {h.get('title')!r} (venue_name={h.get('venue_name')!r}, slug={h.get('slug')})")

    if not args.apply:
        print("\n[link-happenings-places] DRY RUN — pass --apply to write place_id. Nothing written.")
        return

    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not service_key:
        print(
            "[link-happenings-places] --apply requires SUPABASE_SERVICE_ROLE_KEY "
            "(.env.local, same credential scripts/promote-happenings.mjs uses) — "
            "happenings has no anon write policy.",
            file=sys.stderr,
        )
        sys.exit(1)

    to_apply = [c for c in candidates if c["confidence"] == "high" or args.min_confidence == "medium"]
    print(f"\n[link-happenings-places] applying {len(to_apply)} link(s) at --min-confidence={args.min_confidence}...")
    applied = []
    for c in to_apply:
        try:
            rest_patch(
                supabase_url, service_key,
                f"/rest/v1/happenings?id=eq.{c['happening_id']}",
                {"place_id": c["place_id"]},
            )
            applied.append(c)
            print(f"  OK  {c['happening_title']!r} -> {c['place_name']!r}")
        except Exception as exc:
            print(f"  FAILED {c['happening_title']!r}: {exc}", file=sys.stderr)

    print(f"[link-happenings-places] applied {len(applied)}/{len(to_apply)} link(s).")

    if args.batch_id:
        patch_batch_json(args.batch_id, places, args.min_confidence)


if __name__ == "__main__":
    main()
