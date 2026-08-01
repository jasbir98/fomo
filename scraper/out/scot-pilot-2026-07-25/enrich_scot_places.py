from __future__ import annotations

import html
import json
import math
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse, unquote
from urllib.request import Request, urlopen

OUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
USER_AGENT = "Mozilla/5.0 CopilotCLI ScottishPlacesEnricher/1.0"
NOW = datetime.now(timezone.utc).isoformat(timespec="seconds")
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
NOMINATIM_API = "https://nominatim.openstreetmap.org/search"

OPEN_ALWAYS_CATEGORIES = {
    "archaeological site", "beach", "bridge", "canal", "castle ruins", "cemetery", "chambered cairn",
    "cliff walk", "coastal feature", "coastal walk", "ferry terminal", "forest park", "glen", "golf links",
    "harbour", "harbor", "heritage site", "hill", "hill fort", "hill walk", "industrial heritage",
    "island", "landmark", "loch", "loch shore", "market", "monument", "mountain", "nature reserve",
    "nature-reserve", "park", "prehistoric site", "reservoir", "river walk", "sea stack", "town centre",
    "trail", "urban nature reserve", "village", "viewpoint", "walking route", "walking trail", "waterfall",
    "waterfront", "wildlife site", "woodland walk",
}

LIKELY_PAID_CATEGORIES = {
    "abbey", "arts centre", "castle", "country house", "distillery", "gallery", "garden", "golf course",
    "heritage railway", "historic building", "historic church", "historic estate", "historic house", "lighthouse",
    "museum", "palace", "science museum", "sports venue", "textile heritage", "theatre", "visitor centre",
    "wildlife park",
}

STATION_CATEGORY_SEEDS = [
    "Category:Railway stations in Aberdeenshire",
    "Category:Railway stations in Angus, Scotland",
    "Category:Railway stations in Argyll and Bute",
    "Category:Railway stations in Clackmannanshire",
    "Category:Railway stations in Dumfries and Galloway",
    "Category:Railway stations in East Ayrshire",
    "Category:Railway stations in East Dunbartonshire",
    "Category:Railway stations in East Lothian",
    "Category:Railway stations in East Renfrewshire",
    "Category:Railway stations in Falkirk (council area)",
    "Category:Railway stations in Fife",
    "Category:Railway stations in Glasgow",
    "Category:Railway stations in Highland (council area)",
    "Category:Railway stations in Inverclyde",
    "Category:Railway stations in Midlothian",
    "Category:Railway stations in Moray",
    "Category:Railway stations in North Ayrshire",
    "Category:Railway stations in North Lanarkshire",
    "Category:Railway stations in Perth and Kinross",
    "Category:Railway stations in Renfrewshire",
    "Category:Railway stations in the Scottish Borders",
    "Category:Railway stations in South Ayrshire",
    "Category:Railway stations in South Lanarkshire",
    "Category:Railway stations in Stirling (council area)",
    "Category:Railway stations in West Dunbartonshire",
    "Category:Railway stations in West Lothian",
    "Category:SPT railway stations",
]

WIKI_META_CACHE_PATH = OUT_DIR / "_wiki_meta_cache.json"
WIKIDATA_CACHE_PATH = OUT_DIR / "_wikidata_cache.json"
OFFICIAL_CACHE_PATH = OUT_DIR / "_official_site_cache.json"
NOMINATIM_CACHE_PATH = OUT_DIR / "_nominatim_cache.json"
STATIONS_CACHE_PATH = OUT_DIR / "_scotland_station_cache.json"


def load_cache(path: Path) -> Dict[str, Any]:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            return {}
    return {}


def save_cache(path: Path, data: Dict[str, Any]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def chunks(seq: Sequence[str], size: int) -> Iterator[List[str]]:
    for i in range(0, len(seq), size):
        yield list(seq[i:i + size])


def http_get(url: str, *, accept: Optional[str] = None, retries: int = 3, timeout: int = 60) -> str:
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    req = Request(url, headers=headers)
    delay = 3
    for attempt in range(retries):
        try:
            with urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", "ignore")
        except HTTPError as exc:
            if exc.code in {429, 500, 502, 503, 504} and attempt < retries - 1:
                retry_after = exc.headers.get("Retry-After") if getattr(exc, "headers", None) else None
                wait = int(retry_after) if retry_after and retry_after.isdigit() else (15 if exc.code == 429 else delay)
                time.sleep(wait)
                delay *= 2
                continue
            raise
        except URLError:
            if attempt < retries - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise


def http_get_json(url: str, *, accept: Optional[str] = None, retries: int = 3, timeout: int = 60) -> Any:
    return json.loads(http_get(url, accept=accept, retries=retries, timeout=timeout))


def clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", html.unescape(text or "")).strip()
    return text


def normalize_title_from_wiki_url(url: str) -> Optional[str]:
    if "wikipedia.org/wiki/" not in url:
        return None
    part = urlparse(url).path.split("/wiki/")[-1]
    if not part:
        return None
    return unquote(part).replace("_", " ")


def normalize_wikimedia_image(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    url = url.split("?")[0]
    return url


def wiki_page_url(title: str) -> str:
    safe = ":_()!'%,.-"
    return "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_"), safe=safe)


def commons_file_url(filename: str) -> str:
    filename = filename.replace(" ", "_")
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(filename, safe=':_()!%,.-')}"


def extract_wikidata_claim_text(claims: Dict[str, Any], prop: str) -> Optional[str]:
    for statement in claims.get(prop, []):
        mainsnak = statement.get("mainsnak", {})
        dv = mainsnak.get("datavalue", {})
        value = dv.get("value")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def extract_wikidata_coord(claims: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    for statement in claims.get("P625", []):
        value = statement.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(value, dict) and "latitude" in value and "longitude" in value:
            return float(value["latitude"]), float(value["longitude"])
    return None, None


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def fetch_wikipedia_metadata(titles: Sequence[str], cache: Dict[str, Any]) -> None:
    todo = [t for t in titles if t and t not in cache]
    for batch in chunks(todo, 20):
        params = {
            "action": "query",
            "format": "json",
            "redirects": 1,
            "prop": "coordinates|pageimages|pageprops|categories",
            "piprop": "original",
            "cllimit": "max",
            "titles": "|".join(batch),
        }
        data = http_get_json(WIKIPEDIA_API + "?" + urlencode(params), timeout=60)
        redirected: Dict[str, str] = {}
        for row in data.get("query", {}).get("redirects", []):
            redirected[row.get("from")] = row.get("to")
        normalized: Dict[str, str] = {}
        for row in data.get("query", {}).get("normalized", []):
            normalized[row.get("from")] = row.get("to")
        pages = data.get("query", {}).get("pages", {})
        title_map: Dict[str, Dict[str, Any]] = {}
        for page in pages.values():
            title = page.get("title")
            if not title or "missing" in page:
                continue
            coord = (page.get("coordinates") or [{}])[0]
            title_map[title] = {
                "title": title,
                "lat": coord.get("lat"),
                "lng": coord.get("lon"),
                "image_url": normalize_wikimedia_image(page.get("original", {}).get("source")),
                "qid": page.get("pageprops", {}).get("wikibase_item"),
                "categories": [c.get("title", "") for c in page.get("categories", [])],
                "source": wiki_page_url(title),
            }
        for original in batch:
            key = redirected.get(normalized.get(original, original), redirected.get(original, normalized.get(original, original)))
            actual = title_map.get(key or normalized.get(original, original) or original) or title_map.get(original)
            cache[original] = actual or {"title": original, "lat": None, "lng": None, "image_url": None, "qid": None, "categories": [], "source": wiki_page_url(original)}
        time.sleep(1.0)


def fetch_wikidata_entities(qids: Sequence[str], cache: Dict[str, Any]) -> None:
    todo = [q for q in qids if q and q not in cache]
    for batch in chunks(todo, 20):
        params = {
            "action": "wbgetentities",
            "format": "json",
            "ids": "|".join(batch),
            "props": "claims",
        }
        data = http_get_json(WIKIDATA_API + "?" + urlencode(params), timeout=60)
        entities = data.get("entities", {})
        for qid in batch:
            ent = entities.get(qid, {})
            claims = ent.get("claims", {})
            lat, lng = extract_wikidata_coord(claims)
            cache[qid] = {
                "official_url": extract_wikidata_claim_text(claims, "P856"),
                "image_name": extract_wikidata_claim_text(claims, "P18"),
                "lat": lat,
                "lng": lng,
            }
        time.sleep(1.0)


def category_members(title: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    cont: Dict[str, str] = {}
    while True:
        params = {
            "action": "query",
            "format": "json",
            "list": "categorymembers",
            "cmtitle": title,
            "cmlimit": "max",
        }
        params.update(cont)
        data = http_get_json(WIKIPEDIA_API + "?" + urlencode(params), timeout=60)
        out.extend(data.get("query", {}).get("categorymembers", []))
        if "continue" not in data:
            break
        cont = data["continue"]
    return out


def build_station_index(wiki_cache: Dict[str, Any]) -> List[Dict[str, Any]]:
    if STATIONS_CACHE_PATH.exists():
        try:
            return json.loads(STATIONS_CACHE_PATH.read_text())
        except Exception:
            pass
    queue = list(STATION_CATEGORY_SEEDS)
    seen_cats = set()
    station_titles: set[str] = set()
    while queue:
        cat = queue.pop(0)
        if cat in seen_cats:
            continue
        seen_cats.add(cat)
        try:
            members = category_members(cat)
        except Exception:
            continue
        for member in members:
            ns = member.get("ns")
            title = member.get("title", "")
            lower = title.lower()
            if ns == 0:
                station_titles.add(title)
            elif ns == 14:
                if any(x in lower for x in ["former", "closed", "disused", "proposed", "heritage", "listed", "opening"]):
                    continue
                if title.startswith("Category:Railway stations in ") or title in {"Category:SPT railway stations", "Category:Glasgow Subway stations"}:
                    queue.append(title)
        time.sleep(0.1)
    fetch_wikipedia_metadata(sorted(station_titles), wiki_cache)
    out: List[Dict[str, Any]] = []
    for title in sorted(station_titles):
        meta = wiki_cache.get(title) or {}
        cats = " ".join(meta.get("categories", [])).lower()
        if any(x in cats for x in ["former railway stations", "closed railway stations", "disused railway stations", "heritage railway stations", "proposed railway stations"]):
            continue
        lat = meta.get("lat")
        lng = meta.get("lng")
        if lat is None or lng is None:
            continue
        out.append({
            "name": title.replace(" railway station", "").replace(" station", "").strip(),
            "title": title,
            "lat": float(lat),
            "lng": float(lng),
            "source": meta.get("source") or wiki_page_url(title),
        })
    STATIONS_CACHE_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    return out


def find_nearest_station(lat: float, lng: float, stations: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    best = None
    best_km = 10**9
    for st in stations:
        dist = haversine(lat, lng, st["lat"], st["lng"])
        if dist < best_km:
            best_km = dist
            best = dict(st)
            best["distance_km"] = dist
    return best


def strip_html(text: str) -> str:
    text = re.sub(r"<script\b.*?</script>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<style\b.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return clean_text(text)


def flatten_jsonld(data: Any) -> Iterator[Dict[str, Any]]:
    if isinstance(data, dict):
        yield data
        for key in ("@graph", "hasPart", "mainEntity", "itemListElement"):
            value = data.get(key)
            if isinstance(value, list):
                for item in value:
                    yield from flatten_jsonld(item)
            elif isinstance(value, dict):
                yield from flatten_jsonld(value)
    elif isinstance(data, list):
        for item in data:
            yield from flatten_jsonld(item)


def day_name(v: str) -> str:
    v = v.rsplit("/", 1)[-1]
    mapping = {
        "Monday": "Mon", "Tuesday": "Tue", "Wednesday": "Wed", "Thursday": "Thu",
        "Friday": "Fri", "Saturday": "Sat", "Sunday": "Sun",
    }
    return mapping.get(v, v[:3])


def format_opening_hours_spec(specs: List[Dict[str, Any]]) -> Optional[str]:
    rows: List[Tuple[Tuple[str, ...], str, str]] = []
    for spec in specs:
        opens = spec.get("opens")
        closes = spec.get("closes")
        days = spec.get("dayOfWeek")
        if not opens or not closes or not days:
            continue
        if isinstance(days, str):
            days = [days]
        days_fmt = tuple(day_name(d) for d in days)
        rows.append((days_fmt, str(opens), str(closes)))
    if not rows:
        return None
    grouped: Dict[Tuple[str, str], List[str]] = defaultdict(list)
    for days, opens, closes in rows:
        grouped[(opens, closes)].extend(days)
    parts = []
    order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    for (opens, closes), days in grouped.items():
        unique = [d for d in order if d in set(days)]
        if unique == order:
            day_part = "Mon-Sun"
        else:
            day_part = ", ".join(unique)
        parts.append(f"{day_part} {opens}-{closes}")
    return "; ".join(parts[:4])


def extract_official_metadata(url: str, cache: Dict[str, Any]) -> Dict[str, Any]:
    if url in cache:
        return cache[url]
    result = {"hours": None, "rating": None, "price_level": None, "price_source": None, "image_url": None}
    try:
        html_text = http_get(url, timeout=70, retries=2)
    except Exception:
        cache[url] = result
        return result

    scripts = re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html_text, flags=re.S | re.I)
    for raw in scripts:
        raw = raw.strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            try:
                data = json.loads(re.sub(r"^<!--|-->$", "", raw).strip())
            except Exception:
                continue
        for node in flatten_jsonld(data):
            if not isinstance(node, dict):
                continue
            if not result["image_url"]:
                image = node.get("image")
                if isinstance(image, str) and image.startswith("http") and "logo" not in image.lower():
                    result["image_url"] = image
                elif isinstance(image, list):
                    for img in image:
                        if isinstance(img, str) and img.startswith("http") and "logo" not in img.lower():
                            result["image_url"] = img
                            break
            if not result["hours"]:
                if isinstance(node.get("openingHours"), list):
                    result["hours"] = "; ".join(str(x) for x in node["openingHours"][:4])
                elif isinstance(node.get("openingHours"), str):
                    result["hours"] = node["openingHours"]
                elif isinstance(node.get("openingHoursSpecification"), list):
                    result["hours"] = format_opening_hours_spec(node["openingHoursSpecification"])
            agg = node.get("aggregateRating")
            if not result["rating"] and isinstance(agg, dict):
                rating = agg.get("ratingValue")
                try:
                    if rating is not None:
                        result["rating"] = round(float(rating), 1)
                except Exception:
                    pass
            if result["price_level"] is None:
                price = node.get("priceRange") or node.get("price")
                if isinstance(price, str):
                    if "free" in price.lower():
                        result["price_level"] = 1
                        result["price_source"] = price
                    elif "££££" in price or "$$$$" in price:
                        result["price_level"] = 4
                        result["price_source"] = price
                    elif "£££" in price or "$$$" in price:
                        result["price_level"] = 3
                        result["price_source"] = price
                    elif "££" in price or "$$" in price:
                        result["price_level"] = 2
                        result["price_source"] = price
                    elif "£" in price or "$" in price:
                        result["price_level"] = 1
                        result["price_source"] = price
    if not result["hours"]:
        text = strip_html(html_text)
        patterns = [
            r"opening hours?[:\s]+([^\.]{8,120})",
            r"open daily[:\s]+([^\.]{4,80})",
            r"daily[:\s]+([0-9apm: \-–to]+)",
            r"hours[:\s]+([^\.]{8,120})",
        ]
        for pat in patterns:
            m = re.search(pat, text, flags=re.I)
            if m:
                candidate = clean_text(m.group(1))
                if len(candidate) >= 4:
                    result["hours"] = candidate[:120]
                    break
    if not result["image_url"]:
        m = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', html_text, flags=re.I)
        if m and "logo" not in m.group(1).lower():
            result["image_url"] = m.group(1)
    cache[url] = result
    return result


def nominatim_lookup(query: str, cache: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if query in cache:
        return cache[query]
    params = {
        "format": "jsonv2",
        "limit": 1,
        "extratags": 1,
        "namedetails": 1,
        "q": query,
    }
    url = NOMINATIM_API + "?" + urlencode(params)
    try:
        data = http_get_json(url, timeout=50)
    except Exception:
        cache[query] = None
        return None
    cache[query] = data[0] if data else None
    time.sleep(1.0)
    return cache[query]


def station_string(station: Dict[str, Any], distance_km: float) -> str:
    name = station["name"]
    if distance_km > 30:
        return f"{name} (nearest rail station)"
    return name


def add_source(record: Dict[str, Any], url: Optional[str]) -> None:
    if not url:
        return
    urls = record.setdefault("source_urls", [])
    if url not in urls:
        urls.append(url)


def enrich_record(record: Dict[str, Any], wiki_cache: Dict[str, Any], wikidata_cache: Dict[str, Any],
                  official_cache: Dict[str, Any], nom_cache: Dict[str, Any], stations: Sequence[Dict[str, Any]]) -> bool:
    changed = False
    field_sources = record.setdefault("field_sources", {})
    category = (record.get("category") or "").strip().lower()
    source_urls = record.get("source_urls") or []
    wiki_url = next((u for u in source_urls if "wikipedia.org/wiki/" in u), None)
    official_in_sources = [u for u in source_urls if "wikipedia.org" not in u and "wikimedia.org" not in u]

    title = normalize_title_from_wiki_url(wiki_url) if wiki_url else None
    wiki_meta = wiki_cache.get(title, {}) if title else {}
    qid = wiki_meta.get("qid")
    wikidata = wikidata_cache.get(qid, {}) if qid else {}
    official_url = official_in_sources[0] if official_in_sources else wikidata.get("official_url")

    lat = record.get("lat")
    lng = record.get("lng")
    if lat is None or lng is None:
        new_lat = wiki_meta.get("lat") if wiki_meta else None
        new_lng = wiki_meta.get("lng") if wiki_meta else None
        if new_lat is None or new_lng is None:
            new_lat = wikidata.get("lat") if wikidata else None
            new_lng = wikidata.get("lng") if wikidata else None
        if new_lat is None or new_lng is None:
            query = record.get("address") or f"{record.get('name')}, {record.get('city')}, Scotland"
            geo = nominatim_lookup(query, nom_cache)
            if geo:
                try:
                    new_lat = float(geo.get("lat"))
                    new_lng = float(geo.get("lon"))
                except Exception:
                    new_lat = new_lng = None
        if new_lat is not None and new_lng is not None:
            record["lat"] = round(float(new_lat), 6)
            record["lng"] = round(float(new_lng), 6)
            lat = record["lat"]
            lng = record["lng"]
            src = wiki_meta.get("source") or official_url or "https://nominatim.openstreetmap.org/"
            field_sources["lat"] = src
            field_sources["lng"] = src
            changed = True

    if not record.get("image_url"):
        image = None
        image_source = None
        if wiki_meta.get("image_url"):
            image = wiki_meta["image_url"]
            image_source = wiki_meta.get("source")
        elif wikidata.get("image_name"):
            image = commons_file_url(wikidata["image_name"])
            image_source = f"https://www.wikidata.org/wiki/{qid}"
        elif official_url:
            official_meta = extract_official_metadata(official_url, official_cache)
            image = official_meta.get("image_url")
            image_source = official_url
        if image:
            record["image_url"] = image
            field_sources["image_url"] = image_source or official_url or wiki_url
            changed = True

    if official_url:
        add_source(record, official_url)

    hours_unknown = not record.get("hours") or record.get("hours_status") == "unknown" or str(record.get("hours", "")).strip().lower() in {"variable by season", "unknown"}
    if hours_unknown:
        new_hours = None
        hours_source = None
        if category in OPEN_ALWAYS_CATEGORIES:
            new_hours = "Open 24 hours"
            hours_source = official_url or wiki_url or source_urls[0]
        elif official_url:
            official_meta = extract_official_metadata(official_url, official_cache)
            if official_meta.get("hours"):
                new_hours = official_meta["hours"]
                hours_source = official_url
            if record.get("rating") is None and official_meta.get("rating") is not None:
                record["rating"] = official_meta["rating"]
                field_sources["rating"] = official_url
                changed = True
            if record.get("price_level") is None and official_meta.get("price_level") is not None:
                record["price_level"] = official_meta["price_level"]
                field_sources["price_level"] = official_url
                changed = True
        if new_hours:
            record["hours"] = clean_text(new_hours)
            record["hours_status"] = "known"
            field_sources["hours"] = hours_source or official_url or wiki_url
            changed = True

    if record.get("price_level") is None:
        if category in OPEN_ALWAYS_CATEGORIES:
            record["price_level"] = 1
            field_sources["price_level"] = official_url or wiki_url or source_urls[0]
            changed = True
        elif category in LIKELY_PAID_CATEGORIES and official_url:
            record["price_level"] = 2
            field_sources["price_level"] = official_url
            changed = True

    if (record.get("station") is None or str(record.get("station")).strip() == "") and lat is not None and lng is not None and stations:
        nearest = find_nearest_station(float(lat), float(lng), stations)
        if nearest:
            record["station"] = station_string(nearest, nearest["distance_km"])
            field_sources["station"] = nearest["source"]
            changed = True

    if changed:
        record["last_verified_at"] = NOW
    return changed


def main() -> int:
    json_files = sorted(p for p in OUT_DIR.glob("*.json") if p.is_file())
    if not json_files:
        print("No JSON files found", file=sys.stderr)
        return 1

    wiki_cache = load_cache(WIKI_META_CACHE_PATH)
    wikidata_cache = load_cache(WIKIDATA_CACHE_PATH)
    official_cache = load_cache(OFFICIAL_CACHE_PATH)
    nom_cache = load_cache(NOMINATIM_CACHE_PATH)

    records: List[Tuple[Path, Dict[str, Any]]] = []
    wiki_titles: set[str] = set()
    for path in json_files:
        data = json.loads(path.read_text())
        for rec in data.get("records", []):
            records.append((path, rec))
            for url in rec.get("source_urls", []):
                title = normalize_title_from_wiki_url(url)
                if title:
                    wiki_titles.add(title)

    fetch_wikipedia_metadata(sorted(wiki_titles), wiki_cache)
    qids = sorted({meta.get("qid") for meta in wiki_cache.values() if isinstance(meta, dict) and meta.get("qid")})
    fetch_wikidata_entities(qids, wikidata_cache)
    stations = build_station_index(wiki_cache)

    changed_files: Dict[Path, Dict[str, Any]] = {}
    changed_records = 0
    for path in json_files:
        changed_files[path] = json.loads(path.read_text())
    file_record_iters = {path: iter(changed_files[path].get("records", [])) for path in json_files}

    # Re-enrich using the mutable copies.
    total_changes = 0
    for path in json_files:
        for rec in changed_files[path].get("records", []):
            if enrich_record(rec, wiki_cache, wikidata_cache, official_cache, nom_cache, stations):
                total_changes += 1
                changed_records += 1

    for path in json_files:
        path.write_text(json.dumps(changed_files[path], ensure_ascii=False, indent=2) + "\n")

    save_cache(WIKI_META_CACHE_PATH, wiki_cache)
    save_cache(WIKIDATA_CACHE_PATH, wikidata_cache)
    save_cache(OFFICIAL_CACHE_PATH, official_cache)
    save_cache(NOMINATIM_CACHE_PATH, nom_cache)

    print(json.dumps({
        "files": len(json_files),
        "records": sum(len(changed_files[p].get("records", [])) for p in json_files),
        "stations": len(stations),
        "changed_records": changed_records,
        "total_changes": total_changes,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
