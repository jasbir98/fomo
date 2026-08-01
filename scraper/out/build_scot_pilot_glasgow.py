from __future__ import annotations

import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BATCH_ID = "scot-pilot-2026-07-25"
OUTPUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
USER_AGENT = "RoameoScotBuilder/1.0 (GitHub Copilot CLI)"


def nk(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unknown"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


SUMMARY_CACHE: dict[str, dict[str, Any] | None] = {}
LAST_REQUEST_TS = 0.0


def polite_sleep(min_interval: float = 0.2) -> None:
    global LAST_REQUEST_TS
    elapsed = time.time() - LAST_REQUEST_TS
    if elapsed < min_interval:
        time.sleep(min_interval - elapsed)
    LAST_REQUEST_TS = time.time()


def fetch_text(url: str, retries: int = 6) -> tuple[str, str]:
    for attempt in range(retries):
        polite_sleep()
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.read().decode("utf-8", "ignore"), response.geturl()
        except urllib.error.HTTPError as exc:
            if exc.code in {429, 500, 502, 503, 504} and attempt < retries - 1:
                time.sleep((attempt + 1) * 1.5)
                continue
            raise
        except Exception:
            if attempt < retries - 1:
                time.sleep((attempt + 1) * 1.5)
                continue
            raise
    raise RuntimeError(f"Unable to fetch text from {url}")


def wiki_page_url(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"


def fetch_summary(title_or_query: str) -> dict[str, Any] | None:
    if title_or_query in SUMMARY_CACHE:
        return SUMMARY_CACHE[title_or_query]
    url = wiki_page_url(title_or_query)
    try:
        page_html, final_url = fetch_text(url)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            SUMMARY_CACHE[title_or_query] = None
            return None
        raise
    if "Wikipedia does not have an article with this exact name." in page_html:
        SUMMARY_CACHE[title_or_query] = None
        return None
    canonical_match = re.search(r'<link rel="canonical" href="https://en\\.wikipedia\\.org/wiki/([^"#?]+)"', page_html)
    final_title = urllib.parse.unquote((canonical_match.group(1) if canonical_match else final_url.rsplit("/", 1)[-1])).replace("_", " ")
    coord_match = re.search(r'"wgCoordinates":\{"lat":([-0-9.]+),"lon":([-0-9.]+)\}', page_html)
    coords = None
    if coord_match:
        coords = {"lat": float(coord_match.group(1)), "lon": float(coord_match.group(2))}
    paras = re.findall(r"<p[^>]*>(.*?)</p>", page_html, re.S)
    extract = ""
    for para in paras:
        text = re.sub(r"<style.*?</style>", "", para, flags=re.S)
        text = re.sub(r"<sup[^>]*>.*?</sup>", "", text, flags=re.S)
        text = re.sub(r"<[^>]+>", "", text)
        text = html.unescape(text)
        text = re.sub(r"\[[^\]]*\]", "", text)
        text = re.sub(r"\\s+", " ", text).strip()
        if text:
            extract = text
            break
    if not extract:
        SUMMARY_CACHE[title_or_query] = None
        return None
    data = {"title": final_title, "extract": extract, "coordinates": coords}
    SUMMARY_CACHE[title_or_query] = data
    return data


def strip_parens(text: str) -> str:
    return re.sub(r"\s*\([^)]*\)", "", text).strip()


def clean_description(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return "Historic Scottish attraction."
    sentences = re.split(r"(?<=[.!?])\s+", text)
    description = " ".join(sentences[:2]).strip()
    if len(description) > 380:
        description = description[:377].rsplit(" ", 1)[0] + "..."
    return description


POSITIVE_KEYWORDS = [
    "museum",
    "gallery",
    "cathedral",
    "church",
    "kirk",
    "abbey",
    "priory",
    "castle",
    "palace",
    "park",
    "garden",
    "gardens",
    "green",
    "nature reserve",
    "wood",
    "woods",
    "estate",
    "house",
    "hall",
    "theatre",
    "theater",
    "arts centre",
    "arts center",
    "concert hall",
    "arena",
    "stadium",
    "library",
    "university",
    "college",
    "distillery",
    "brewery",
    "harbour",
    "harbor",
    "port",
    "quay",
    "market",
    "necropolis",
    "cemetery",
    "bridge",
    "tower",
    "steeple",
    "monument",
    "memorial",
    "viewpoint",
    "falls",
    "linn",
    "loch",
    "walkway",
    "centre",
    "center",
    "grotto",
    "shrine",
    "observatory",
    "cross",
    "square",
    "cross",
    "canal",
    "baths",
    "village",
]

REJECT_TITLE_KEYWORDS = [
    "railway station",
    "train station",
    "secondary school",
    "high school",
    "college of",
    "election",
    "crash",
    "road",
    "motorway",
    "constituency",
    "fc",
    "f.c.",
    "a721",
    "airdrieonians",
]

REJECT_EXTRACT_KEYWORDS = [
    "footballer",
    "politician",
    "company",
    "constituency",
    "battle honours",
    "album",
    "song by",
    "surname",
]


def infer_category(title: str, extract: str) -> str:
    text = f"{title} {extract}".lower()
    if "cathedral" in text:
        return "cathedral"
    if any(word in text for word in ["church", "kirk", "basilica", "shrine", "grotto"]):
        return "church"
    if "abbey" in text:
        return "abbey"
    if "priory" in text:
        return "historic building"
    if "castle" in text:
        return "castle"
    if "museum" in text or "heritage centre" in text or "heritage center" in text:
        return "museum"
    if "gallery" in text:
        return "gallery"
    if "observatory" in text:
        return "observatory"
    if "distillery" in text:
        return "distillery"
    if "brewery" in text:
        return "brewery"
    if "university" in text:
        return "university"
    if "theatre" in text or "concert hall" in text:
        return "theatre"
    if any(word in text for word in ["arts centre", "arts center", "science centre", "science center", "visitor centre", "visitor center"]):
        return "arts centre"
    if any(word in text for word in ["arena", "hydro"]):
        return "arena"
    if "stadium" in text or "velodrome" in text or "racecourse" in text:
        return "stadium"
    if any(word in text for word in ["garden", "gardens"]):
        return "garden"
    if any(word in text for word in ["park", "green", "links"]):
        return "park"
    if any(word in text for word in ["necropolis", "cemetery", "kirkyard"]):
        return "cemetery"
    if any(word in text for word in ["bridge", "viaduct"]):
        return "bridge"
    if any(word in text for word in ["monument", "memorial", "mausoleum", "steeple", "statue"]):
        return "monument"
    if any(word in text for word in ["quay", "harbour", "harbor", "port", "dock"]):
        return "harbour"
    if any(word in text for word in ["falls", "linn", "loch", "glen", "braes", "hill"]):
        return "viewpoint"
    if any(word in text for word in ["market", "square", "cross"]):
        return "landmark"
    if any(word in text for word in ["house", "hall", "chambers", "town hall", "town house", "library"]):
        return "historic building"
    return "landmark"


def attractive(title: str, extract: str) -> bool:
    lowered_title = title.lower()
    lowered_extract = extract.lower()
    if any(bad in lowered_title for bad in REJECT_TITLE_KEYWORDS):
        return False
    if any(bad in lowered_extract for bad in REJECT_EXTRACT_KEYWORDS):
        return False
    return any(keyword in lowered_title or keyword in lowered_extract for keyword in POSITIVE_KEYWORDS)


def title_to_name(title: str) -> str:
    name = title.replace("&amp;", "&")
    if ", North Lanarkshire" in name:
        name = name.replace(", North Lanarkshire", "")
    if ", Glasgow" in name and name not in {"Gallery of Modern Art, Glasgow"}:
        name = name.replace(", Glasgow", "")
    return strip_parens(name)


def build_record(city_spec: dict[str, Any], place_spec: dict[str, Any], fetched_at: str) -> dict[str, Any] | None:
    summary = fetch_summary(place_spec.get("title") or place_spec["query"])
    title = summary["title"] if summary else place_spec.get("title") or place_spec["query"]
    name = place_spec.get("name") or title_to_name(title)
    extract = summary.get("extract", "") if summary else place_spec.get("description", f"{name} is a visitor attraction in {city_spec['city']}, Scotland.")
    if summary and not place_spec.get("force") and not attractive(title, extract):
        return None
    coords = summary.get("coordinates") if summary else None
    lat = place_spec.get("lat", coords.get("lat") if coords else None)
    lng = place_spec.get("lng", coords.get("lon") if coords else None)
    wiki_url = wiki_page_url(title)
    category = place_spec.get("category") or infer_category(title, extract)
    address = place_spec.get("address") or f"{name}, {city_spec['city']}, Scotland"
    station = place_spec.get("station", city_spec.get("station"))
    hours = place_spec.get("hours")
    hours_status = place_spec.get("hours_status", "known" if hours else "unknown")
    source_urls = []
    for url in place_spec.get("source_urls", []):
        if url and url not in source_urls:
            source_urls.append(url)
    if wiki_url not in source_urls:
        source_urls.append(wiki_url)
    primary_source = place_spec.get("primary_source") or wiki_url
    address_source = place_spec.get("address_source") or primary_source
    record = {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(city_spec['prefecture'])}:{nk(city_spec['city'])}:{nk(name)}",
        "region": city_spec["region"],
        "prefecture": city_spec["prefecture"],
        "city": city_spec["city"],
        "country": "GB",
        "name": name,
        "category": category,
        "description": place_spec.get("description") or clean_description(extract),
        "tips": place_spec.get("tips", []),
        "hours": hours,
        "hours_status": hours_status,
        "station": station,
        "google_place_id": None,
        "lat": round(lat, 6) if isinstance(lat, (int, float)) else None,
        "lng": round(lng, 6) if isinstance(lng, (int, float)) else None,
        "address": address,
        "rating": None,
        "price_level": None,
        "image_url": None,
        "badges": place_spec.get("badges", []),
        "source_urls": source_urls,
        "field_sources": {
            "description": primary_source,
            "lat": primary_source,
            "lng": primary_source,
            "address": address_source,
        },
        "photo": None,
        "extraction_model": "copilot-cli-knowledge",
        "extraction_status": "extracted",
        "validation_errors": [],
        "approved": False,
        "rejected_reason": None,
        "fetched_at": fetched_at,
        "last_verified_at": fetched_at,
    }
    if hours:
        record["field_sources"]["hours"] = place_spec.get("hours_source", primary_source)
    if station:
        record["field_sources"]["station"] = place_spec.get("station_source", primary_source)
    return record


def ensure_targets(city_spec: dict[str, Any], records: list[dict[str, Any]], fetched_at: str) -> list[dict[str, Any]]:
    return records


def write_city_file(city_spec: dict[str, Any]) -> tuple[str, int, str]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"{nk(city_spec['city'])}.json"
    if path.exists():
        return city_spec["city"], 0, "skipped"
    fetched_at = now_iso()
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_place in city_spec["places"]:
        place_spec = raw_place if isinstance(raw_place, dict) else {"query": raw_place}
        record = build_record(city_spec, place_spec, fetched_at)
        if not record:
            continue
        key = record["name"].casefold()
        if key in seen:
            continue
        seen.add(key)
        records.append(record)
    records = ensure_targets(city_spec, records, fetched_at)
    data = {"records": records}
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return city_spec["city"], len(records), "written"


CITY_SPECS = [
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Glasgow City",
        "city": "Glasgow city centre",
        "tier": "major",
        "target": 40,
        "center": (55.8609, -4.2514),
        "station": "Glasgow Queen Street",
        "search_centers": [(55.8609, -4.2514), (55.8578, -4.2436)],
        "places": [
            {"query": "George Square", "category": "landmark", "address": "George Square, Glasgow G2 1DU", "station": "Glasgow Queen Street"},
            {"query": "Gallery of Modern Art, Glasgow", "category": "gallery", "address": "Royal Exchange Square, Glasgow G1 3AH", "station": "Glasgow Queen Street"},
            {"query": "Glasgow City Chambers", "category": "historic building", "address": "George Square, Glasgow G2 1DU", "station": "Glasgow Queen Street"},
            {"query": "The Lighthouse (Glasgow)", "name": "The Lighthouse", "category": "visitor centre", "address": "11 Mitchell Lane, Glasgow G1 3NU", "station": "Glasgow Central"},
            {"query": "Mitchell Library", "category": "historic building", "address": "North Street, Glasgow G3 7DN", "station": "Cowcaddens"},
            {"query": "Glasgow Royal Concert Hall", "category": "theatre", "address": "2 Sauchiehall Street, Glasgow G2 3NY", "station": "Buchanan Street"},
            {"query": "Theatre Royal, Glasgow", "category": "theatre", "address": "282 Hope Street, Glasgow G2 3QA", "station": "Cowcaddens"},
            {"query": "King's Theatre, Glasgow", "category": "theatre", "address": "297 Bath Street, Glasgow G2 4JN", "station": "Cowcaddens"},
            {"query": "Centre for Contemporary Arts", "category": "arts centre", "address": "350 Sauchiehall Street, Glasgow G2 3JD", "station": "Cowcaddens"},
            {"query": "Glasgow Film Theatre", "category": "theatre", "address": "12 Rose Street, Glasgow G3 6RB", "station": "Cowcaddens"},
            {"query": "Pavilion Theatre, Glasgow", "category": "theatre", "address": "121 Renfield Street, Glasgow G2 3AX", "station": "Cowcaddens"},
            {"query": "Buchanan Street", "category": "landmark", "address": "Buchanan Street, Glasgow city centre", "station": "Buchanan Street"},
            {"query": "Glasgow Central Station", "category": "historic building", "address": "Gordon Street, Glasgow G1 3SL", "station": "Glasgow Central"},
            {"query": "Glasgow Queen Street railway station", "name": "Glasgow Queen Street Station", "category": "historic building", "address": "North Hanover Street, Glasgow G1 2AF", "station": "Glasgow Queen Street"},
            {"query": "St. Enoch Centre", "name": "St Enoch Centre", "category": "historic building", "address": "St Enoch Square, Glasgow G1 4BW", "station": "St Enoch"},
            {"query": "Glasgow Green", "category": "park", "address": "Greendyke Street, Glasgow G1 5DB", "station": "Argyle Street"},
            {"query": "People's Palace", "category": "museum", "address": "Glasgow Green, Glasgow G40 1AT", "station": "Argyle Street"},
            {"query": "Doulton Fountain", "category": "monument", "address": "Glasgow Green, Glasgow G40 1AT", "station": "Argyle Street"},
            {"query": "Templeton on the Green", "name": "Templeton Building", "category": "historic building", "address": "Templeton Street, Glasgow G40 1DA", "station": "Argyle Street"},
            {"query": "St Andrew's in the Square", "category": "church", "address": "1 St Andrew's Square, Glasgow G1 5PP", "station": "Argyle Street"},
            {"query": "Glasgow Cross", "category": "landmark", "address": "Glasgow Cross, Glasgow G1", "station": "Argyle Street"},
            {"query": "Tron Theatre", "category": "theatre", "address": "63 Trongate, Glasgow G1 5HB", "station": "Argyle Street"},
            {"query": "Tron steeple", "name": "Tron Steeple", "category": "monument", "address": "Trongate, Glasgow G1 5ES", "station": "Argyle Street"},
            {"query": "Tolbooth Steeple, Glasgow", "category": "monument", "address": "Glasgow Cross, Glasgow G1 5NE", "station": "Argyle Street"},
            {"query": "The Barras", "name": "Barras Market", "category": "market", "address": "244 Gallowgate, Glasgow G4 0TT", "station": "Argyle Street"},
            {"query": "The Briggait", "name": "The Briggait", "category": "historic building", "address": "141 Bridgegate, Glasgow G1 5HZ", "station": "Argyle Street"},
            {"query": "City Halls & Old Fruitmarket", "category": "theatre", "address": "Candleriggs, Glasgow G1 1NQ", "station": "Argyle Street"},
            {"query": "Merchant Square", "category": "historic building", "address": "71 Albion Street, Glasgow G1 1NY", "station": "Argyle Street"},
            {"query": "Sharmanka Kinetic Theatre", "category": "theatre", "address": "103 Trongate, Glasgow G1 5HD", "station": "Argyle Street"},
            {"query": "Trongate 103", "category": "arts centre", "address": "103 Trongate, Glasgow G1 5HD", "station": "Argyle Street", "force": True, "description": "Contemporary arts centre in a converted Edwardian warehouse hosting galleries, artist studios, and performance spaces in the heart of Glasgow's historic Trongate."},
            {"query": "Provand's Lordship", "category": "historic building", "address": "3 Castle Street, Glasgow G4 0RH", "station": "High Street"},
            {"query": "St Mungo Museum of Religious Life and Art", "name": "St Mungo Museum of Religious Life and Art", "category": "museum", "address": "2 Castle Street, Glasgow G4 0RH", "station": "High Street"},
            {"query": "Glasgow Cathedral", "category": "cathedral", "address": "Castle Street, Glasgow G4 0QZ", "station": "High Street"},
            {"query": "Glasgow Necropolis", "name": "The Necropolis", "category": "cemetery", "address": "50 Cathedral Square, Glasgow G4 0UZ", "station": "High Street"},
            {"query": "Wellpark Brewery", "name": "Tennent's Brewery", "category": "brewery", "address": "161 Duke Street, Glasgow G31 1JD", "station": "High Street"},
            {"query": "Kelvingrove Art Gallery and Museum", "category": "museum", "address": "Argyle Street, Glasgow G3 8AG", "station": "Kelvinhall"},
            {"query": "Riverside Museum", "category": "museum", "address": "100 Pointhouse Place, Glasgow G3 8RS", "station": "Partick"},
            {"query": "Glasgow Science Centre", "category": "arts centre", "address": "50 Pacific Quay, Glasgow G51 1EA", "station": "Exhibition Centre"},
            {"query": "The SSE Hydro", "name": "OVO Hydro", "category": "arena", "address": "Exhibition Way, Glasgow G3 8YW", "station": "Exhibition Centre"},
            {"query": "SEC Centre", "category": "arena", "address": "Exhibition Way, Glasgow G3 8YW", "station": "Exhibition Centre"},
            {"query": "Royal Exchange Square", "category": "landmark", "address": "Royal Exchange Square, Glasgow G1 3AJ", "station": "Glasgow Queen Street"},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Glasgow City",
        "city": "Merchant City",
        "tier": "mid",
        "target": 25,
        "center": (55.8578, -4.2436),
        "station": "Argyle Street",
        "search_centers": [(55.8578, -4.2436), (55.8598, -4.2392)],
        "places": [
            {"query": "Merchant City", "category": "historic building", "address": "Merchant City, Glasgow city centre"},
            {"query": "George Square", "category": "landmark", "address": "George Square, Glasgow G2 1DU", "station": "Glasgow Queen Street"},
            {"query": "City Halls & Old Fruitmarket", "category": "theatre", "address": "Candleriggs, Glasgow G1 1NQ"},
            {"query": "Merchant Square", "category": "historic building", "address": "71 Albion Street, Glasgow G1 1NY"},
            {"query": "Trades Hall of Glasgow", "category": "historic building", "address": "85 Glassford Street, Glasgow G1 1UH"},
            {"query": "Old High Court, Glasgow", "category": "historic building", "address": "1 Saltmarket, Glasgow G1 5JT"},
            {"query": "Glasgow Cross", "category": "landmark", "address": "Glasgow Cross, Glasgow G1"},
            {"query": "Tron Theatre", "category": "theatre", "address": "63 Trongate, Glasgow G1 5HB"},
            {"query": "Tron steeple", "name": "Tron Steeple", "category": "monument", "address": "Trongate, Glasgow G1 5ES"},
            {"query": "Tolbooth Steeple, Glasgow", "category": "monument", "address": "Glasgow Cross, Glasgow G1 5NE"},
            {"query": "St Andrew's in the Square", "category": "church", "address": "1 St Andrew's Square, Glasgow G1 5PP"},
            {"query": "The Barras", "name": "Barras Market", "category": "market", "address": "244 Gallowgate, Glasgow G4 0TT"},
            {"query": "The Briggait", "name": "The Briggait", "category": "historic building", "address": "141 Bridgegate, Glasgow G1 5HZ"},
            {"query": "Sharmanka Kinetic Theatre", "category": "theatre", "address": "103 Trongate, Glasgow G1 5HD"},
            {"query": "Trongate 103", "category": "arts centre", "address": "103 Trongate, Glasgow G1 5HD", "force": True, "description": "Contemporary arts venue in a converted warehouse, home to galleries, artist studios, and performance spaces on Glasgow's historic Trongate."},
            {"query": "Ramshorn Cemetery", "category": "cemetery", "address": "98 Ingram Street, Glasgow G1 1EX"},
            {"query": "University of Strathclyde", "category": "university", "address": "16 Richmond Street, Glasgow G1 1XQ", "station": "High Street"},
            {"query": "Provand's Lordship", "category": "historic building", "address": "3 Castle Street, Glasgow G4 0RH", "station": "High Street"},
            {"query": "St Mungo Museum of Religious Life and Art", "category": "museum", "address": "2 Castle Street, Glasgow G4 0RH", "station": "High Street"},
            {"query": "Glasgow Cathedral", "category": "cathedral", "address": "Castle Street, Glasgow G4 0QZ", "station": "High Street"},
            {"query": "Glasgow Necropolis", "name": "The Necropolis", "category": "cemetery", "address": "50 Cathedral Square, Glasgow G4 0UZ", "station": "High Street"},
            {"query": "Gallery of Modern Art, Glasgow", "category": "gallery", "address": "Royal Exchange Square, Glasgow G1 3AH", "station": "Glasgow Queen Street"},
            {"query": "Tobacco Merchant's House", "category": "historic building", "address": "42 Miller Street, Glasgow G1 1DT"},
            {"query": "Hutchesons' Hall", "category": "historic building", "address": "158 Ingram Street, Glasgow G1 1EJ"},
            {"query": "Royal Exchange Square", "category": "landmark", "address": "Royal Exchange Square, Glasgow G1 3AJ", "station": "Glasgow Queen Street"},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Glasgow City",
        "city": "West End",
        "tier": "mid",
        "target": 25,
        "center": (55.8726, -4.2883),
        "station": "Hillhead",
        "search_centers": [(55.8726, -4.2883), (55.8682, -4.2939), (55.8670, -4.3051)],
        "places": [
            {"query": "Kelvingrove Art Gallery and Museum", "category": "museum", "address": "Argyle Street, Glasgow G3 8AG", "station": "Kelvinhall"},
            {"query": "Kelvingrove Park", "category": "park", "address": "Park Terrace, Glasgow G3 6BY", "station": "Kelvinbridge"},
            {"query": "Glasgow Botanic Gardens", "category": "garden", "address": "730 Great Western Road, Glasgow G12 0UE"},
            {"query": "University of Glasgow", "category": "university", "address": "University Avenue, Glasgow G12 8QQ"},
            {"query": "Hunterian Museum and Art Gallery", "name": "Hunterian Museum", "category": "museum", "address": "University Avenue, Glasgow G12 8QQ"},
            {"query": "Hunterian Art Gallery", "category": "gallery", "address": "82 Hillhead Street, Glasgow G12 8QQ"},
            {"query": "Mackintosh House", "category": "historic building", "address": "82 Hillhead Street, Glasgow G12 8QQ"},
            {"query": "Bute Hall", "category": "historic building", "address": "University Avenue, Glasgow G12 8QQ"},
            {"query": "Byres Road", "category": "landmark", "address": "Byres Road, Glasgow West End"},
            {"query": "Hillhead", "category": "landmark", "address": "Hillhead, Glasgow West End"},
            {"query": "Ashton Lane", "category": "landmark", "address": "Ashton Lane, Glasgow G12"},
            {"query": "Oran Mor", "name": "Òran Mór", "category": "historic building", "address": "Top of Byres Road, Glasgow G12 8QX"},
            {"query": "Cottiers Theatre", "category": "theatre", "address": "93-95 Hyndland Street, Glasgow G11 5PU", "station": "Partick"},
            {"query": "The Mackintosh Church", "category": "church", "address": "870 Garscube Road, Glasgow G20 7EL", "station": "St George's Cross"},
            {"query": "Kelvin Hall", "category": "historic building", "address": "1445 Argyle Street, Glasgow G3 8AW", "station": "Kelvinhall"},
            {"query": "Glenlee (ship)", "name": "The Tall Ship at Riverside", "category": "landmark", "address": "150 Pointhouse Place, Glasgow G3 8RS", "station": "Partick"},
            {"query": "Riverside Museum", "category": "museum", "address": "100 Pointhouse Place, Glasgow G3 8RS", "station": "Partick"},
            {"query": "Glasgow Science Centre", "category": "arts centre", "address": "50 Pacific Quay, Glasgow G51 1EA", "station": "Exhibition Centre"},
            {"query": "The SSE Hydro", "name": "OVO Hydro", "category": "arena", "address": "Exhibition Way, Glasgow G3 8YW", "station": "Exhibition Centre"},
            {"query": "SEC Centre", "category": "arena", "address": "Exhibition Way, Glasgow G3 8YW", "station": "Exhibition Centre"},
            {"query": "Kelvingrove Bandstand and Amphitheatre", "category": "theatre", "address": "Kelvin Way, Glasgow G3 7TA", "station": "Kelvinbridge"},
            {"query": "Kibble Palace", "category": "garden", "address": "Glasgow Botanic Gardens, Glasgow G12 0UE"},
            {"query": "Western Baths", "category": "historic building", "address": "12 Cranworth Street, Glasgow G12 8BZ"},
            {"query": "Arlington Baths Club", "category": "historic building", "address": "61 Arlington Street, Glasgow G3 6DT", "station": "St George's Cross"},
            {"query": "Queen Margaret Union", "category": "historic building", "address": "22 University Gardens, Glasgow G12 8QN"},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Glasgow City",
        "city": "Southside",
        "tier": "minor",
        "target": 16,
        "center": (55.8358, -4.2534),
        "station": "Queens Park",
        "search_centers": [(55.8358, -4.2534), (55.8288, -4.3050)],
        "places": [
            {"query": "The Burrell Collection", "name": "Burrell Collection", "category": "museum", "address": "Pollok Country Park, Glasgow G43 1AT", "station": "Pollokshaws West"},
            {"query": "Pollok House", "category": "historic building", "address": "2060 Pollokshaws Road, Glasgow G43 1AT", "station": "Pollokshaws West"},
            {"query": "Pollok Country Park", "category": "park", "address": "2060 Pollokshaws Road, Glasgow G43 1AT", "station": "Pollokshaws West"},
            {"query": "House for an Art Lover", "category": "arts centre", "address": "Bellahouston Park, Glasgow G41 5BW", "station": "Ibrox"},
            {"query": "Bellahouston Park", "category": "park", "address": "Paisley Road West, Glasgow G52 1HH", "station": "Ibrox"},
            {"query": "Queen's Park, Glasgow", "name": "Queen's Park", "category": "park", "address": "520 Langside Road, Glasgow G42 8QR", "station": "Queens Park"},
            {"query": "Holmwood House", "category": "historic building", "address": "61-63 Netherlee Road, Glasgow G44 3YU", "station": "Cathcart"},
            {"query": "Hampden Park", "category": "stadium", "address": "Letherby Drive, Glasgow G42 9BA", "station": "Mount Florida"},
            {"query": "Scotland Street School Museum", "category": "museum", "address": "225 Scotland Street, Glasgow G5 8QB", "station": "Shields Road"},
            {"query": "Tramway (arts centre)", "name": "Tramway", "category": "arts centre", "address": "25 Albert Drive, Glasgow G41 2PE", "station": "West Street"},
            {"query": "The Hidden Gardens", "category": "garden", "address": "Tramway, 25 Albert Drive, Glasgow G41 2PE", "station": "West Street", "force": True, "description": "Community garden and outdoor arts space beside Tramway, offering a peaceful green retreat with planting inspired by Glasgow's multicultural Southside."},
            {"query": "Govanhill Baths", "category": "historic building", "address": "99 Calder Street, Glasgow G42 7RA", "station": "Queens Park", "force": True, "description": "Edwardian public baths and washhouse building turned heritage-led community venue, celebrated for its tilework and Southside civic history."},
            {"query": "Glasgow Climbing Centre", "category": "historic building", "address": "534 Paisley Road West, Glasgow G51 1RQ", "station": "Cessnock", "force": True, "description": "Former church converted into one of the UK's most atmospheric indoor climbing venues, noted for its stained glass and lofty nave."},
            {"query": "Linn Park", "category": "park", "address": "Simshill Road, Glasgow G44 5TA", "station": "Cathcart"},
            {"query": "Cathkin Braes", "category": "viewpoint", "address": "Cathkin Road, Glasgow G45 0AZ", "station": "Mount Florida"},
            {"query": "Pollokshaws Burgh Hall", "category": "historic building", "address": "2025 Pollokshaws Road, Glasgow G43 1NE", "station": "Pollokshaws East", "force": True, "description": "Victorian burgh hall serving as a restored civic landmark and events space in the heart of Glasgow's Southside."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Glasgow City",
        "city": "East End",
        "tier": "minor",
        "target": 16,
        "center": (55.8568, -4.2284),
        "station": "High Street",
        "search_centers": [(55.8568, -4.2284), (55.8508, -4.2355)],
        "places": [
            {"query": "Glasgow Cathedral", "category": "cathedral", "address": "Castle Street, Glasgow G4 0QZ"},
            {"query": "Glasgow Necropolis", "name": "The Necropolis", "category": "cemetery", "address": "50 Cathedral Square, Glasgow G4 0UZ"},
            {"query": "Provand's Lordship", "category": "historic building", "address": "3 Castle Street, Glasgow G4 0RH"},
            {"query": "St Mungo Museum of Religious Life and Art", "category": "museum", "address": "2 Castle Street, Glasgow G4 0RH"},
            {"query": "Glasgow Green", "category": "park", "address": "Greendyke Street, Glasgow G1 5DB", "station": "Argyle Street"},
            {"query": "People's Palace", "category": "museum", "address": "Glasgow Green, Glasgow G40 1AT", "station": "Argyle Street"},
            {"query": "Doulton Fountain", "category": "monument", "address": "Glasgow Green, Glasgow G40 1AT", "station": "Argyle Street"},
            {"query": "Templeton on the Green", "name": "Templeton Building", "category": "historic building", "address": "Templeton Street, Glasgow G40 1DA", "station": "Argyle Street"},
            {"query": "The Barras", "name": "Barras Market", "category": "market", "address": "244 Gallowgate, Glasgow G4 0TT", "station": "Argyle Street"},
            {"query": "Celtic Park", "category": "stadium", "address": "Janefield Street, Glasgow G40 3RE", "station": "Dalmarnock"},
            {"query": "Emirates Arena", "category": "stadium", "address": "1000 London Road, Glasgow G40 3HG", "station": "Dalmarnock"},
            {"query": "Sir Chris Hoy Velodrome", "category": "stadium", "address": "1000 London Road, Glasgow G40 3HG", "station": "Dalmarnock"},
            {"query": "Tollcross Park", "category": "park", "address": "Wellshot Road, Glasgow G32 7QR", "station": "Shettleston"},
            {"query": "Tollcross International Swimming Centre", "category": "historic building", "address": "350 Wellshot Road, Glasgow G32 7QP", "station": "Shettleston"},
            {"query": "Barrowland Ballroom", "category": "theatre", "address": "244 Gallowgate, Glasgow G4 0TT", "station": "Argyle Street"},
            {"query": "Wellpark Brewery", "name": "Tennent's Brewery", "category": "brewery", "address": "161 Duke Street, Glasgow G31 1JD"},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "North Lanarkshire",
        "city": "Motherwell",
        "tier": "mid",
        "target": 25,
        "center": (55.7891, -3.9985),
        "station": "Motherwell",
        "search_centers": [(55.7891, -3.9985), (55.7925, -4.0293), (55.8049, -4.0322)],
        "places": [
            {"query": "North Lanarkshire Heritage Centre", "category": "museum", "address": "High Road, Motherwell ML1 3HU"},
            {"query": "Motherwell Cathedral", "category": "cathedral", "address": "Coursington Road, Motherwell ML1 1PP"},
            {"query": "Motherwell Town Hall", "category": "historic building", "address": "Civic Centre, Windmillhill Street, Motherwell ML1 1AB"},
            {"query": "Fir Park", "category": "stadium", "address": "Fir Park Street, Motherwell ML1 2QN"},
            {"query": "Strathclyde Country Park", "category": "park", "address": "366 Hamilton Road, Motherwell ML1 3ED"},
            {"query": "Dalzell House", "category": "historic building", "address": "Dalzell Estate, Motherwell ML1 2SR"},
            {"query": "Dalzell Estate", "category": "park", "address": "Dalzell Estate, Motherwell ML1 2SR"},
            {"query": "Baron's Haugh", "category": "nature reserve", "address": "Baron's Haugh, Motherwell ML1 2UH"},
            {"query": "Bothwell Castle", "category": "castle", "address": "Castle Avenue, Bothwell G71 8BL"},
            {"query": "David Livingstone Birthplace", "category": "museum", "address": "165 Station Road, Blantyre G72 9BY"},
            {"query": "National Shrine of Our Lady of Lourdes, Carfin", "name": "Carfin Grotto", "category": "church", "address": "100 Newarthill Road, Motherwell ML1 5AL"},
            {"query": "M&D's", "name": "M&D's Scotland's Theme Park", "category": "park", "address": "Strathclyde Country Park, Motherwell ML1 3RT"},
            {"query": "Ravenscraig Regional Sports Facility", "category": "stadium", "address": "1 O'Donnell Way, Motherwell ML1 2TZ", "force": True, "description": "Large regional sports complex on the former steelworks site at Ravenscraig, representing Motherwell's industrial regeneration and often used by visiting sports fans."},
            {"query": "Roman Catholic Diocese of Motherwell", "category": "historic building", "address": "Coursington Road, Motherwell ML1 1PP"},
            {"query": "Chatelherault Country Park", "category": "park", "address": "Carlisle Road, Ferniegair, Hamilton ML3 7UE"},
            {"query": "Hamilton Mausoleum", "category": "monument", "address": "Mausoleum Road, Hamilton ML3 6AQ"},
            {"query": "Low Parks Museum", "category": "museum", "address": "129 Muir Street, Hamilton ML3 6BJ"},
            {"query": "Bothwell Parish Church", "category": "church", "address": "Main Street, Bothwell G71 8EX"},
            {"query": "Mosswater Local Nature Reserve", "category": "nature reserve", "address": "Mosswater Road, Motherwell ML1 2DB", "force": True, "description": "Urban wetland and green corridor in Motherwell popular for birdwatching and local walks."},
            {"query": "Dalziel St Andrew's Parish Church", "category": "church", "address": "Merry Street, Motherwell ML1 1JJ", "force": True, "description": "Major nineteenth-century church in central Motherwell reflecting the town's industrial-era growth."},
            {"query": "Aquatec", "name": "Aquatec Motherwell", "category": "historic building", "address": "Aquatec, Motherwell Civic Centre, Motherwell ML1 1AB", "force": True, "description": "Leisure and swimming complex beside Motherwell Civic Centre, often visited alongside the town hall and heritage centre."},
            {"query": "Hamilton Park Racecourse", "category": "stadium", "address": "Bothwell Road, Hamilton ML3 0DW"},
            {"query": "New Douglas Park", "category": "stadium", "address": "Cadzow Avenue, Hamilton ML3 0FT"},
            {"query": "Calderglen Country Park", "category": "park", "address": "Strathaven Road, East Kilbride G75 0QZ"},
            {"query": "Ravenscraig", "category": "historic building", "address": "Ravenscraig, Motherwell ML1 2FF", "force": True, "description": "Former steelworks site whose scale and regeneration story are central to Motherwell's industrial identity."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "North Lanarkshire",
        "city": "Wishaw",
        "tier": "minor",
        "target": 16,
        "center": (55.7734, -3.9197),
        "station": "Wishaw",
        "search_centers": [(55.7734, -3.9197), (55.7818, -3.9444)],
        "places": [
            {"query": "Cambusnethan House", "name": "Cambusnethan Priory", "category": "historic building", "address": "Off Manse Road, Wishaw ML2 8LR"},
            {"query": "Belhaven Park", "category": "park", "address": "Belhaven Terrace, Wishaw ML2 7NR"},
            {"query": "Wishaw Iron Works", "category": "historic building", "address": "Wishaw, North Lanarkshire", "force": True, "description": "Industrial heritage site recalling the nineteenth-century ironworks that helped shape Wishaw and the wider Lanarkshire coalfield."},
            {"query": "St Ignatius Church, Wishaw", "category": "church", "address": "Young Street, Wishaw ML2 8HN"},
            {"query": "South Wishaw Parish Church", "category": "church", "address": "Stewarton Street, Wishaw ML2 8AN"},
            {"query": "National Shrine of Our Lady of Lourdes, Carfin", "name": "Carfin Grotto", "category": "church", "address": "100 Newarthill Road, Motherwell ML1 5AL"},
            {"query": "Baron's Haugh", "category": "nature reserve", "address": "Baron's Haugh, Motherwell ML1 2UH"},
            {"query": "Dalzell House", "category": "historic building", "address": "Dalzell Estate, Motherwell ML1 2SR"},
            {"query": "Strathclyde Country Park", "category": "park", "address": "366 Hamilton Road, Motherwell ML1 3ED"},
            {"query": "Craignethan Castle", "category": "castle", "address": "Near Lanark ML11 8XF"},
            {"query": "Mauldslie Castle", "category": "historic building", "address": "Near Carluke ML8 5QE"},
            {"query": "Dalserf", "name": "Dalserf Church", "category": "church", "address": "Dalserf, Larkhall ML9 2TZ"},
            {"query": "Wishaw Public Hall", "category": "historic building", "address": "Stewarton Street, Wishaw ML2 8AA", "force": True, "description": "Civic hall in central Wishaw used for events and community gatherings."},
            {"query": "Cambusnethan Parish Church", "category": "church", "address": "Manse Road, Wishaw ML2 8LW", "force": True, "description": "Parish church beside the Cambusnethan estate, linked to the historic priory landscape."},
            {"query": "Chatelherault Country Park", "category": "park", "address": "Carlisle Road, Ferniegair, Hamilton ML3 7UE"},
            {"query": "Dalzell Estate", "category": "park", "address": "Dalzell Estate, Motherwell ML1 2SR"},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "North Lanarkshire",
        "city": "Airdrie",
        "tier": "mid",
        "target": 25,
        "center": (55.8665, -3.9797),
        "station": "Airdrie",
        "search_centers": [(55.8665, -3.9797), (55.8647, -4.0255)],
        "places": [
            {"query": "Airdrie Town Hall", "category": "historic building", "address": "Stirling Street, Airdrie ML6 0AS"},
            {"query": "Airdrie Town House", "category": "historic building", "address": "South Bridge Street, Airdrie ML6 6JA"},
            {"query": "County Buildings, Airdrie", "category": "historic building", "address": "Graham Street, Airdrie ML6 6JA"},
            {"query": "Airdrie Library", "category": "historic building", "address": "Wellwynd, Airdrie ML6 0AG"},
            {"query": "Airdrie Observatory", "category": "observatory", "address": "Airdrie Library, Wellwynd, Airdrie ML6 0AG"},
            {"query": "Broomfield Park", "category": "park", "address": "Airdrie ML6 6BN"},
            {"query": "Summerlee Museum of Scottish Industrial Life", "category": "museum", "address": "Heritage Way, Coatbridge ML5 1QD"},
            {"query": "Monkland Canal", "category": "landmark", "address": "Monkland Canal, Airdrie and Coatbridge"},
            {"query": "Drumpellier Country Park", "category": "park", "address": "Townhead Road, Coatbridge ML5 2TG"},
            {"query": "Excelsior Stadium", "category": "stadium", "address": "Craigneuk Avenue, Airdrie ML6 8QZ"},
            {"query": "The Time Capsule", "category": "historic building", "address": "100 Buchanan Street, Coatbridge ML5 1DL"},
            {"query": "North Lanarkshire Heritage Centre", "category": "museum", "address": "High Road, Motherwell ML1 3HU"},
            {"query": "Airdrie Public Observatory", "name": "Airdrie Observatory", "category": "observatory", "address": "Airdrie Library, Wellwynd, Airdrie ML6 0AG"},
            {"query": "Airdrie Savings Bank", "category": "historic building", "address": "Airdrie town centre", "force": True, "description": "Historic banking heritage site recalling one of Scotland's notable local savings institutions."},
            {"query": "St Andrew's Parish Church, Airdrie", "category": "church", "address": "Kirk Street, Airdrie ML6 6JH", "force": True, "description": "Prominent church in Airdrie town centre and a landmark of the burgh's Victorian expansion."},
            {"query": "Victoria Park, Airdrie", "category": "park", "address": "Airdrie ML6 9DR", "force": True, "description": "Public park serving west Airdrie with open space, sports grounds, and local views."},
            {"query": "Hillend Reservoir", "category": "viewpoint", "address": "Plains, near Airdrie", "force": True, "description": "Open reservoir and walking area in the hills above Airdrie with wide Lanarkshire views."},
            {"query": "Palacerigg Country Park", "category": "park", "address": "Palacerigg Road, Cumbernauld G67 3HU"},
            {"query": "Arria statue", "name": "Arria", "category": "monument", "address": "M80 motorway corridor, North Lanarkshire"},
            {"query": "Cumbernauld House", "category": "historic building", "address": "Cumbernauld House Park, Cumbernauld G67 3HU"},
            {"query": "World of Wings", "category": "visitor centre", "address": "Langlees, Cumbernauld G68 0FG", "force": True, "description": "Falconry and birds-of-prey visitor attraction within easy reach of Airdrie."},
            {"query": "Broadwood Stadium", "category": "stadium", "address": "1 Ardgoil Drive, Cumbernauld G68 9NE"},
            {"query": "Old Monkland Cemetery", "category": "cemetery", "address": "Old Monkland Road, Coatbridge ML5 5EA", "force": True, "description": "Historic cemetery reflecting the industrial and immigrant story of the Monklands."},
            {"query": "Cliftonhill Stadium", "category": "stadium", "address": "Main Street, Coatbridge ML5 3RS"},
            {"query": "St Augustine's Church, Coatbridge", "category": "church", "address": "Dundyvan Road, Coatbridge ML5 1DQ", "force": True, "description": "Large Roman Catholic church reflecting the shared heritage of Airdrie and Coatbridge."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "North Lanarkshire",
        "city": "Coatbridge",
        "tier": "minor",
        "target": 16,
        "center": (55.8612, -4.0266),
        "station": "Coatbridge Sunnyside",
        "search_centers": [(55.8612, -4.0266), (55.8565, -4.0333)],
        "places": [
            {"query": "Summerlee Museum of Scottish Industrial Life", "category": "museum", "address": "Heritage Way, Coatbridge ML5 1QD"},
            {"query": "The Time Capsule", "category": "historic building", "address": "100 Buchanan Street, Coatbridge ML5 1DL"},
            {"query": "Drumpellier Country Park", "category": "park", "address": "Townhead Road, Coatbridge ML5 2TG"},
            {"query": "Monkland Canal", "category": "landmark", "address": "Monkland Canal, Coatbridge"},
            {"query": "Cliftonhill Stadium", "category": "stadium", "address": "Main Street, Coatbridge ML5 3RS"},
            {"query": "Old Monkland Cemetery", "category": "cemetery", "address": "Old Monkland Road, Coatbridge ML5 5EA", "force": True, "description": "Historic cemetery and remembrance landscape reflecting Coatbridge's mining, ironworking, and immigrant heritage."},
            {"query": "Dunbeth Park", "category": "park", "address": "Dunbeth Road, Coatbridge ML5 3JW", "force": True, "description": "Victorian public park with mature trees, bandstand remains, and sporting grounds close to Coatbridge town centre."},
            {"query": "St Augustine's Church, Coatbridge", "category": "church", "address": "Dundyvan Road, Coatbridge ML5 1DQ", "force": True, "description": "Large Roman Catholic church symbolising Coatbridge's Irish-Catholic heritage and the town's nineteenth-century expansion."},
            {"query": "Summerlee Heritage Park", "name": "Summerlee Museum of Scottish Industrial Life", "category": "museum", "address": "Heritage Way, Coatbridge ML5 1QD"},
            {"query": "Coatbridge Town Hall", "category": "historic building", "address": "South Circular Road, Coatbridge ML5 3RB", "force": True, "description": "Civic performance venue and listed building in the centre of Coatbridge."},
            {"query": "St Patrick's Church, Coatbridge", "category": "church", "address": "Main Street, Coatbridge ML5 3RS", "force": True, "description": "Major town-centre church associated with Coatbridge's strong Irish heritage."},
            {"query": "Coatbridge Library", "category": "historic building", "address": "Academy Street, Coatbridge ML5 3AU", "force": True, "description": "Public library and civic building serving Coatbridge's historic centre."},
            {"query": "Whifflet Park", "category": "stadium", "address": "Easton Place, Coatbridge ML5 4EQ", "force": True, "description": "Football ground in the Whifflet district, part of Coatbridge's sporting landscape."},
            {"query": "Drumpellier House", "category": "historic building", "address": "Drumpellier Country Park, Coatbridge ML5 2TG", "force": True, "description": "Historic estate house associated with the former Drumpellier estate near Coatbridge."},
            {"query": "Gartsherrie", "category": "historic building", "address": "Gartsherrie, Coatbridge", "force": True, "description": "Historic district closely tied to Coatbridge's ironworks boom and industrial identity."},
            {"query": "Coatbridge Heritage Trail", "category": "landmark", "address": "Coatbridge town centre", "force": True, "description": "Waymarked route linking industrial, civic, and religious landmarks across Coatbridge."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "North Lanarkshire",
        "city": "Cumbernauld",
        "tier": "minor",
        "target": 16,
        "center": (55.9469, -3.9919),
        "station": "Cumbernauld",
        "search_centers": [(55.9469, -3.9919), (55.9598, -4.0119)],
        "places": [
            {"query": "Cumbernauld House", "category": "historic building", "address": "Cumbernauld House Park, Cumbernauld G67 3HU"},
            {"query": "Cumbernauld House Park", "category": "park", "address": "Cumbernauld House Park, Cumbernauld G67 3HU", "force": True, "description": "Historic parkland around Cumbernauld House with woodland paths, castle remains, and views into the old village core."},
            {"query": "Palacerigg Country Park", "category": "park", "address": "Palacerigg Road, Cumbernauld G67 3HU"},
            {"query": "Arria statue", "name": "Arria", "category": "monument", "address": "M80 motorway corridor, Cumbernauld"},
            {"query": "Antonine Wall", "category": "monument", "address": "Antonine Wall sites near Cumbernauld"},
            {"query": "Croy Hill", "category": "viewpoint", "address": "Kilsyth Road, Croy G65 9JP"},
            {"query": "Broadwood Stadium", "category": "stadium", "address": "1 Ardgoil Drive, Cumbernauld G68 9NE"},
            {"query": "World of Wings", "category": "visitor centre", "address": "Langlees, Cumbernauld G68 0FG", "force": True, "description": "Falconry and birds-of-prey visitor attraction offering demonstrations and close-up encounters on the edge of Cumbernauld."},
            {"query": "Dullatur", "category": "landmark", "address": "Dullatur, near Cumbernauld"},
            {"query": "Cumbernauld Theatre", "category": "theatre", "address": "Kildrum, Cumbernauld G67 2UF"},
            {"query": "Castlecary", "category": "monument", "address": "Castlecary, near Cumbernauld"},
            {"query": "Carrickstone", "category": "monument", "address": "Carrickstone, Cumbernauld"},
            {"query": "Cumbernauld Glen", "category": "park", "address": "Cumbernauld Glen, Cumbernauld", "force": True, "description": "Wooded ravine beside the old village with paths, bridges, and the scenic setting of Cumbernauld House."},
            {"query": "Broadwood Loch", "category": "park", "address": "Broadwood, Cumbernauld G68", "force": True, "description": "Lochside walking and wildlife area beside Broadwood Stadium and the wider sports complex."},
            {"query": "St Mungo's Parish Church, Cumbernauld", "category": "church", "address": "Cumbernauld Village, G67 2EB", "force": True, "description": "Historic parish church in the old village core beneath Cumbernauld House."},
            {"query": "Fannyside Muir", "category": "nature reserve", "address": "Fannyside, near Cumbernauld", "force": True, "description": "Open moorland landscape east of Cumbernauld known for wide views and big skies."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "South Lanarkshire",
        "city": "Lanark",
        "tier": "mid",
        "target": 25,
        "center": (55.6734, -3.7818),
        "station": "Lanark",
        "search_centers": [(55.6734, -3.7818), (55.6640, -3.7835)],
        "places": [
            {"query": "New Lanark", "category": "historic building", "address": "New Lanark, Lanark ML11 9DB"},
            {"query": "Falls of Clyde", "category": "nature reserve", "address": "New Lanark, Lanark ML11 9DB"},
            {"query": "Lanark Loch", "category": "park", "address": "Lanark ML11 9DB"},
            {"query": "Lanark Tolbooth", "category": "historic building", "address": "High Street, Lanark ML11 7EX"},
            {"query": "St Nicholas' Church, Lanark", "category": "church", "address": "St Nicholas Place, Lanark ML11 7TH"},
            {"query": "Castlebank Park", "category": "park", "address": "Castlebank, Lanark ML11 9EU"},
            {"query": "Corra Linn", "category": "viewpoint", "address": "Falls of Clyde, Lanark ML11 9DB"},
            {"query": "Bonnington Linn", "category": "viewpoint", "address": "Falls of Clyde, Lanark ML11 9DB"},
            {"query": "Stonebyres Falls", "category": "viewpoint", "address": "Near Lanark ML11 9UD"},
            {"query": "Cartland Craigs", "category": "nature reserve", "address": "Near Lanark ML11"},
            {"query": "Mouse Water", "category": "viewpoint", "address": "South Lanarkshire near Lanark"},
            {"query": "Craignethan Castle", "category": "castle", "address": "Near Lanark ML11 8XF"},
            {"query": "Clyde Walkway", "category": "viewpoint", "address": "Lanark section of the Clyde Walkway"},
            {"query": "New Lanark Visitor Centre", "category": "visitor centre", "address": "New Lanark, Lanark ML11 9DB", "force": True, "description": "Visitor gateway to the UNESCO-listed New Lanark mill village, interpreting social reform, water power, and industrial heritage on the River Clyde."},
            {"query": "Lanark Museum", "category": "museum", "address": "West Port, Lanark ML11 9HD", "force": True, "description": "Local history museum telling the story of Lanark's royal burgh past, trade, and links to the surrounding Clyde Valley."},
            {"query": "Cleghorn Glen", "category": "nature reserve", "address": "Cleghorn, near Lanark", "force": True, "description": "Wooded gorge and local nature reserve north of Lanark with dramatic river scenery."},
            {"query": "Corehouse", "category": "historic building", "address": "Near Lanark ML11 9TA", "force": True, "description": "Historic country house and estate above the Falls of Clyde, associated with the Clyde valley designed landscape."},
            {"query": "Corra Castle", "category": "castle", "address": "Falls of Clyde, Lanark ML11 9DB", "force": True, "description": "Romantic ruined keep overlooking the River Clyde near Corra Linn."},
            {"query": "Lee Castle, Lanark", "category": "historic building", "address": "Near Lanark ML11 9RT", "force": True, "description": "Historic estate house in the countryside south of Lanark."},
            {"query": "Lanark Memorial Hall", "category": "historic building", "address": "St Leonard Street, Lanark ML11 7AB", "force": True, "description": "Town hall and performance venue at the heart of Lanark's civic life."},
            {"query": "St Mary's Church, Lanark", "category": "church", "address": "Hope Street, Lanark ML11 7LZ", "force": True, "description": "Notable church in Lanark reflecting the town's long ecclesiastical tradition."},
            {"query": "Lanark Racecourse", "category": "historic building", "address": "Lanark Moor, Lanark", "force": True, "description": "Historic racecourse site representing Lanark's long sporting and fair-day traditions."},
            {"query": "Mousemill", "category": "historic building", "address": "Mouse Water, Lanark", "force": True, "description": "Heritage mill site in the Lanark area linked to the Mouse Water gorge landscape."},
            {"query": "Bonnington Pavilion", "category": "historic building", "address": "Falls of Clyde, Lanark", "force": True, "description": "Picturesque pavilion overlooking the Clyde valley near Bonnington Linn."},
            {"query": "Lanark Golf Club viewpoint", "category": "viewpoint", "address": "Lanark Moor Country Park, Lanark", "force": True, "description": "Open hilltop views over Lanark and the surrounding Clyde valley landscape."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "South Lanarkshire",
        "city": "Strathaven",
        "tier": "mid",
        "target": 25,
        "center": (55.6775, -4.0668),
        "station": None,
        "search_centers": [(55.6775, -4.0668), (55.6652, -4.0346)],
        "places": [
            {"query": "Strathaven Castle", "category": "castle", "address": "Todshill Street, Strathaven ML10 6AB"},
            {"query": "Strathaven Park", "category": "park", "address": "Glasgow Road, Strathaven ML10 6LZ"},
            {"query": "Strathaven Public Hall", "category": "historic building", "address": "Common Green, Strathaven ML10 6AG"},
            {"query": "John Hastie Museum", "category": "museum", "address": "11-13 Common Green, Strathaven ML10 6AF", "force": True, "description": "Compact local museum with displays on Strathaven's weaving, agriculture, and covenanting past."},
            {"query": "Sandford Heritage Museum", "category": "museum", "address": "Sandford, Strathaven ML10 6TB", "force": True, "description": "Volunteer-run village museum preserving stories of rural life, lace making, and the history of Sandford near Strathaven."},
            {"query": "Spectacle E'e Falls", "category": "viewpoint", "address": "Near Strathaven ML10 6SZ", "force": True, "description": "Woodland waterfall on the Avon Water reached by scenic paths, one of the best-loved natural beauty spots around Strathaven."},
            {"query": "Drumclog Memorial", "category": "monument", "address": "Drumclog, near Strathaven ML10 6QF", "force": True, "description": "Memorial to the 1679 Battle of Drumclog, an important covenanting site in South Lanarkshire history."},
            {"query": "Avondale Parish Church", "category": "church", "address": "Townhead Street, Strathaven ML10 6AB", "force": True, "description": "Prominent parish church serving Strathaven's historic burgh core and reflecting the town's long ecclesiastical history."},
            {"query": "Whitelee Wind Farm", "category": "visitor centre", "address": "Eaglesham Moor, G76 0QQ"},
            {"query": "Chatelherault Country Park", "category": "park", "address": "Carlisle Road, Ferniegair, Hamilton ML3 7UE"},
            {"query": "Calderglen Country Park", "category": "park", "address": "Strathaven Road, East Kilbride G75 0QZ"},
            {"query": "Allanshaw Gardens", "category": "garden", "address": "Strathaven ML10 6LF", "force": True, "description": "Community gardens and woodland walks on the edge of Strathaven Park."},
            {"query": "Strathaven East Parish Church", "category": "church", "address": "Kirk Street, Strathaven ML10 6LB", "force": True, "description": "Traditional parish church serving eastern Strathaven and its historic neighbourhoods."},
            {"query": "Strathaven West Parish Church", "category": "church", "address": "Bridge Street, Strathaven ML10 6AN", "force": True, "description": "Historic church in the west of Strathaven close to the old market town core."},
            {"query": "Castle Claven", "category": "historic building", "address": "Strathaven town centre", "force": True, "description": "Historic cluster of cottages and closes near Strathaven Castle preserving the old burgh character."},
            {"query": "Sandford", "category": "landmark", "address": "Sandford, Strathaven ML10 6TB"},
            {"query": "Glassford", "category": "landmark", "address": "Glassford, South Lanarkshire"},
            {"query": "Loudoun Hill", "category": "viewpoint", "address": "Near Darvel KA17 0LY", "force": True, "description": "Striking volcanic hill and battlefield landscape within reach of Strathaven."},
            {"query": "Drumclog", "category": "monument", "address": "Near Strathaven ML10 6QF"},
            {"query": "Avon Water Walk", "category": "viewpoint", "address": "Strathaven ML10", "force": True, "description": "Riverside walking route linking woodland, waterfalls, and covenanter history around Strathaven."},
            {"query": "Barncluith", "category": "historic building", "address": "Near Strathaven", "force": True, "description": "Historic rural estate site in the wider Strathaven countryside."},
            {"query": "Muirshiel viewpoint", "category": "viewpoint", "address": "High ground above Strathaven", "force": True, "description": "Open panoramic viewpoint over the Avon valley and surrounding Lanarkshire countryside."},
            {"query": "Strathaven Heritage Trail", "category": "landmark", "address": "Strathaven town centre", "force": True, "description": "Walking route linking the castle, common green, churches, and local museum across Strathaven."},
            {"query": "Strathaven Airfield", "category": "landmark", "address": "Strathaven ML10 6RW", "force": True, "description": "Small airfield long associated with Strathaven's aviation events and local flying community."},
            {"query": "Westhall", "category": "historic building", "address": "Near Strathaven ML10", "force": True, "description": "Historic estate landscape in the countryside around Strathaven."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "South Lanarkshire",
        "city": "Hamilton",
        "tier": "mid",
        "target": 25,
        "center": (55.7778, -4.0556),
        "station": "Hamilton Central",
        "search_centers": [(55.7778, -4.0556), (55.7859, -4.0365), (55.7911, -4.0209)],
        "places": [
            {"query": "Chatelherault Country Park", "category": "park", "address": "Carlisle Road, Ferniegair, Hamilton ML3 7UE"},
            {"query": "Hamilton Mausoleum", "category": "monument", "address": "Mausoleum Road, Hamilton ML3 6AQ"},
            {"query": "Low Parks Museum", "category": "museum", "address": "129 Muir Street, Hamilton ML3 6BJ"},
            {"query": "Hamilton Townhouse", "category": "historic building", "address": "102 Cadzow Street, Hamilton ML3 6HH"},
            {"query": "Hamilton Palace", "category": "historic building", "address": "Hamilton Palace Grounds, Hamilton", "force": True, "description": "Former ducal seat whose lost grandeur still shapes Hamilton's parks, monuments, and townscape; the surviving landscape is central to local heritage."},
            {"query": "Cadzow Castle", "category": "castle", "address": "Chatelherault Country Park, Hamilton ML3 7UE"},
            {"query": "Cadzow Glen", "category": "viewpoint", "address": "Chatelherault Country Park, Hamilton ML3 7UE", "force": True, "description": "Wooded gorge and scenic walking area below Chatelherault, famous for river views and the semi-ruined Cadzow Castle."},
            {"query": "Cadzow Oaks", "name": "Ancient Cadzow Oaks", "category": "park", "address": "Chatelherault Country Park, Hamilton ML3 7UE", "force": True, "description": "Protected herdland and ancient oak woodland associated with the Hamilton estate, one of the region's classic historic landscapes."},
            {"query": "Strathclyde Country Park", "category": "park", "address": "366 Hamilton Road, Motherwell ML1 3ED"},
            {"query": "Bothwell Castle", "category": "castle", "address": "Castle Avenue, Bothwell G71 8BL"},
            {"query": "David Livingstone Birthplace", "category": "museum", "address": "165 Station Road, Blantyre G72 9BY"},
            {"query": "Calderglen Country Park", "category": "park", "address": "Strathaven Road, East Kilbride G75 0QZ"},
            {"query": "Hamilton Park Racecourse", "category": "stadium", "address": "Bothwell Road, Hamilton ML3 0DW"},
            {"query": "New Douglas Park", "category": "stadium", "address": "Cadzow Avenue, Hamilton ML3 0FT"},
            {"query": "M&D's", "name": "M&D's Scotland's Theme Park", "category": "park", "address": "Strathclyde Country Park, Motherwell ML1 3RT"},
            {"query": "Hamilton Old Parish Church", "category": "church", "address": "Church Street, Hamilton ML3 6AA", "force": True, "description": "Historic parish church in Hamilton town centre, representing the burgh's long religious and civic story."},
            {"query": "Chatelherault Hunting Lodge", "category": "historic building", "address": "Chatelherault Country Park, Hamilton ML3 7UE", "force": True, "description": "Grand eighteenth-century hunting lodge forming the centrepiece of Chatelherault Country Park."},
            {"query": "Hamilton Palace Grounds", "category": "park", "address": "Hamilton ML3 6AQ", "force": True, "description": "Landscape around the vanished Hamilton Palace, still marked by avenues, monuments, and parkland."},
            {"query": "Hamilton Library", "category": "historic building", "address": "Muir Street, Hamilton ML3 6BJ", "force": True, "description": "Public library in Hamilton's civic quarter near Low Parks Museum and the town centre."},
            {"query": "Bothwell Parish Church", "category": "church", "address": "Main Street, Bothwell G71 8EX"},
            {"query": "Ferniegair Viaduct", "category": "bridge", "address": "Ferniegair, Hamilton ML3 7UG", "force": True, "description": "Railway viaduct and engineering landmark close to Chatelherault and the Avon gorge."},
            {"query": "Bent Cemetery", "category": "cemetery", "address": "Bent Road, Hamilton ML3 9QA", "force": True, "description": "Historic municipal cemetery with notable memorials and views over Hamilton."},
            {"query": "Blantyre Priory", "category": "historic building", "address": "Blantyre Priory, Blantyre G72", "force": True, "description": "Historic site linked to the wider Hamilton and Blantyre area heritage."},
            {"query": "Hamilton Heritage Trail", "category": "landmark", "address": "Hamilton town centre", "force": True, "description": "Walking route tying together the mausoleum, palace landscape, museums, and civic buildings of Hamilton."},
            {"query": "Avon Water viewpoint", "category": "viewpoint", "address": "Chatelherault Country Park, Hamilton", "force": True, "description": "Scenic viewpoint above the Avon Water gorge in the Hamilton estate landscape."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "South Lanarkshire",
        "city": "Carluke",
        "tier": "minor",
        "target": 16,
        "center": (55.7337, -3.8380),
        "station": "Carluke",
        "search_centers": [(55.7337, -3.8380), (55.7297, -3.8784)],
        "places": [
            {"query": "Cartland Craigs", "category": "nature reserve", "address": "Near Carluke ML8"},
            {"query": "Mouse Water", "category": "viewpoint", "address": "South Lanarkshire near Carluke"},
            {"query": "Craignethan Castle", "category": "castle", "address": "Near Lanark ML11 8XF"},
            {"query": "Mauldslie Castle", "category": "historic building", "address": "Near Carluke ML8 5QE"},
            {"query": "Falls of Clyde", "category": "nature reserve", "address": "New Lanark, Lanark ML11 9DB"},
            {"query": "New Lanark", "category": "historic building", "address": "New Lanark, Lanark ML11 9DB"},
            {"query": "Corra Linn", "category": "viewpoint", "address": "Falls of Clyde, Lanark ML11 9DB"},
            {"query": "Bonnington Linn", "category": "viewpoint", "address": "Falls of Clyde, Lanark ML11 9DB"},
            {"query": "Stonebyres Falls", "category": "viewpoint", "address": "Near Lanark ML11 9UD"},
            {"query": "Carluke High Kirk", "category": "church", "address": "Kirkton Street, Carluke ML8 4AB", "force": True, "description": "Town kirk overlooking central Carluke, reflecting the burgh's ecclesiastical heritage and local landmark skyline."},
            {"query": "Clyde Valley Woodlands", "category": "nature reserve", "address": "Clyde Valley near Carluke", "force": True, "description": "Network of native woodlands, river gorges, and walking trails that make the Clyde Valley one of South Lanarkshire's most scenic landscapes."},
            {"query": "Dalserf", "name": "Dalserf Church", "category": "church", "address": "Dalserf, Larkhall ML9 2TZ"},
            {"query": "Mauldslie Bridge", "category": "bridge", "address": "Near Carluke ML8 5QE", "force": True, "description": "Picturesque historic bridge in the Clyde valley near the Mauldslie estate."},
            {"query": "Cleghorn Glen", "category": "nature reserve", "address": "Near Carluke ML8", "force": True, "description": "Wooded gorge and walking route within easy reach of Carluke."},
            {"query": "Corehouse", "category": "historic building", "address": "Near Carluke ML8 5HZ", "force": True, "description": "Historic country house and estate on the River Clyde near Carluke."},
            {"query": "Jerviswood", "category": "historic building", "address": "Near Carluke ML8", "force": True, "description": "Historic estate landscape associated with the countryside around Carluke."},
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "South Lanarkshire",
        "city": "Larkhall",
        "tier": "minor",
        "target": 16,
        "center": (55.7384, -3.9737),
        "station": "Larkhall",
        "search_centers": [(55.7384, -3.9737), (55.7322, -4.0002)],
        "places": [
            {"query": "Chatelherault Country Park", "category": "park", "address": "Carlisle Road, Ferniegair, Hamilton ML3 7UE"},
            {"query": "Dalserf", "name": "Dalserf Church", "category": "church", "address": "Dalserf, Larkhall ML9 2TZ"},
            {"query": "Morgan Glen", "category": "viewpoint", "address": "Larkhall ML9 2UL", "force": True, "description": "Wooded glen and local beauty spot on the edge of Larkhall, popular for short scenic walks."},
            {"query": "Hamilton Mausoleum", "category": "monument", "address": "Mausoleum Road, Hamilton ML3 6AQ"},
            {"query": "Cadzow Glen", "category": "viewpoint", "address": "Chatelherault Country Park, Hamilton ML3 7UE", "force": True, "description": "River gorge and walking landscape close to Larkhall, offering one of the Clyde Valley's finest heritage walks."},
            {"query": "Spectacle E'e Falls", "category": "viewpoint", "address": "Near Strathaven ML10 6SZ", "force": True, "description": "Picturesque waterfall within reach of Larkhall, set in woodland on the Avon Water."},
            {"query": "Strathclyde Country Park", "category": "park", "address": "366 Hamilton Road, Motherwell ML1 3ED"},
            {"query": "Hamilton Palace", "category": "historic building", "address": "Hamilton Palace Grounds, Hamilton", "force": True, "description": "Lost ducal palace remembered through the surviving landscape features and monuments around Hamilton and Larkhall."},
            {"query": "Cadzow Castle", "category": "castle", "address": "Chatelherault Country Park, Hamilton ML3 7UE"},
            {"query": "Millheugh Falls", "category": "viewpoint", "address": "Near Larkhall ML9 2TZ", "force": True, "description": "Small but attractive waterfall and riverside beauty spot in the Avon Valley near Larkhall."},
            {"query": "Chatelherault Hunting Lodge", "category": "historic building", "address": "Chatelherault Country Park, Hamilton ML3 7UE", "force": True, "description": "The striking eighteenth-century hunting lodge that forms the focal point of Chatelherault Country Park."},
            {"query": "Dalserf Haugh", "category": "nature reserve", "address": "Dalserf, Larkhall ML9 2TZ", "force": True, "description": "Riverside meadows and woodland beside the Clyde near historic Dalserf Church."},
            {"query": "Larkhall Public Park", "category": "park", "address": "Larkhall ML9 1BB", "force": True, "description": "Traditional town park providing green space and recreation close to central Larkhall."},
            {"query": "Avon Water", "category": "viewpoint", "address": "Avon Water near Larkhall", "force": True, "description": "River corridor shaping the scenery around Larkhall and the route to nearby waterfalls and glens."},
            {"query": "Low Parks Museum", "category": "museum", "address": "129 Muir Street, Hamilton ML3 6BJ"},
            {"query": "Chatelherault Heritage Trail", "category": "landmark", "address": "Chatelherault Country Park, Hamilton", "force": True, "description": "Waymarked route linking the hunting lodge, ancient oaks, and gorge viewpoints near Larkhall."},
        ],
    },
]


def main() -> None:
    summary_rows = []
    for city_spec in CITY_SPECS:
        city, count, status = write_city_file(city_spec)
        summary_rows.append((city, count, status))
    print("Summary of records written per city:")
    for city, count, status in summary_rows:
        if status == "written":
            print(f"- {city}: {count} records written")
        else:
            print(f"- {city}: skipped (file already exists)")


if __name__ == "__main__":
    main()
