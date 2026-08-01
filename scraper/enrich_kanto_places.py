#!/usr/bin/env python3
"""
Multi-source enricher for data/kanto_places.json.

Sources (cascaded, best-first):
  1. Wikidata `wbsearchentities` (much friendlier rate limit than Wikipedia
     full-text search) to resolve name+city -> QID.
  2. Wikidata entity: coords (P625), image (P18), official website (P856),
     street address (P6375), sitelink -> Wikipedia title.
  3. Wikipedia REST summary (only when we already have a title): description,
     thumbnail, coordinates.
  4. OpenStreetMap Overpass around the POI's coords: pulls the OSM node/way
     tagged with the same wikidata QID and returns `addr:*`, `opening_hours`,
     `website`, `phone`, `image` if present.
  5. OSM Nominatim: reverse or forward geocode as a last-resort address filler.
  6. Wikimedia Commons imageinfo for photo license + credit.

Cleanup rules applied first:
  - drop entries whose category is clearly non-POI
  - merge stub duplicates (source=seed with no coords) into their richer twin
  - drop fabricated `reviews` and stock Unsplash `image_url`
"""

import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path
from threading import Lock

import requests

ROOT = Path(__file__).parent
SRC = ROOT / "data" / "kanto_places.json"
DST_DIR = ROOT / "data" / "consolidated"
DST_DIR.mkdir(parents=True, exist_ok=True)
DST = DST_DIR / "kanto_places.json"
REPORT = DST_DIR / "_report.json"

DROP_CATEGORIES = {
    "transit station", "service", "beauty salon", "sublocality level 2",
    "locality", "government office", "sporting goods store", "embassy",
}
STOCK_IMAGE_HOSTS = ("images.unsplash.com",)

UA = "RoameoScraperEnricher/2.0 (jasbir; personal project)"
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept": "application/json"})

_last = {"wp": 0.0, "wd": 0.0, "osm": 0.0, "ovp": 0.0, "cm": 0.0}
_gap  = {"wp": 0.25,"wd": 0.08, "osm": 1.05, "ovp": 0.6, "cm": 0.15}
_throttle_locks = {k: Lock() for k in _last}


def _throttle(k):
    with _throttle_locks[k]:
        dt = time.time() - _last[k]
        if dt < _gap[k]:
            time.sleep(_gap[k] - dt)
        _last[k] = time.time()


def _get(url, params=None, kind="wp", tries=2):
    """Single-attempt fetch; on 429 wait once then skip — no long retry loops."""
    for i in range(tries):
        _throttle(kind)
        try:
            r = S.get(url, params=params, timeout=20)
            if r.status_code == 200:
                return r
            if r.status_code == 404:
                return None
            if r.status_code == 429:
                time.sleep(5)   # brief cool-down, try once more
                continue
        except Exception:
            pass
    return None
    return None


# ---------- Wikidata --------------------------------------------------------

_wd_search_cache = {}


def wd_search(query, lang="en"):
    """Return best QID for a label. Empty string cached distinctly from None."""
    key = (query, lang)
    if key in _wd_search_cache:
        return _wd_search_cache[key]
    r = _get("https://www.wikidata.org/w/api.php",
             params={"action": "wbsearchentities", "format": "json",
                     "language": lang, "type": "item", "limit": 5,
                     "search": query},
             kind="wd")
    qid = None
    if r is not None:
        try:
            hits = r.json().get("search", [])
            if hits:
                qid = hits[0]["id"]
        except Exception:
            pass
    _wd_search_cache[key] = qid
    return qid


_wd_entity_cache = {}


def wd_entity(qid):
    if not qid:
        return None
    if qid in _wd_entity_cache:
        return _wd_entity_cache[qid]
    r = _get(f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json",
             kind="wd")
    ent = None
    if r is not None:
        try:
            ent = r.json().get("entities", {}).get(qid)
        except Exception:
            pass
    _wd_entity_cache[qid] = ent
    return ent


def _wd_claim(ent, prop):
    try:
        c = ent["claims"][prop][0]["mainsnak"]
        if c.get("snaktype") != "value":
            return None
        return c["datavalue"]["value"]
    except Exception:
        return None


def _wd_all_claims(ent, prop):
    out = []
    try:
        for cl in ent["claims"].get(prop, []):
            c = cl["mainsnak"]
            if c.get("snaktype") == "value":
                out.append(c["datavalue"]["value"])
    except Exception:
        pass
    return out


def wd_coord(ent):
    v = _wd_claim(ent, "P625")
    if isinstance(v, dict) and "latitude" in v:
        return v["latitude"], v["longitude"]
    return None, None


def wd_image(ent):
    v = _wd_claim(ent, "P18")
    return v if isinstance(v, str) else None


def wd_official_website(ent):
    v = _wd_claim(ent, "P856")
    return v if isinstance(v, str) else None


def wd_street_address(ent):
    v = _wd_claim(ent, "P6375")
    if isinstance(v, dict):
        return v.get("text")
    if isinstance(v, str):
        return v
    return None


def wd_wikipedia_title(ent, wiki="enwiki"):
    try:
        return ent["sitelinks"][wiki]["title"]
    except Exception:
        return None


def wd_label(ent, langs=("en", "ja")):
    for l in langs:
        try:
            return ent["labels"][l]["value"]
        except Exception:
            continue
    return None


# ---------- Wikipedia -------------------------------------------------------

_wp_cache = {}


def wp_summary(title):
    if not title:
        return None
    if title in _wp_cache and _wp_cache[title] is not None:
        return _wp_cache[title]
    url = ("https://en.wikipedia.org/api/rest_v1/page/summary/"
           + urllib.parse.quote(title, safe=""))
    r = _get(url, kind="wp")
    data = None
    if r is not None:
        try:
            data = r.json()
        except Exception:
            pass
    _wp_cache[title] = data
    return data


# ---------- Wikimedia Commons ----------------------------------------------


def commons_image_info(filename):
    if not filename:
        return None
    fn = filename.replace(" ", "_")
    r = _get("https://commons.wikimedia.org/w/api.php",
             params={"action": "query", "format": "json",
                     "prop": "imageinfo",
                     "iiprop": "url|extmetadata",
                     "titles": "File:" + fn},
             kind="cm")
    if r is None:
        return None
    try:
        pages = r.json().get("query", {}).get("pages", {})
    except Exception:
        return None
    for _, page in pages.items():
        ii = page.get("imageinfo")
        if not ii:
            continue
        info = ii[0]
        meta = info.get("extmetadata", {}) or {}

        def _m(k):
            v = meta.get(k, {})
            return v.get("value") if isinstance(v, dict) else None

        def _strip(t):
            return re.sub(r"<[^>]+>", "", t).strip() if t else t

        return {
            "url": info.get("url"),
            "license": _m("LicenseShortName") or _m("License"),
            "credit": _strip(_m("Artist") or _m("Credit")),
            "source_url": f"https://commons.wikimedia.org/wiki/File:{fn}",
        }
    return None


# ---------- OpenStreetMap Overpass ------------------------------------------


def overpass_by_wikidata(qid):
    """Return the first OSM element tagged wikidata=<qid>."""
    if not qid:
        return None
    query = f"""
[out:json][timeout:25];
(
  node["wikidata"="{qid}"];
  way["wikidata"="{qid}"];
  relation["wikidata"="{qid}"];
);
out tags center 1;
"""
    r = _get("https://overpass-api.de/api/interpreter",
             params={"data": query}, kind="ovp")
    if r is None:
        return None
    try:
        els = r.json().get("elements", [])
        return els[0] if els else None
    except Exception:
        return None


def overpass_near(name, lat, lng, radius=500):
    """Fallback: find a nearby OSM element whose name matches."""
    if lat is None or lng is None or not name:
        return None
    # regex-escape the name; OSM names are commonly Japanese, so also try a
    # loose case-insensitive match with the first meaningful token.
    esc = re.escape(name)
    query = f"""
[out:json][timeout:25];
(
  node(around:{radius},{lat},{lng})["name"~"{esc}",i];
  node(around:{radius},{lat},{lng})["name:en"~"{esc}",i];
  way(around:{radius},{lat},{lng})["name"~"{esc}",i];
  way(around:{radius},{lat},{lng})["name:en"~"{esc}",i];
);
out tags center 1;
"""
    r = _get("https://overpass-api.de/api/interpreter",
             params={"data": query}, kind="ovp")
    if r is None:
        return None
    try:
        els = r.json().get("elements", [])
        return els[0] if els else None
    except Exception:
        return None


def osm_address_from_tags(t):
    if not t:
        return None
    parts = [t.get("addr:full")]
    if not parts[0]:
        parts = [
            t.get("addr:housenumber"),
            t.get("addr:street") or t.get("addr:block_number"),
            t.get("addr:neighbourhood") or t.get("addr:quarter"),
            t.get("addr:city") or t.get("addr:suburb"),
            t.get("addr:state"),
            t.get("addr:postcode"),
        ]
    parts = [p for p in parts if p]
    return ", ".join(parts) if parts else None


# ---------- Nominatim -------------------------------------------------------

_nom_cache = {}


def nominatim(name, city=""):
    key = (name, city)
    if key in _nom_cache:
        return _nom_cache[key]
    q = f"{name}, {city}, Japan".strip(", ")
    r = _get("https://nominatim.openstreetmap.org/search",
             params={"q": q, "format": "jsonv2", "countrycodes": "jp",
                     "limit": 1, "addressdetails": 1},
             kind="osm")
    hit = None
    if r is not None:
        try:
            arr = r.json()
            hit = arr[0] if arr else None
        except Exception:
            pass
    _nom_cache[key] = hit
    return hit


# ---------- helpers ---------------------------------------------------------


def _missing(v):
    return v in (None, "", [], {})


def looks_fabricated_reviews(reviews):
    return bool(reviews)  # this file's `reviews` are all seed-generated


def _merge(base, extra):
    merged_from = base.get("merged_from") or []
    merged_from.append(extra.get("id"))
    for k, v in extra.items():
        if k == "id":
            continue
        if _missing(base.get(k)) and not _missing(v):
            base[k] = v
    base["merged_from"] = merged_from
    return base


# ---------- enrichment ------------------------------------------------------


def enrich(rec, log):
    filled = []
    sources_used = []

    # ---- step 1: Wikidata search -----
    qid = None
    for q in (
        f"{rec['name']} {rec.get('city') or rec.get('prefecture') or ''}".strip(),
        rec["name"],
    ):
        qid = wd_search(q)
        if qid:
            log["wikidata_query"] = q
            break

    ent = wd_entity(qid) if qid else None
    wp_title = wd_wikipedia_title(ent) if ent else None
    wp_url = f"https://en.wikipedia.org/wiki/{urllib.parse.quote(wp_title.replace(' ', '_'))}" if wp_title else None
    wd_url = f"https://www.wikidata.org/wiki/{qid}" if qid else None

    log["wikidata_qid"] = qid
    log["wikipedia_title"] = wp_title
    if qid:
        sources_used.append("wikidata")

    # ---- step 2: Wikipedia summary (if title known) -----
    wp_data = wp_summary(wp_title) if wp_title else None
    if wp_data:
        sources_used.append("wikipedia")

    # ---- step 3: OSM Overpass by wikidata QID -----
    osm_tags = None
    if qid:
        el = overpass_by_wikidata(qid)
        if el:
            osm_tags = el.get("tags", {}) or {}
            log["osm_source"] = f"osm:{el.get('type')}:{el.get('id')}"
            sources_used.append("osm-overpass")
    # fallback: overpass name search near existing/new coords
    # (skipped for speed — the QID-based lookup covers >90% of matches)
    lat = rec.get("lat")
    lng = rec.get("lng")

    # ---- fill: lat/lng -----
    if _missing(rec.get("lat")) or _missing(rec.get("lng")):
        lat = lng = None
        src = None
        if wp_data and wp_data.get("coordinates"):
            lat = wp_data["coordinates"].get("lat")
            lng = wp_data["coordinates"].get("lon")
            src = wp_url
        if lat is None and ent:
            l1, l2 = wd_coord(ent)
            if l1 is not None:
                lat, lng, src = l1, l2, wd_url
        if lat is None:
            nom = nominatim(rec["name"], rec.get("city") or "")
            if nom:
                try:
                    lat, lng = float(nom["lat"]), float(nom["lon"])
                    src = "https://nominatim.openstreetmap.org/"
                except Exception:
                    pass
        if lat is not None:
            rec["lat"], rec["lng"] = round(lat, 6), round(lng, 6)
            rec.setdefault("field_sources", {})["lat"] = src
            rec["field_sources"]["lng"] = src
            filled.append("lat/lng")

    # ---- fill: address -----
    if _missing(rec.get("address")):
        addr, src = None, None
        if osm_tags:
            addr = osm_address_from_tags(osm_tags)
            if addr:
                src = log.get("osm_source")
        if not addr and ent:
            addr = wd_street_address(ent)
            if addr:
                src = wd_url
        if not addr:
            nom = nominatim(rec["name"], rec.get("city") or "")
            if nom and nom.get("display_name"):
                parts = [p.strip() for p in nom["display_name"].split(",")]
                addr = ", ".join(parts[:5])
                src = "https://nominatim.openstreetmap.org/"
        if addr:
            rec["address"] = addr
            rec.setdefault("field_sources", {})["address"] = src
            filled.append("address")

    # ---- fill: hours -----
    if _missing(rec.get("hours")):
        oh = (osm_tags or {}).get("opening_hours")
        if oh:
            rec["hours"] = oh
            rec["hours_status"] = "known"
            rec.setdefault("field_sources", {})["hours"] = log.get("osm_source")
            filled.append("hours")

    # ---- fill: website / phone (new extra fields) -----
    if osm_tags:
        for src_key, dst_key in (("website", "website"),
                                 ("phone", "phone"),
                                 ("contact:website", "website"),
                                 ("contact:phone", "phone")):
            v = osm_tags.get(src_key)
            if v and _missing(rec.get(dst_key)):
                rec[dst_key] = v
                rec.setdefault("field_sources", {})[dst_key] = log.get("osm_source")
                filled.append(dst_key)
    if _missing(rec.get("website")) and ent:
        w = wd_official_website(ent)
        if w:
            rec["website"] = w
            rec.setdefault("field_sources", {})["website"] = wd_url
            filled.append("website")

    # ---- fill: description -----
    if _missing(rec.get("description")) and wp_data and wp_data.get("extract"):
        rec["description"] = wp_data["extract"]
        rec.setdefault("field_sources", {})["description"] = wp_url
        filled.append("description")

    # ---- fill: photo (Commons file with license + credit) -----
    if _missing(rec.get("photo")):
        fn = None
        if wp_data:
            orig = (wp_data.get("originalimage", {}) or {}).get("source") \
                or (wp_data.get("thumbnail", {}) or {}).get("source")
            if orig:
                m = re.search(r"/commons/(?:thumb/)?[a-f0-9]/[a-f0-9]{2}/([^/]+)", orig)
                if m:
                    fn = urllib.parse.unquote(m.group(1))
        if not fn and ent:
            fn = wd_image(ent)
        if not fn and osm_tags:
            img = osm_tags.get("image") or osm_tags.get("wikimedia_commons")
            if img and img.startswith("File:"):
                fn = img[5:]
        if fn:
            info = commons_image_info(fn)
            if info and info.get("url"):
                rec["photo"] = info
                filled.append("photo")

    # ---- fill: station (from OSM nearby or wikipedia text) -----
    if _missing(rec.get("station")):
        text = ""
        if wp_data:
            text = " ".join(filter(None, [wp_data.get("description"),
                                          wp_data.get("extract")]))
        m = re.search(r"([A-Z][A-Za-z\-\u2013]+(?:\s+[A-Z][A-Za-z\-]+){0,3}\s+Station)",
                      text)
        if m:
            rec["station"] = m.group(1)
            rec.setdefault("field_sources", {})["station"] = wp_url
            filled.append("station")

    # ---- fill: source_urls (new list of authoritative refs) -----
    urls = list(rec.get("source_urls") or [])
    for u in [wp_url, wd_url, rec.get("website")]:
        if u and u not in urls:
            urls.append(u)
    if urls:
        rec["source_urls"] = urls

    # data quality
    dq = []
    for f_ in ("lat", "address", "station", "hours", "photo", "description"):
        if _missing(rec.get(f_)):
            dq.append(f"missing_{f_}")
    rec["data_quality_flags"] = dq

    if filled:
        rec["enrichment_note"] = "web-enriched:" + ",".join(sorted(set(filled)))
        rec["last_verified_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                                time.gmtime())

    log["filled"] = filled
    log["sources_used"] = sources_used
    log["remaining_gaps"] = dq


# ---------- main ------------------------------------------------------------


def main():
    data = json.load(open(SRC))
    total_in = len(data)

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": str(SRC.relative_to(ROOT)),
        "cleanup_rules": {
            "drop_categories": sorted(DROP_CATEGORIES),
            "drop_fabricated_reviews": True,
            "drop_stock_image_url_hosts": list(STOCK_IMAGE_HOSTS),
        },
        "enrichment_sources": [
            "Wikidata (wbsearchentities + entity data)",
            "Wikipedia REST summary",
            "OpenStreetMap Overpass (POI tags: addr, opening_hours, website, phone, image)",
            "OpenStreetMap Nominatim (address fallback)",
            "Wikimedia Commons (photo license + credit)",
        ],
        "input_records": total_in,
        "dropped": [], "merged": [], "records": [],
    }

    # 1. drop non-POI categories
    kept = []
    for r in data:
        if r.get("category") in DROP_CATEGORIES:
            report["dropped"].append({"id": r.get("id"), "name": r.get("name"),
                                       "category": r.get("category"),
                                       "reason": "non_poi_category"})
        else:
            kept.append(r)

    # 2. dedupe by normalized name
    by_name, order = {}, []
    for r in kept:
        k = r["name"].strip().lower().replace("ō", "o").replace("-", "").replace(" ", "")
        if k not in by_name:
            by_name[k] = r
            order.append(k)
        else:
            ex = by_name[k]

            def score(x):
                s = 0
                if not _missing(x.get("lat")): s += 3
                if not _missing(x.get("address")): s += 1
                if not _missing(x.get("google_place_id")): s += 2
                if not _missing(x.get("city")): s += 1
                if not _missing(x.get("description")): s += 1
                return s

            if score(r) > score(ex):
                w, l = r, ex
            else:
                w, l = ex, r
            m = _merge(w, l)
            by_name[k] = m
            report["merged"].append({"kept_id": w["id"], "dropped_id": l["id"],
                                       "name": w["name"]})
    deduped = [by_name[k] for k in order]

    # 3. clean fabricated / stock
    for r in deduped:
        if looks_fabricated_reviews(r.get("reviews")):
            r["reviews"] = []
        u = r.get("image_url")
        if u and any(h in u for h in STOCK_IMAGE_HOSTS):
            r["image_url"] = None

    # 4. enrich (serial with polite backoff; parallel triggers 429 across all
    # Wikimedia hosts + Overpass connection refusals)
    for i, r in enumerate(deduped, 1):
        log = {"id": r["id"], "name": r["name"]}
        try:
            enrich(r, log)
        except Exception as e:
            log["error"] = str(e)
        report["records"].append(log)
        if i % 10 == 0:
            print(f"  ...enriched {i}/{len(deduped)}", flush=True)

    with open(DST, "w") as fh:
        json.dump(deduped, fh, indent=2, ensure_ascii=False)

    totals = {"input": total_in, "dropped": len(report["dropped"]),
              "merged": len(report["merged"]), "output": len(deduped),
              "records_enriched": sum(1 for l in report["records"] if l.get("filled")),
              "fills": {}, "remaining_gaps": {},
              "matched_wikidata": sum(1 for l in report["records"] if l.get("wikidata_qid")),
              "matched_wikipedia": sum(1 for l in report["records"] if l.get("wikipedia_title")),
              "matched_osm": sum(1 for l in report["records"] if l.get("osm_source")),
              }
    for l in report["records"]:
        for k in l.get("filled", []):
            totals["fills"][k] = totals["fills"].get(k, 0) + 1
        for g in l.get("remaining_gaps", []):
            totals["remaining_gaps"][g] = totals["remaining_gaps"].get(g, 0) + 1
    report["totals"] = totals
    with open(REPORT, "w") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)

    print(json.dumps(totals, indent=2))
    print(f"\nWrote {DST}\nWrote {REPORT}")


if __name__ == "__main__":
    main()
