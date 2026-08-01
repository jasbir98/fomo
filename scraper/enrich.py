#!/usr/bin/env python3
"""
Consolidate + enrich scraper output for the Scotland pilot batch
(scot-pilot-2026-07-25). Pure HTTP calls to free public sources — no LLM,
no Anthropic API, no cost.

Reads:  out/scot-pilot-2026-07-25/*.json
Writes: consolidated/scot-pilot-2026-07-25/<city>.json  (same schema,
        missing fields backfilled from Wikidata / Wikipedia / OSM Overpass
        / OSM Nominatim / Wikimedia Commons)
Also writes:
  consolidated/scot-pilot-2026-07-25/_report.json
      per-record diff of what was auto-filled vs. still missing.
  consolidated/scot-pilot-2026-07-25/_manual_research_todo.json
      worklist of every record still missing lat/lng, image_url, station,
      or hours after the automated pass, with enough context (name, city,
      category, address, description, existing source_urls) to hand off
      to a web-search-capable agent for manual lookup. That agent should
      prefer VisitScotland, National Trust for Scotland, Historic
      Environment Scotland, ScotRail/Traveline Scotland (for stations),
      and the place's own official site — not Reddit/TripAdvisor/socials
      as factual sources — then edit the matching record in the
      consolidated JSON directly (fill the field + field_sources entry +
      last_verified_at, drop the corresponding missing_* flag).
"""
import json
import glob
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path

import requests

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from countries.scotland import ADMIN_UNIT_REGION as SCOTLAND_ADMIN_UNITS  # noqa: E402

SRC_GLOBS = [ROOT / "out/scot-pilot-2026-07-25/*.json"]
DST = ROOT / "consolidated/scot-pilot-2026-07-25"
DST.mkdir(exist_ok=True)

NOMINATIM_COUNTRY_CODE = "gb"
# Rough bounding box covering all of Scotland (incl. Shetland), used as a
# geocode sanity check — was previously silently skipped for every
# Scottish prefecture because the old BBOX table only had Tokyo/Saitama.
SCOTLAND_BBOX = (54.5, 61.0, -9.0, -0.6)

UA = "RoameoScraperEnricher/1.0 (jasbir; contact via github)"
HEADERS = {"User-Agent": UA, "Accept": "application/json"}
S = requests.Session()
S.headers.update(HEADERS)

# ---- small politeness throttles -------------------------------------------------
_last = {"wp": 0.0, "wd": 0.0, "osm": 0.0, "ovp": 0.0, "cm": 0.0}
_gap = {"wp": 0.1, "wd": 0.15, "osm": 1.05, "ovp": 0.6, "cm": 0.15}  # OSM Nominatim requires <=1 req/s


def _throttle(kind):
    dt = time.time() - _last[kind]
    if dt < _gap[kind]:
        time.sleep(_gap[kind] - dt)
    _last[kind] = time.time()


# ---- caches (survive across records within one run) -----------------------------
_wp_cache = {}
_wd_cache = {}
_nom_cache = {}


def wp_title_from_url(url: str):
    if not url or "wikipedia.org" not in url:
        return None
    try:
        p = urllib.parse.urlparse(url)
        if "/wiki/" not in p.path:
            return None
        title = p.path.split("/wiki/", 1)[1]
        title = urllib.parse.unquote(title)
        return title
    except Exception:
        return None


def wp_summary(title: str):
    if not title:
        return None
    if title in _wp_cache:
        return _wp_cache[title]
    _throttle("wp")
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(title, safe='')}"
    try:
        r = S.get(url, timeout=15)
        if r.status_code != 200:
            _wp_cache[title] = None
            return None
        data = r.json()
    except Exception:
        _wp_cache[title] = None
        return None
    _wp_cache[title] = data
    return data


def wd_entity(qid: str):
    if not qid:
        return None
    if qid in _wd_cache:
        return _wd_cache[qid]
    _throttle("wd")
    url = f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
    try:
        r = S.get(url, timeout=15)
        if r.status_code != 200:
            _wd_cache[qid] = None
            return None
        data = r.json().get("entities", {}).get(qid)
    except Exception:
        _wd_cache[qid] = None
        return None
    _wd_cache[qid] = data
    return data


def wd_claim_value(entity, prop):
    try:
        c = entity["claims"][prop][0]["mainsnak"]
        if c.get("snaktype") != "value":
            return None
        return c["datavalue"]["value"]
    except Exception:
        return None


def wd_coord(entity):
    v = wd_claim_value(entity, "P625")
    if isinstance(v, dict) and "latitude" in v:
        return v["latitude"], v["longitude"]
    return None, None


def wd_image_filename(entity):
    v = wd_claim_value(entity, "P18")
    if isinstance(v, str):
        return v
    return None


_wd_search_cache = {}


def wd_search(query: str, lang="en"):
    """Resolve a free-text label to a Wikidata QID via wbsearchentities.

    Used when a record has no Wikipedia source_url to pull a wikibase_item
    from directly (common for smaller Scottish places).
    """
    key = (query, lang)
    if key in _wd_search_cache:
        return _wd_search_cache[key]
    _throttle("wd")
    try:
        r = S.get(
            "https://www.wikidata.org/w/api.php",
            params={"action": "wbsearchentities", "format": "json", "language": lang,
                    "type": "item", "limit": 5, "search": query},
            timeout=15,
        )
        qid = None
        if r.status_code == 200:
            hits = r.json().get("search", [])
            if hits:
                qid = hits[0]["id"]
    except Exception:
        qid = None
    _wd_search_cache[key] = qid
    return qid


def wd_located_at_street(entity):
    v = wd_claim_value(entity, "P6375")  # street address (multilingual)
    if isinstance(v, dict):
        return v.get("text")
    if isinstance(v, str):
        return v
    return None


def commons_image_info(filename: str):
    """Return (url, license short name, credit/author, source_url) for a Commons file."""
    if not filename:
        return None
    _throttle("wp")
    fn = filename.replace(" ", "_")
    url = (
        "https://commons.wikimedia.org/w/api.php?action=query&format=json"
        "&prop=imageinfo&iiprop=url|extmetadata&titles=" + urllib.parse.quote("File:" + fn, safe="")
    )
    try:
        r = S.get(url, timeout=15)
        if r.status_code != 200:
            return None
        pages = r.json().get("query", {}).get("pages", {})
        for _, page in pages.items():
            ii = page.get("imageinfo")
            if not ii:
                continue
            info = ii[0]
            meta = info.get("extmetadata", {}) or {}

            def _m(k):
                v = meta.get(k, {})
                if isinstance(v, dict):
                    return v.get("value")
                return None

            def _strip_html(t):
                if not t:
                    return t
                return re.sub(r"<[^>]+>", "", t).strip()

            return {
                "url": info.get("url"),
                "license": _m("LicenseShortName") or _m("License"),
                "credit": _strip_html(_m("Artist") or _m("Credit")),
                "source_url": f"https://commons.wikimedia.org/wiki/File:{fn}",
            }
    except Exception:
        return None
    return None


_overpass_cache = {}


def overpass_by_wikidata(qid: str):
    """First OSM element (node/way/relation) tagged wikidata=<qid>. Gives us
    opening_hours, addr:*, website, phone, image — real POI tags that
    Wikidata/Wikipedia summaries usually don't carry."""
    if not qid:
        return None
    if qid in _overpass_cache:
        return _overpass_cache[qid]
    _throttle("ovp")
    query = f"""
[out:json][timeout:25];
(
  node["wikidata"="{qid}"];
  way["wikidata"="{qid}"];
  relation["wikidata"="{qid}"];
);
out tags center 1;
"""
    try:
        r = S.get("https://overpass-api.de/api/interpreter", params={"data": query}, timeout=30)
        el = None
        if r.status_code == 200:
            els = r.json().get("elements", [])
            el = els[0] if els else None
    except Exception:
        el = None
    _overpass_cache[qid] = el
    return el


def osm_address_from_tags(t):
    if not t:
        return None
    full = t.get("addr:full")
    if full:
        return full
    parts = [t.get("addr:housenumber"), t.get("addr:street"),
             t.get("addr:city") or t.get("addr:suburb"), t.get("addr:postcode")]
    parts = [p for p in parts if p]
    return ", ".join(parts) if parts else None


def nominatim_search(name: str, city: str, country_code=NOMINATIM_COUNTRY_CODE):
    key = (name, city)
    if key in _nom_cache:
        return _nom_cache[key]
    _throttle("osm")
    params = {
        "q": f"{name}, {city}",
        "format": "jsonv2",
        "countrycodes": country_code,
        "limit": 1,
        "addressdetails": 1,
    }
    try:
        r = S.get("https://nominatim.openstreetmap.org/search", params=params, timeout=20)
        if r.status_code != 200:
            _nom_cache[key] = None
            return None
        res = r.json()
        _nom_cache[key] = res[0] if res else None
        return _nom_cache[key]
    except Exception:
        _nom_cache[key] = None
        return None


# ---- validation ---------------------------------------------------------------

def in_bbox(prefecture, lat, lng):
    if lat is None or lng is None:
        return True
    box = SCOTLAND_BBOX if prefecture in SCOTLAND_ADMIN_UNITS else None
    if not box:
        return True
    lat_lo, lat_hi, lng_lo, lng_hi = box
    return lat_lo <= lat <= lat_hi and lng_lo <= lng <= lng_hi


# ---- enrichment core ----------------------------------------------------------


def _missing(v):
    return v in (None, "", [], {})


def enrich_record(rec, log):
    filled = []
    warnings = []

    # locate a Wikipedia source URL if present
    wp_url = None
    for u in rec.get("source_urls") or []:
        if "wikipedia.org/wiki/" in u:
            wp_url = u
            break

    wp_data = None
    wd_data = None
    qid = None

    if wp_url:
        title = wp_title_from_url(wp_url)
        wp_data = wp_summary(title) if title else None
        if wp_data:
            qid = wp_data.get("wikibase_item")

    # no Wikipedia source cited (common for smaller places) — try resolving
    # a Wikidata QID directly from the name, so Overpass/Wikidata fills
    # still have a shot.
    if not qid:
        qid = wd_search(f"{rec['name']} {rec.get('city') or ''}".strip())
    if qid:
        wd_data = wd_entity(qid)

    osm_tags = None
    if qid:
        el = overpass_by_wikidata(qid)
        if el:
            osm_tags = el.get("tags", {}) or {}
            log["osm_source"] = f"osm:{el.get('type')}:{el.get('id')}"

    # coords
    if _missing(rec.get("lat")) or _missing(rec.get("lng")):
        lat = lng = None
        src = None
        if wp_data and wp_data.get("coordinates"):
            lat = wp_data["coordinates"].get("lat")
            lng = wp_data["coordinates"].get("lon")
            src = wp_url
        if (lat is None or lng is None) and wd_data:
            wl, wg = wd_coord(wd_data)
            if wl is not None:
                lat, lng = wl, wg
                src = f"https://www.wikidata.org/wiki/{wd_data['id']}"
        if lat is None:
            nom = nominatim_search(rec["name"], rec.get("city", ""))
            if nom:
                try:
                    lat = float(nom["lat"])
                    lng = float(nom["lon"])
                    src = "https://nominatim.openstreetmap.org/"
                except Exception:
                    pass
        if lat is not None and lng is not None:
            if in_bbox(rec.get("prefecture"), lat, lng):
                rec["lat"] = round(lat, 6)
                rec["lng"] = round(lng, 6)
                rec.setdefault("field_sources", {})["lat"] = src
                rec["field_sources"]["lng"] = src
                filled.append("lat/lng")
            else:
                warnings.append(f"coords out of bbox from {src}: {lat},{lng}")

    # address
    if _missing(rec.get("address")):
        addr = None
        src = None
        if osm_tags:
            addr = osm_address_from_tags(osm_tags)
            if addr:
                src = log.get("osm_source")
        if not addr and wd_data:
            addr = wd_located_at_street(wd_data)
            if addr:
                src = f"https://www.wikidata.org/wiki/{wd_data['id']}"
        if not addr:
            nom = nominatim_search(rec["name"], rec.get("city", ""))
            if nom and nom.get("display_name"):
                # keep first ~5 pieces to avoid pref/country
                parts = [p.strip() for p in nom["display_name"].split(",")]
                addr = ", ".join(parts[:5])
                src = "https://nominatim.openstreetmap.org/"
        if addr:
            rec["address"] = addr
            rec.setdefault("field_sources", {})["address"] = src
            filled.append("address")

    # photo (Wikimedia only — no non-free image scraping)
    if _missing(rec.get("photo")):
        img_filename = None
        if wp_data:
            orig = wp_data.get("originalimage", {}).get("source") or wp_data.get("thumbnail", {}).get("source")
            if orig:
                # derive filename from URL: .../commons/thumb/.../<file> or .../commons/<hash>/<file>
                m = re.search(r"/commons/(?:thumb/)?[a-f0-9]/[a-f0-9]{2}/([^/]+)", orig)
                if m:
                    img_filename = urllib.parse.unquote(m.group(1))
        if not img_filename and wd_data:
            img_filename = wd_image_filename(wd_data)
        if not img_filename and osm_tags:
            img_tag = osm_tags.get("image") or osm_tags.get("wikimedia_commons")
            if img_tag and img_tag.startswith("File:"):
                img_filename = img_tag[len("File:"):]
        if img_filename:
            info = commons_image_info(img_filename)
            if info and info.get("url"):
                rec["photo"] = info
                filled.append("photo")

    # image_url: plain string mirror of photo.url, for callers that don't
    # want the license/credit object.
    if _missing(rec.get("image_url")) and (rec.get("photo") or {}).get("url"):
        rec["image_url"] = rec["photo"]["url"]
        rec.setdefault("field_sources", {})["image_url"] = rec["photo"].get("source_url")
        filled.append("image_url")

    # station: OSM tags first, else fall back to a "Station" mention in the
    # Wikipedia summary text.
    if _missing(rec.get("station")):
        station = None
        src = None
        if osm_tags:
            station = osm_tags.get("railway:station") or osm_tags.get("nearest_station")
            if station:
                src = log.get("osm_source")
        if not station:
            text = ""
            if wp_data:
                text = " ".join(filter(None, [wp_data.get("description"), wp_data.get("extract")]))
            m = re.search(r"([A-Z][A-Za-z\-\u2013\u2014]+(?:\s+[A-Z][A-Za-z\-]+){0,3}\s+Station)", text)
            if m:
                station = m.group(1)
                src = wp_url
        if station:
            rec["station"] = station
            rec.setdefault("field_sources", {})["station"] = src
            filled.append("station")

    # hours: OSM opening_hours tag is the only free source reliable enough
    # to trust here (Wikipedia/Wikidata essentially never carry this).
    if _missing(rec.get("hours")) and osm_tags:
        oh = osm_tags.get("opening_hours")
        if oh:
            rec["hours"] = oh
            rec["hours_status"] = "known"
            rec.setdefault("field_sources", {})["hours"] = log.get("osm_source")
            filled.append("hours")

    # mark record status
    if filled:
        rec.setdefault("field_sources", {})
        note = rec.get("enrichment_note") or ""
        rec["enrichment_note"] = (note + " " if note else "") + "web-enriched:" + ",".join(filled)
        rec["last_verified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # data-quality flags
    dq = []
    if _missing(rec.get("lat")) or _missing(rec.get("lng")):
        dq.append("missing_coords")
    if _missing(rec.get("address")):
        dq.append("missing_address")
    if _missing(rec.get("station")):
        dq.append("missing_station")
    if _missing(rec.get("hours")):
        dq.append("missing_hours")
    if _missing(rec.get("photo")):
        dq.append("missing_photo")
    if _missing(rec.get("image_url")):
        dq.append("missing_image_url")
    if rec.get("lat") is not None and not in_bbox(rec.get("prefecture"), rec["lat"], rec["lng"]):
        dq.append("coords_out_of_bbox")
        warnings.append("existing coords out of bbox")
    rec["data_quality_flags"] = dq

    log["filled"] = filled
    log["warnings"] = warnings
    log["remaining_gaps"] = dq
    return rec


# ---- main --------------------------------------------------------------------


# Gap flags that matter for the user's ask (lat/lng, image_url, station,
# hours) — used to build the manual-research handoff list. missing_photo /
# missing_address / coords_out_of_bbox are tracked in the report but not
# surfaced there since they're either derivative of the flags below or
# outside this pass's scope.
MANUAL_TODO_FLAGS = {"missing_coords", "missing_image_url", "missing_station", "missing_hours"}


def main():
    files = []
    for g in SRC_GLOBS:
        files.extend(sorted(glob.glob(str(g))))

    report = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "files": {}, "totals": {}}
    grand = {"records": 0, "enriched": 0, "fills": {}, "still_missing": {}}
    seen_keys = {}  # dedupe_key -> (file, name)
    manual_todo = []  # flat worklist for the manual web-search pass

    for i, path in enumerate(files, 1):
        with open(path) as fh:
            data = json.load(fh)
        recs = data.get("records", [])
        file_log = {"count": len(recs), "records": []}
        dup_here = []
        for r in recs:
            k = r.get("dedupe_key")
            if k in seen_keys:
                dup_here.append({"dedupe_key": k, "also_in": seen_keys[k]})
            else:
                seen_keys[k] = os.path.basename(path)
            rec_log = {"name": r.get("name"), "dedupe_key": k}
            enrich_record(r, rec_log)
            file_log["records"].append(rec_log)
            grand["records"] += 1
            if rec_log["filled"]:
                grand["enriched"] += 1
                for f_ in rec_log["filled"]:
                    grand["fills"][f_] = grand["fills"].get(f_, 0) + 1
            for gap in rec_log["remaining_gaps"]:
                grand["still_missing"][gap] = grand["still_missing"].get(gap, 0) + 1

            todo_flags = sorted(set(rec_log["remaining_gaps"]) & MANUAL_TODO_FLAGS)
            if todo_flags:
                manual_todo.append({
                    "dedupe_key": k,
                    "name": r.get("name"),
                    "city": r.get("city"),
                    "prefecture": r.get("prefecture"),
                    "category": r.get("category"),
                    "address": r.get("address"),
                    "description": r.get("description"),
                    "existing_source_urls": r.get("source_urls") or [],
                    "missing": todo_flags,
                    "file": os.path.basename(path),
                })
        file_log["duplicates_with_earlier_files"] = dup_here

        # write consolidated file (same shape as input)
        out_name = os.path.basename(path)
        out_path = DST / out_name
        with open(out_path, "w") as fh:
            json.dump({"records": recs}, fh, indent=2, ensure_ascii=False)
        report["files"][out_name] = file_log
        print(f"[wrote] ({i}/{len(files)}) {out_name}: {len(recs)} recs, "
              f"{sum(1 for l in file_log['records'] if l['filled'])} enriched -> {out_path}", flush=True)

    report["totals"] = grand
    with open(DST / "_report.json", "w") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    with open(DST / "_manual_research_todo.json", "w") as fh:
        json.dump({
            "generated_at": report["generated_at"],
            "instructions": (
                "Records below still need one or more of lat/lng, image_url, station, "
                "or hours after the automated Wikidata/Wikipedia/OSM/Nominatim pass. "
                "Web-search each by name+city, preferring VisitScotland, National Trust "
                "for Scotland, Historic Environment Scotland, ScotRail/Traveline Scotland "
                "(for the nearest station), and the place's own official site over "
                "Reddit/TripAdvisor/social posts. Then edit the matching record (by "
                "dedupe_key) in consolidated/scot-pilot-2026-07-25/<file>.json directly: "
                "fill the field, add a field_sources entry citing the page you used, set "
                "last_verified_at to now, and drop the corresponding missing_* flag from "
                "data_quality_flags. Leave a field null rather than guessing if you can't "
                "confidently confirm it."
            ),
            "count": len(manual_todo),
            "items": manual_todo,
        }, fh, indent=2, ensure_ascii=False)

    print("\n=== TOTALS ===")
    print(json.dumps(grand, indent=2))
    print(f"\n{len(manual_todo)} record(s) still need manual research -> {DST / '_manual_research_todo.json'}")


if __name__ == "__main__":
    main()
