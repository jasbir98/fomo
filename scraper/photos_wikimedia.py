#!/usr/bin/env python3
"""
photos_wikimedia.py — attach Wikimedia Commons photos to live Edinburgh
`places` rows (prefecture = "City of Edinburgh") that have none yet.

Why Wikimedia only: free, license-clean, and per-file attribution is always
available — unlike Google Places photos or scraped review-site images, which
this pipeline is explicitly forbidden from using (see task brief).

Resolution order per place, stopping at the first candidate that clears the
license + size checks (each gated by a name/coordinate verification so we
never attach a neighbourhood or area photo to a single venue):

  1. osm-wikidata-tag / osm-commons-tag / osm-image-tag — the OSM node/way/
     relation that a places_staging row's field_sources.lat/lng already cites
     for this place (from scraper/geocode_osm.py). Re-fetched and accepted
     only if that OSM object's own `name` tag matches the place's name —
     otherwise the object could be a street or area, not the venue.
  2. wikipedia-wikidata / wikipedia-originalimage — a Wikipedia article cited
     in the staging row's source_urls, accepted only if the article's TITLE
     is about the venue itself (same guard as geocode_osm.py's
     title_is_about, reused here) — not a neighbourhood article that happens
     to mention it.
  3. wikidata-search — last resort: search Wikidata by "<name>, Edinburgh",
     accepted only if the candidate's label name-matches AND its P625
     coordinate is within ~300 m of the place's own lat/lng. Places with no
     lat/lng are skipped for this method (nothing to verify against).

Only CC0 / Public domain / CC BY (any version) / CC BY-SA (any version)
files are accepted. Everything else (NC, ND, unknown, all-rights-reserved)
is rejected.

Idempotent: places that already have a place_photos row are skipped
untouched. Safe to re-run; in-process caches make a rerun cheap, and
progress is printed as it goes so a killed run loses nothing already
committed to the database.

Usage:
    python3 scraper/photos_wikimedia.py --dry-run --limit 20
    python3 scraper/photos_wikimedia.py
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any

import requests
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "scraper" / "out" / "photos-2026-09-13"
OUT_DIR.mkdir(parents=True, exist_ok=True)

UA = "FomoPhotos/1.0 (Fomo Edinburgh app; low-volume batch)"
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept": "application/json"})

OSM_API = "https://api.openstreetmap.org/api/0.6"
WD_SEARCH = "https://www.wikidata.org/w/api.php"
WD_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData"
WP_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"

MAX_KM_FOR_SEARCH_MATCH = 0.3  # 300 m, per brief
MIN_THUMB_WIDTH = 300  # below this, treat as icon/unusable rather than a real photo
OK_THUMB_WIDTH = 800  # matches places.image_quality 'ok' threshold (add_places_ranking_signals.sql)

_last = {"osm": 0.0, "wd": 0.0, "wp": 0.0, "cm": 0.0}
_gap = {"osm": 1.1, "wd": 0.4, "wp": 0.3, "cm": 0.4}


def throttle(kind: str) -> None:
    wait = _gap[kind] - (time.time() - _last[kind])
    if wait > 0:
        time.sleep(wait)
    _last[kind] = time.time()


def safe_get(kind: str, url: str, **kwargs) -> requests.Response | None:
    """GET with this module's throttle + retry-with-backoff on 429/5xx.
    Returns None (never raises) on repeated failure so one bad lookup can't
    kill the run."""
    for attempt in range(4):
        throttle(kind)
        try:
            r = S.get(url, timeout=kwargs.pop("timeout", 20), **kwargs)
        except Exception as exc:
            if attempt == 3:
                print(f"[photos] {kind} network error for {url}: {exc}", file=sys.stderr)
                return None
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 429 or r.status_code >= 500:
            retry_after = r.headers.get("Retry-After")
            wait = float(retry_after) if retry_after and retry_after.isdigit() else (2 ** attempt) * 2
            if attempt == 3:
                print(f"[photos] {kind} giving up after {r.status_code} for {url}", file=sys.stderr)
                return None
            print(f"[photos] {kind} got {r.status_code}, backing off {wait:.0f}s", file=sys.stderr)
            time.sleep(wait)
            continue
        return r
    return None


# ---- env / supabase ---------------------------------------------------------

def load_env() -> dict:
    # places and place_photos have no anon/authenticated write policy (see
    # supabase/lock_pipeline_tables.sql / harden_rls.sql) — only the
    # service-role key works here, so it's required with no anon fallback.
    env = {
        **dotenv_values(ROOT / "scraper" / ".env"),
        **dotenv_values(ROOT / ".env.local"),
    }
    url = env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit(
            "ERROR: missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) / "
            "SUPABASE_SERVICE_ROLE_KEY in .env.local or scraper/.env — places "
            "and place_photos have no anon write policy."
        )
    return {"url": url, "key": key}


class Supa:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/rest/v1"
        self.h = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def get(self, table: str, params: dict) -> list[dict]:
        out: list[dict] = []
        offset = 0
        page = 1000
        while True:
            p = {**params, "limit": page, "offset": offset}
            r = S.get(f"{self.base}/{table}", headers=self.h, params=p, timeout=30)
            r.raise_for_status()
            batch = r.json()
            out.extend(batch)
            if len(batch) < page:
                break
            offset += page
        return out

    def insert(self, table: str, rows: list[dict]) -> requests.Response:
        h = {**self.h, "Prefer": "return=representation"}
        return S.post(f"{self.base}/{table}", headers=h, json=rows, timeout=30)

    def patch(self, table: str, row_id: str, payload: dict) -> requests.Response:
        return S.patch(
            f"{self.base}/{table}", headers=self.h,
            params={"id": f"eq.{row_id}"}, json=payload, timeout=30,
        )


# ---- name / geo helpers (mirrors scraper/geocode_osm.py) -------------------

_PARENTHETICAL = re.compile(r"\s*\([^)]*\)")


def clean_name(value: str) -> str:
    return _PARENTHETICAL.sub("", value or "").strip()


def norm(value: str) -> str:
    # Strip punctuation but KEEP word boundaries (collapsed to one space) —
    # fully removing spaces made "Stock Bridge" (a viewpoint) normalize
    # identically to "Stockbridge" (the neighbourhood), which let a
    # neighbourhood-level Wikipedia article slip past title_is_about and
    # attach an unrelated street photo. A real-world case caught by the
    # 2026-09-13 Edinburgh run's post-hoc Wikidata-label audit.
    s = re.sub(r"^the\s+", "", clean_name(value).lower())
    s = re.sub(r"[^a-z0-9\s]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def names_match(wanted: str, got: str) -> bool:
    a, b = norm(wanted), norm(got)
    if not a or not b:
        return False
    if min(len(a), len(b)) < 5:
        return a == b
    return a in b or b in a


def title_is_about(name: str, title: str) -> bool:
    a, b = norm(name), norm(title.split(",")[0])
    if not a or not b:
        return False
    return a == b if min(len(a), len(b)) < 5 else a in b


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 6371.0 * 2 * math.asin(math.sqrt(h))


def strip_html(t: str | None) -> str | None:
    if not t:
        return t
    return re.sub(r"<[^>]+>", "", t).strip()


# ---- license gate ------------------------------------------------------------

def license_ok(license_short: str | None) -> bool:
    """Accept only CC0, Public domain, CC BY (any version), CC BY-SA (any
    version). Rejects NC/ND variants and anything unrecognised."""
    if not license_short:
        return False
    t = license_short.strip().lower()
    if t.startswith("cc0") or t.startswith("public domain") or t.startswith("pdm"):
        return True
    return bool(re.match(r"^cc by(-sa)?( \d(\.\d)?)?$", t))


# ---- OSM ----------------------------------------------------------------

_OSM_URL_RE = re.compile(r"openstreetmap\.org/(node|way|relation)/(\d+)")
_osm_cache: dict[str, dict | None] = {}


def osm_tags(osm_type: str, osm_id: str) -> dict | None:
    key = f"{osm_type}/{osm_id}"
    if key in _osm_cache:
        return _osm_cache[key]
    r = safe_get("osm", f"{OSM_API}/{osm_type}/{osm_id}.json")
    tags = None
    if r is not None and r.status_code == 200:
        try:
            els = r.json().get("elements") or []
            tags = els[0].get("tags") if els else None
        except Exception:
            tags = None
    _osm_cache[key] = tags
    return tags


def find_osm_refs(field_sources: dict) -> list[tuple[str, str]]:
    refs = []
    for v in (field_sources or {}).values():
        if not isinstance(v, str):
            continue
        m = _OSM_URL_RE.search(v)
        if m:
            refs.append((m.group(1), m.group(2)))
    # de-dup, keep order
    seen = set()
    out = []
    for r in refs:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


# ---- Wikipedia -------------------------------------------------------------

_WP_URL_RE = re.compile(r"en\.wikipedia\.org/wiki/([^?#]+)")
_wp_cache: dict[str, dict | None] = {}


def wp_title_from_url(url: str) -> str | None:
    m = _WP_URL_RE.search(url or "")
    return urllib.parse.unquote(m.group(1)).replace("_", " ") if m else None


def wp_summary(title: str) -> dict | None:
    if title in _wp_cache:
        return _wp_cache[title]
    r = safe_get("wp", WP_SUMMARY + urllib.parse.quote(title, safe=""))
    data = None
    if r is not None and r.status_code == 200:
        try:
            data = r.json()
        except Exception:
            data = None
    _wp_cache[title] = data
    return data


def find_wikipedia_urls(staging: dict) -> list[str]:
    urls = list(staging.get("source_urls") or [])
    for v in (staging.get("field_sources") or {}).values():
        if isinstance(v, str) and "wikipedia.org/wiki/" in v:
            urls.append(v)
    seen = set()
    out = []
    for u in urls:
        if "wikipedia.org/wiki/" in u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


# ---- Wikidata --------------------------------------------------------------

_wd_entity_cache: dict[str, dict | None] = {}


def wd_entity(qid: str) -> dict | None:
    if qid in _wd_entity_cache:
        return _wd_entity_cache[qid]
    r = safe_get("wd", f"{WD_ENTITY}/{qid}.json")
    ent = None
    if r is not None and r.status_code == 200:
        try:
            ent = r.json().get("entities", {}).get(qid)
        except Exception:
            ent = None
    _wd_entity_cache[qid] = ent
    return ent


def wd_claim_value(entity: dict, prop: str):
    try:
        c = entity["claims"][prop][0]["mainsnak"]
        if c.get("snaktype") != "value":
            return None
        return c["datavalue"]["value"]
    except Exception:
        return None


def wd_image_filename(entity: dict) -> str | None:
    v = wd_claim_value(entity, "P18")
    return v if isinstance(v, str) else None


def wd_coord(entity: dict) -> tuple[float, float] | None:
    v = wd_claim_value(entity, "P625")
    if isinstance(v, dict) and "latitude" in v:
        return v["latitude"], v["longitude"]
    return None


def wd_label(entity: dict) -> str | None:
    try:
        return entity["labels"]["en"]["value"]
    except Exception:
        return None


def wd_entity_names(entity: dict) -> list[str]:
    """Every English name this entity is known by: primary label, aliases,
    and its enwiki sitelink title (often the most precise — see
    Corstorphine Old Parish Church / Q17570258, labelled "Corstorphine
    Collegiate Church" but sitelinked to the article the record actually
    matches)."""
    names = []
    lbl = wd_label(entity)
    if lbl:
        names.append(lbl)
    try:
        names.extend(a["value"] for a in entity.get("aliases", {}).get("en", []))
    except Exception:
        pass
    try:
        names.append(entity["sitelinks"]["enwiki"]["title"])
    except Exception:
        pass
    return names


def wd_entity_matches_name(name: str, entity: dict) -> bool:
    """Guards every QID-based candidate (osm-wikidata-tag, wikipedia-wikidata,
    wikidata-search alike) against the failure mode a 2026-09-13 post-hoc
    audit found: an OSM way's own `name` tag matched the place ("Saint
    Martin of Tours Episcopal Church"), but its `wikidata=` tag pointed at
    an unrelated entity (Q17806061, labelled "Gorgie Baptist Church, Dalry
    Road, Edinburgh") — a genuine upstream OSM tagging error that a
    same-object name check alone can't catch."""
    return any(names_match(name, n) for n in wd_entity_names(entity))


def wd_search(query: str) -> list[dict]:
    r = safe_get(
        "wd", WD_SEARCH,
        params={"action": "wbsearchentities", "format": "json", "language": "en",
                "type": "item", "limit": 5, "search": query},
    )
    if r is None or r.status_code != 200:
        return []
    try:
        return r.json().get("search", [])
    except Exception:
        return []


# ---- Commons ----------------------------------------------------------------

_commons_cache: dict[str, dict | None] = {}


def commons_imageinfo(filename: str) -> dict | None:
    """(url, thumbwidth, license, credit, source_url) for a Commons file, or
    None if the file can't be resolved."""
    fn = filename.replace(" ", "_")
    if fn.startswith("File:"):
        fn = fn[len("File:"):]
    if fn in _commons_cache:
        return _commons_cache[fn]
    r = safe_get(
        "cm", COMMONS_API,
        params={
            "action": "query", "format": "json", "prop": "imageinfo",
            "iiprop": "url|extmetadata", "iiurlwidth": 1000,
            "titles": "File:" + fn,
        },
    )
    if r is None or r.status_code != 200:
        _commons_cache[fn] = None
        return None
    try:
        pages = r.json().get("query", {}).get("pages", {})
        result = None
        for _, page in pages.items():
            ii = page.get("imageinfo")
            if not ii:
                continue
            info = ii[0]
            meta = info.get("extmetadata", {}) or {}

            def m(k):
                v = meta.get(k, {})
                return v.get("value") if isinstance(v, dict) else None

            result = {
                "url": info.get("thumburl") or info.get("url"),
                "thumbwidth": info.get("thumbwidth") or info.get("width"),
                "license": m("LicenseShortName") or m("License"),
                "credit": strip_html(m("Artist") or m("Credit")),
                "source_url": info.get("descriptionurl") or f"https://commons.wikimedia.org/wiki/File:{fn}",
            }
        _commons_cache[fn] = result
        return result
    except Exception:
        _commons_cache[fn] = None
        return None


def commons_filename_from_url(url: str) -> str | None:
    """Extract a Commons filename from an upload.wikimedia.org / commons.wikimedia.org URL."""
    if not url:
        return None
    path = urllib.parse.urlsplit(url).path  # drop query string (utm_* params etc.)
    m = re.search(r"/commons/(?:thumb/)?[0-9a-f]/[0-9a-f]{2}/([^/]+?)(?:/\d+px-[^/]+)?$", path)
    if m:
        return urllib.parse.unquote(m.group(1))
    m = re.search(r"wiki/File:([^/]+)$", path)
    if m:
        return urllib.parse.unquote(m.group(1))
    return None


# ---- candidate resolution ----------------------------------------------------

def gather_candidates(place: dict, staging: dict | None) -> list[dict]:
    """Return an ordered list of {filename, qid, method, evidence} candidates,
    highest-priority first, each already name/geo-verified at this stage."""
    candidates: list[dict] = []
    name = place["name"]

    if staging:
        # 1. OSM tags on the object that supplied this place's own coordinates.
        for osm_type, osm_id in find_osm_refs(staging.get("field_sources") or {}):
            tags = osm_tags(osm_type, osm_id)
            if not tags:
                continue
            osm_name = tags.get("name")
            if not osm_name or not names_match(name, osm_name):
                continue  # not a name-verified match to this venue — could be a street/area
            evidence = f"https://www.openstreetmap.org/{osm_type}/{osm_id}"
            if tags.get("wikidata"):
                candidates.append({"qid": tags["wikidata"], "filename": None,
                                    "method": "osm-wikidata-tag", "evidence": evidence})
            wc = tags.get("wikimedia_commons")
            if wc and wc.startswith("File:"):
                candidates.append({"qid": None, "filename": wc,
                                    "method": "osm-commons-tag", "evidence": evidence})
            img = tags.get("image")
            if img and ("wikimedia.org" in img or "commons.wikimedia" in img):
                fn = commons_filename_from_url(img)
                if fn:
                    candidates.append({"qid": None, "filename": fn,
                                        "method": "osm-image-tag", "evidence": evidence})

        # 2. A cited Wikipedia article that is about the venue itself.
        for url in find_wikipedia_urls(staging):
            title = wp_title_from_url(url)
            if not title or not title_is_about(name, title):
                continue
            summary = wp_summary(title)
            if not summary:
                continue
            qid = summary.get("wikibase_item")
            if qid:
                candidates.append({"qid": qid, "filename": None,
                                    "method": "wikipedia-wikidata", "evidence": url})
            orig = (summary.get("originalimage") or {}).get("source")
            fn = commons_filename_from_url(orig) if orig else None
            if fn:
                candidates.append({"qid": None, "filename": fn,
                                    "method": "wikipedia-originalimage", "evidence": url})

    # 3. Wikidata search fallback — only when we can verify by coordinate.
    if place.get("lat") is not None and place.get("lng") is not None:
        for hit in wd_search(f"{clean_name(name)}, Edinburgh"):
            label = hit.get("label") or ""
            if not names_match(name, label):
                continue
            qid = hit["id"]
            ent = wd_entity(qid)
            if not ent:
                continue
            coord = wd_coord(ent)
            if not coord:
                continue
            km = haversine_km(coord, (place["lat"], place["lng"]))
            if km > MAX_KM_FOR_SEARCH_MATCH:
                continue
            candidates.append({"qid": qid, "filename": None, "method": "wikidata-search",
                                "evidence": f"https://www.wikidata.org/wiki/{qid} ({km*1000:.0f}m)"})

    return candidates


def resolve_photo(place: dict, staging: dict | None, rejects: list[str]) -> dict | None:
    for cand in gather_candidates(place, staging):
        filename = cand["filename"]
        if not filename and cand["qid"]:
            ent = wd_entity(cand["qid"])
            if not ent:
                rejects.append(f"{cand['method']}: wikidata entity {cand['qid']} not found")
                continue
            if not wd_entity_matches_name(place["name"], ent):
                rejects.append(f"{cand['method']}: {cand['qid']} ({wd_label(ent)!r}) doesn't name-match "
                                f"{place['name']!r} — likely a mistagged source, not a synonym")
                continue
            filename = wd_image_filename(ent)
            if not filename:
                rejects.append(f"{cand['method']}: {cand['qid']} has no P18 image")
                continue
        info = commons_imageinfo(filename)
        if not info or not info.get("url"):
            rejects.append(f"{cand['method']}: commons file {filename!r} not resolvable")
            continue
        if not license_ok(info.get("license")):
            rejects.append(f"{cand['method']}: {filename!r} license {info.get('license')!r} not reusable")
            continue
        width = info.get("thumbwidth") or 0
        if width and width < MIN_THUMB_WIDTH:
            rejects.append(f"{cand['method']}: {filename!r} too small ({width}px)")
            continue
        return {**info, "method": cand["method"], "evidence": cand["evidence"],
                "filename": filename, "width": width}
    return None


# ---- main -------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    env = load_env()
    supa = Supa(env["url"], env["key"])

    places = supa.get("places", {
        "select": "id,name,category,lat,lng,address,image_url,image_quality",
        "prefecture": "eq.City of Edinburgh",
    })
    existing_photo_ids = {
        r["place_id"] for r in supa.get("place_photos", {"select": "place_id"})
    }
    staging_rows = supa.get("places_staging", {
        "select": "place_id,name,field_sources,source_urls,lat,lng",
    })
    staging_by_place: dict[str, dict] = {}
    for s in staging_rows:
        if s.get("place_id") and s["place_id"] not in staging_by_place:
            staging_by_place[s["place_id"]] = s

    todo = [p for p in places if p["id"] not in existing_photo_ids]
    print(f"[photos] {len(places)} Edinburgh places, {len(todo)} without a photo yet, "
          f"write={'no' if args.dry_run else 'yes'}", flush=True)
    if args.limit:
        todo = todo[: args.limit]

    attached: list[dict] = []
    missed: list[dict] = []
    by_category_attached: dict[str, int] = {}
    by_category_total: dict[str, int] = {}

    for i, place in enumerate(todo, start=1):
        cat = place.get("category") or "unknown"
        by_category_total[cat] = by_category_total.get(cat, 0) + 1
        staging = staging_by_place.get(place["id"])
        rejects: list[str] = []
        try:
            photo = resolve_photo(place, staging, rejects)
        except Exception as exc:
            photo = None
            rejects.append(f"error: {exc}")

        if photo:
            by_category_attached[cat] = by_category_attached.get(cat, 0) + 1
            record = {
                "place_id": place["id"],
                "name": place["name"],
                "category": cat,
                "url": photo["url"],
                "credit": photo.get("credit") or "unknown",
                "license": photo.get("license"),
                "source_url": photo.get("source_url"),
                "method": photo["method"],
                "evidence": photo["evidence"],
                "width": photo.get("width"),
            }
            attached.append(record)
            quality = "ok" if (photo.get("width") or 0) >= OK_THUMB_WIDTH else "thin"
            print(f"[photos] {i}/{len(todo)} {place['name']!r} <- {photo['method']} "
                  f"{photo.get('width')}px {photo.get('license')} ({quality})", flush=True)
            if not args.dry_run:
                r = supa.insert("place_photos", [{
                    "place_id": place["id"],
                    "url": photo["url"],
                    "credit": record["credit"],
                    "license": photo.get("license") or "unknown",
                    "source_url": photo.get("source_url") or photo["url"],
                    "display_order": 0,
                }])
                if r.status_code not in (200, 201):
                    print(f"[photos]   ! place_photos insert failed: {r.status_code} {r.text[:200]}", file=sys.stderr)
                pr = supa.patch("places", place["id"], {
                    "image_url": photo["url"], "image_quality": quality,
                })
                if pr.status_code not in (200, 204):
                    print(f"[photos]   ! places patch failed: {pr.status_code} {pr.text[:200]}", file=sys.stderr)
        else:
            missed.append({
                "place_id": place["id"], "name": place["name"], "category": cat,
                "reasons": rejects or ["no candidate found (no OSM/Wikipedia/Wikidata match)"],
            })
            print(f"[photos] {i}/{len(todo)} {place['name']!r} -> no photo "
                  f"({rejects[-1] if rejects else 'no candidate'})", flush=True)

        if i % 25 == 0 or i == len(todo):
            print(f"[photos] progress {i}/{len(todo)} | attached={len(attached)} missed={len(missed)}", flush=True)

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dry_run": args.dry_run,
        "total_candidates": len(todo),
        "attached_count": len(attached),
        "missed_count": len(missed),
        "by_category_attached": by_category_attached,
        "by_category_total": by_category_total,
        "attached": attached,
        "missed": missed,
    }
    out_path = OUT_DIR / ("places_dry_run.json" if args.dry_run else "places_report.json")
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"[photos] wrote report to {out_path}")
    print(f"[photos] done. attached={len(attached)} missed={len(missed)}")


if __name__ == "__main__":
    main()
