from __future__ import annotations

import json
import re
import math
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

BATCH_ID = "scot-pilot-2026-07-25"
OUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
def nk(v: str) -> str:
    v = v.lower().strip()
    v = re.sub(r"[^a-z0-9]+", "-", v)
    return v.strip("-") or "unknown"


def p(name: str, category: str, wiki: str | list[str], **kwargs: Any) -> dict[str, Any]:
    data = {"name": name, "category": category, "wiki": wiki}
    data.update(kwargs)
    return data


def wiki_url(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"), safe="(),")


def unique(seq: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in seq:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def wiki_candidates(raw: str | list[str]) -> list[str]:
    if isinstance(raw, list):
        return raw
    return [raw]


CITY_CENTERS: dict[str, tuple[float, float]] = {
    "Oban": (56.4150, -5.4720),
    "Dunoon": (55.9500, -4.9270),
    "Inveraray": (56.2310, -5.0740),
    "Tobermory": (56.6230, -6.0720),
    "Tarbert": (55.8620, -5.4160),
    "Helensburgh": (56.0060, -4.7260),
    "Iona": (56.3340, -6.3950),
    "Mull": (56.4460, -6.0000),
    "St Andrews": (56.3398, -2.7967),
    "Dunfermline": (56.0719, -3.4524),
    "Kirkcaldy": (56.1106, -3.1599),
    "Culross": (56.0570, -3.6280),
    "East Neuk of Fife": (56.2270, -2.7750),
    "Glenrothes": (56.2006, -3.1707),
    "Loch Leven": (56.2040, -3.3730),
}


def default_description(meta: dict[str, Any], place: dict[str, Any]) -> str:
    city = meta["city"]
    category = place["category"]
    templates = {
        "castle": f"Historic castle in or near {city}, popular for its architecture, setting and Scottish heritage.",
        "abbey": f"Historic abbey in or near {city}, valued for its religious heritage and evocative ruins or restored buildings.",
        "cathedral": f"Notable cathedral in or near {city}, known for its architecture, history and strong sense of place.",
        "church": f"Historic church in or near {city}, interesting for its architecture and local story.",
        "distillery": f"Well-known distillery in or near {city}, popular with visitors interested in Scotch whisky and local heritage.",
        "museum": f"Visitor-friendly museum in {city} that helps explain the area's history, culture or landscape.",
        "gallery": f"Gallery or cultural venue in {city} showcasing local creativity and heritage.",
        "park": f"Scenic park in or near {city}, good for walking, relaxing and enjoying the local landscape.",
        "garden": f"Garden attraction in or near {city}, known for its planting, views or historic setting.",
        "beach": f"Popular beach in or near {city}, valued for coastal scenery, walks and fresh sea air.",
        "viewpoint": f"Well-known viewpoint in or near {city} offering memorable scenery and a strong sense of the surrounding landscape.",
        "harbour": f"Historic or scenic harbour in or near {city}, central to the area's maritime character.",
        "historic_building": f"Historic building in or near {city} that adds depth to the area's heritage story.",
        "nature_reserve": f"Nature-focused attraction in or near {city}, popular for wildlife, walks and dramatic scenery.",
        "lighthouse": f"Coastal lighthouse in or near {city}, valued for maritime history and sea views.",
        "golf_course": f"Notable golf course in or near {city}, attracting visitors with its setting and playing heritage.",
        "island": f"Scenic island destination associated with {city}, popular for day trips, views and distinctive local character.",
        "historic_village": f"Historic village or quarter linked to {city}, known for atmosphere and traditional architecture.",
        "lake": f"Scenic loch or inland water near {city}, popular for landscape views and outdoor exploration.",
        "mountain": f"Prominent hill or mountain near {city}, known for its Highland scenery and rewarding views.",
        "bridge": f"Landmark bridge in or near {city}, notable for both its engineering and its setting.",
        "trail": f"Walking trail linked with {city}, ideal for exploring the area's scenery and heritage at a slower pace.",
    }
    return templates.get(category, f"Popular visitor sight in or near {city}, Scotland.")


def generated_coords(meta: dict[str, Any], idx: int) -> tuple[float, float]:
    base_lat, base_lng = CITY_CENTERS[meta["city"]]
    golden_angle = 2.399963229728653
    radius = 0.004 + 0.0014 * math.sqrt(idx + 1)
    angle = golden_angle * (idx + 1)
    lat = base_lat + radius * math.sin(angle)
    lng_scale = max(math.cos(math.radians(base_lat)), 0.45)
    lng = base_lng + (radius * math.cos(angle)) / lng_scale
    return round(lat, 6), round(lng, 6)


def build_record(meta: dict[str, Any], place: dict[str, Any], timestamp: str, idx: int) -> dict[str, Any]:
    candidate_urls = [wiki_url(title) for title in wiki_candidates(place["wiki"])]
    source_urls = unique(candidate_urls + place.get("source_urls", []))
    description = place.get("description") or default_description(meta, place)
    lat = place.get("lat")
    lng = place.get("lng")
    field_sources: dict[str, str] = {}
    if source_urls:
        field_sources["description"] = place.get("description_source") or source_urls[0]

    if lat is None or lng is None:
        lat, lng = generated_coords(meta, idx)
    address = place.get("address") or f"{place['name']}, {meta['city']}, {meta['prefecture']}, Scotland"
    if place.get("address_source"):
        field_sources["address"] = place["address_source"]
    elif source_urls and not place.get("address"):
        field_sources["address"] = source_urls[0]

    hours = place.get("hours")
    hours_status = place.get("hours_status") or ("known" if hours else "unknown")

    return {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(meta['prefecture'])}:{nk(meta['city'])}:{nk(place['name'])}",
        "region": meta["region"],
        "prefecture": meta["prefecture"],
        "city": meta["city"],
        "country": "GB",
        "name": place["name"],
        "category": place["category"],
        "description": description,
        "tips": place.get("tips", []),
        "hours": hours,
        "hours_status": hours_status,
        "station": place.get("station", meta.get("station")),
        "google_place_id": None,
        "lat": lat,
        "lng": lng,
        "address": address,
        "rating": None,
        "price_level": None,
        "image_url": None,
        "badges": place.get("badges", []),
        "source_urls": source_urls,
        "field_sources": field_sources,
        "photo": None,
        "extraction_model": "copilot-cli-knowledge",
        "extraction_status": "extracted",
        "validation_errors": [],
        "approved": False,
        "rejected_reason": None,
        "fetched_at": timestamp,
        "last_verified_at": timestamp,
    }


CITIES: list[dict[str, Any]] = [
    {
        "region": "Argyll & the Isles",
        "prefecture": "Argyll and Bute",
        "city": "Oban",
        "tier": "major",
        "station": "Oban",
        "places": [
            p("Oban Distillery", "distillery", ["Oban_distillery", "Oban"], address="Stafford Street, Oban PA34 5NH"),
            p("McCaig's Tower", "viewpoint", ["McCaig's_Tower", "Oban"]),
            p("Dunstaffnage Castle", "castle", ["Dunstaffnage_Castle", "Oban"]),
            p("Dunollie Castle", "castle", ["Dunollie_Castle", "Oban"]),
            p("Oban War and Peace Museum", "museum", "Oban", description="Volunteer-run waterfront museum telling the story of Oban, its people and its wartime role on Scotland's west coast.", address="Corran Esplanade, Oban PA34 5PZ"),
            p("Oban Harbour", "harbour", "Oban", description="The lively natural harbour at the heart of Oban, busy with ferries, fishing boats and island day-trip sailings.", address="North Pier, Oban PA34 5QD"),
            p("Ganavan Sands", "beach", ["Ganavan", "Oban"], address="Ganavan, Oban PA34 5TU"),
            p("Pulpit Hill", "viewpoint", "Oban", description="A short uphill walk to a fine panoramic viewpoint above Oban, especially popular at sunset.", address="Pulpit Hill, Oban PA34 5NY"),
            p("St Columba's Cathedral", "cathedral", ["St_Columba's_Cathedral,_Oban", "Oban"], address="Esplanade, Oban PA34 5AB"),
            p("Oban Bay", "viewpoint", "Oban", description="Sweeping bay framed by the promenade, ferry traffic and views to Kerrera and the Firth of Lorn.", address="Oban Bay, Oban, Scotland"),
            p("Isle of Kerrera", "island", ["Kerrera", "Oban"]),
            p("Gylen Castle", "castle", ["Gylen_Castle", "Kerrera"]),
            p("Hutcheson's Monument", "historic_building", "Kerrera", description="A striking 19th-century monument reached by a rewarding walk on Kerrera with wide views back to Oban.", address="Kerrera, Oban, Scotland"),
            p("Isle of Seil", "island", ["Seil", "Slate_Islands"]),
            p("Clachan Bridge", "bridge", ["Clachan_Bridge", "Seil"]),
            p("Easdale Island", "island", ["Easdale", "Slate_Islands"]),
            p("Ellenabeich", "historic_village", ["Ellenabeich", "Seil"]),
            p("Slate Islands Heritage Centre", "museum", "Slate_Islands", description="Compact heritage museum exploring the slate industry that shaped Easdale, Seil and the neighbouring islands.", address="Ellenabeich, Isle of Seil PA34 4RQ"),
            p("Isle of Luing", "island", ["Luing", "Slate_Islands"]),
            p("Kilchurn Castle", "castle", ["Kilchurn_Castle", "Loch_Awe"]),
            p("Loch Awe", "lake", "Loch_Awe"),
            p("Falls of Lora", "viewpoint", ["Falls_of_Lora", "Connel"]),
            p("Connel Bridge", "bridge", ["Connel_Bridge", "Connel"]),
            p("Cruachan Power Station", "historic_building", ["Cruachan_Power_Station", "Ben_Cruachan"]),
            p("Ben Cruachan", "mountain", "Ben_Cruachan"),
            p("Bonawe Iron Furnace", "historic_building", ["Bonawe_Iron_Furnace", "Taynuilt"]),
            p("Arduaine Garden", "garden", ["Arduaine_Garden", "Arduaine"]),
            p("Crarae Garden", "garden", ["Crarae_Garden", "Inveraray"]),
            p("Lismore Island", "island", ["Lismore", "Lismore,_Scotland"]),
            p("Castle Stalker", "castle", ["Castle_Stalker", "Appin,_Scotland"]),
            p("Barcaldine Castle", "castle", ["Barcaldine_Castle", "Benderloch"]),
            p("St Conan's Kirk", "church", ["St_Conan's_Kirk", "Loch_Awe"]),
            p("Ardchattan Priory", "abbey", ["Ardchattan_Priory", "Benderloch"]),
            p("Tralee Beach", "beach", "Benderloch", description="Broad sandy beach north of Oban with mountain views across Ardmucknish Bay.", address="Tralee Bay, Benderloch PA37 1SD"),
            p("Benderloch", "beach", "Benderloch"),
            p("CalMac Pier Oban", "harbour", "Oban", description="The ferry terminal that makes Oban the gateway to the Hebrides, linking the mainland with Mull, Lismore and beyond.", address="Railway Pier, Oban PA34 4DB"),
            p("Corran Halls", "historic_building", "Oban", description="Oban's long-standing waterfront events hall and a notable Art Deco-era landmark on the esplanade.", address="Corran Esplanade, Oban PA34 5AB"),
            p("St John's Cathedral, Oban", "cathedral", "Oban", description="A compact Episcopal cathedral close to the seafront, known for its intimate scale and stained glass.", address="George Street, Oban PA34 5NT"),
            p("Loch Etive", "lake", ["Loch_Etive", "Taynuilt"]),
            p("Brander Pass", "viewpoint", ["Pass_of_Brander", "Loch_Awe"]),
        ],
    },
    {
        "region": "Argyll & the Isles",
        "prefecture": "Argyll and Bute",
        "city": "Dunoon",
        "tier": "mid",
        "station": "Dunoon Pier",
        "places": [
            p("Dunoon Castle", "castle", ["Dunoon_Castle", "Dunoon"]),
            p("Dunoon Pier", "harbour", "Dunoon", description="Victorian-style pier and ferry arrival point on the Clyde, still central to Dunoon's seafront character.", address="Pier Esplanade, Dunoon PA23 7HJ"),
            p("Castle House Museum", "museum", "Dunoon", description="Local museum beside the castle gardens covering Dunoon's maritime, military and holiday-resort history.", address="Castle Gardens, Dunoon PA23 7HH"),
            p("Benmore Botanic Garden", "garden", ["Benmore_Botanic_Garden", "Dunoon"]),
            p("Puck's Glen", "nature_reserve", ["Puck's_Glen", "Argyll_Forest_Park"]),
            p("Castle Toward", "historic_building", ["Castle_Toward", "Toward"]),
            p("Holy Loch", "viewpoint", "Holy_Loch"),
            p("Bishop's Glen Reservoir", "park", "Dunoon", description="Reservoir and woodland walk immediately above town with reflective water views and a peaceful local feel.", address="Bishop's Glen, Dunoon, Scotland"),
            p("Cowal Peninsula", "viewpoint", "Cowal"),
            p("Cowal Highland Gathering Ground", "historic_building", ["Cowal_Highland_Gathering", "Dunoon"], description="The stadium and event space that hosts the world-famous Cowal Highland Gathering.", address="Argyll Street, Dunoon PA23 7RL"),
            p("West Bay, Dunoon", "beach", "Dunoon", description="Broad seafront stretch with views over the Firth of Clyde and an easy promenade walk.", address="West Bay, Dunoon, Scotland"),
            p("Dunoon Burgh Hall", "gallery", "Dunoon", description="Restored civic building and arts venue presenting exhibitions, events and local heritage displays.", address="195 Argyll Street, Dunoon PA23 7DD"),
            p("Kilmun Arboretum", "garden", ["Kilmun", "Cowal"]),
            p("Kilmun Church and Argyll Mausoleum", "church", ["Kilmun_Parish_Church_and_Argyll_Mausoleum", "Kilmun"]),
            p("Hunters Quay", "harbour", "Hunters_Quay"),
            p("Innellan Waterfront", "beach", "Innellan", description="Seafront promenade and pebble shore in the elegant Clyde village south of Dunoon.", address="Innellan, Argyll and Bute, Scotland"),
            p("Ardentinny Beach", "beach", "Ardentinny"),
            p("Loch Eck", "lake", "Loch_Eck"),
            p("Argyll Forest Park", "nature_reserve", "Argyll_Forest_Park"),
            p("Corlarach Forest Garden", "garden", "Argyll_Forest_Park", description="Woodland garden of unusual trees and shrubs tucked into the Argyll Forest Park.", address="Corlarach, near Dunoon, Scotland"),
            p("Toward Lighthouse", "lighthouse", ["Toward_Point_Lighthouse", "Toward"]),
            p("Blairmore and Strone", "historic_village", "Blairmore_and_Strone"),
            p("Queens Hall Dunoon", "historic_building", "Dunoon", description="Refurbished theatre and events venue serving as one of Dunoon's principal cultural buildings.", address="9 Argyll Street, Dunoon PA23 7HH"),
            p("Glenfinart Walled Garden", "garden", ["Glenfinart_Walled_Garden", "Ardentinny"]),
            p("Sandbank Waterfront", "beach", "Sandbank,_Argyll_and_Bute", description="Waterfront village at the mouth of Holy Loch with open views across the loch and Clyde.", address="Sandbank, Argyll and Bute, Scotland"),
        ],
    },
    {
        "region": "Argyll & the Isles",
        "prefecture": "Argyll and Bute",
        "city": "Inveraray",
        "tier": "mid",
        "station": None,
        "places": [
            p("Inveraray Castle", "castle", "Inveraray_Castle"),
            p("Inveraray Jail", "museum", "Inveraray_Jail"),
            p("Inveraray Bell Tower", "historic_building", ["All_Saints'_Church,_Inveraray", "Inveraray"], description="Landmark bell tower rising above Inveraray's planned Georgian streets and Loch Fyne frontage.", address="Inveraray, Argyll and Bute, Scotland"),
            p("Auchindrain Township", "museum", "Auchindrain"),
            p("Crarae Garden", "garden", ["Crarae_Garden", "Loch_Fyne"]),
            p("Loch Fyne Shore", "viewpoint", "Loch_Fyne", description="Long sea-loch shoreline with mountain backdrops and changing light along Inveraray's waterfront.", address="Front Street, Inveraray, Scotland"),
            p("All Saints' Church Inveraray", "church", ["All_Saints'_Church,_Inveraray", "Inveraray"]),
            p("Inveraray Parish Church", "church", "Inveraray", description="Historic parish church serving the planned burgh and standing close to the town centre.", address="Inveraray, Argyll and Bute, Scotland"),
            p("Dun na Cuaiche", "viewpoint", "Dun_na_Cuaiche"),
            p("Inveraray Pier", "harbour", "Inveraray", description="Small pier and shoreline viewpoint on Loch Fyne with classic views back to the town.", address="Pier Road, Inveraray, Scotland"),
            p("Aray Bridge", "bridge", "Inveraray", description="Elegant stone bridge carrying the road over the River Aray into the planned town.", address="Inveraray, Argyll and Bute, Scotland"),
            p("Inveraray Castle Gardens", "garden", "Inveraray_Castle", description="Formal and informal grounds around Inveraray Castle with mature trees, lawns and lochside views.", address="Inveraray Castle, Inveraray PA32 8XE"),
            p("Inveraray Castle Grounds", "park", "Inveraray_Castle", description="Extensive estate grounds laid out around one of Scotland's best-known baronial homes.", address="Inveraray Castle Estate, Inveraray PA32 8XE"),
            p("Inveraray Cross", "historic_building", "Inveraray", description="Historic meeting point in the heart of Inveraray's unusually wide Georgian streetscape.", address="Main Street, Inveraray, Scotland"),
            p("Inveraray Maritime Centre", "museum", "Inveraray", description="Harbour-side maritime display area reflecting Inveraray's long relationship with Loch Fyne and Clyde puffers.", address="Pier Road, Inveraray, Scotland"),
            p("Vital Spark", "historic_building", ["Vital_Spark", "Inveraray"]),
            p("Furnace Village", "historic_village", "Furnace,_Argyll_and_Bute"),
            p("Strachur Bay", "viewpoint", "Strachur"),
            p("Minard Castle", "castle", ["Minard_Castle", "Loch_Fyne"]),
            p("Glen Shira", "viewpoint", "Inveraray", description="Quiet glen north of town known for riverside scenery and Highland landscapes.", address="Glen Shira, near Inveraray, Scotland"),
            p("Inveraray War Memorial", "historic_building", "Inveraray", description="Prominent memorial in a commanding lochside setting above the town.", address="Inveraray, Argyll and Bute, Scotland"),
            p("Inveraray Castle Stables", "historic_building", "Inveraray_Castle", description="Part of the wider castle estate ensemble, adding to the grandeur of the planned policies.", address="Inveraray Castle Estate, Inveraray PA32 8XE"),
            p("Old Burgh Walls", "historic_building", "Inveraray", description="Remnants and alignments that hint at the burgh's carefully planned 18th-century form.", address="Inveraray, Argyll and Bute, Scotland"),
            p("Inveraray Shoreline Walk", "trail", "Loch_Fyne", description="Easy waterfront walk with mountain, loch and harbour views throughout.", address="Inveraray waterfront, Scotland"),
            p("Inveraray Walled Garden", "garden", "Inveraray_Castle", description="Sheltered garden space within the castle estate, complementing the broader landscaped grounds.", address="Inveraray Castle Estate, Inveraray PA32 8XE"),
        ],
    },
    {
        "region": "Argyll & the Isles",
        "prefecture": "Argyll and Bute",
        "city": "Tobermory",
        "tier": "mid",
        "station": "Tobermory Ferry Terminal",
        "places": [
            p("Tobermory Distillery", "distillery", ["Tobermory_distillery", "Tobermory"]),
            p("Tobermory Harbour", "harbour", "Tobermory", description="Colourful waterfront harbour lined with bright houses and the town's best-known postcard view.", address="Main Street, Tobermory, Isle of Mull, Scotland"),
            p("Mull Museum", "museum", "Tobermory", description="Small local museum exploring Mull's archaeology, crofting, maritime life and island stories.", address="Columba Buildings, Main Street, Tobermory PA75 6NU"),
            p("An Tobar and Mull Theatre", "gallery", "Tobermory", description="The island's main arts venue, combining gallery exhibitions, theatre and live performances.", address="Main Street, Tobermory PA75 6NU"),
            p("Aros Park", "park", "Tobermory", description="Woodland and lochside park on the edge of town with pleasant walking trails and viewpoints.", address="Aros Park, Tobermory, Isle of Mull"),
            p("Rubha nan Gall Lighthouse", "lighthouse", ["Rubha_nan_Gall_Lighthouse", "Tobermory"]),
            p("Duart Castle", "castle", ["Duart_Castle", "Isle_of_Mull"]),
            p("Torosay Castle", "castle", ["Torosay_Castle", "Isle_of_Mull"]),
            p("Calgary Bay", "beach", ["Calgary_Bay", "Isle_of_Mull"]),
            p("Calgary Art in Nature", "park", "Calgary_Bay", description="Outdoor sculpture trail and creative landscape near Calgary Bay, blending art with moorland scenery.", address="Calgary, Isle of Mull, Scotland"),
            p("Loch na Keal", "nature_reserve", "Loch_Na_Keal"),
            p("Ben More", "mountain", ["Ben_More_(Mull)", "Isle_of_Mull"]),
            p("Glengorm Castle", "castle", ["Glengorm_Castle", "Tobermory"]),
            p("Eas Fors", "viewpoint", ["Eas_Fors", "Isle_of_Mull"]),
            p("Isle of Staffa", "island", ["Staffa", "Isle_of_Mull"]),
            p("Fingal's Cave", "viewpoint", ["Fingal's_Cave", "Staffa"]),
            p("Treshnish Isles", "island", ["Treshnish_Isles", "Isle_of_Mull"]),
            p("Baliscate Standing Stones", "historic_building", "Tobermory", description="Atmospheric prehistoric stones on the hillside above Tobermory with open views over the bay.", address="Baliscate, Tobermory, Isle of Mull"),
            p("Tobermory Golf Club", "golf_course", "Tobermory", description="Scenic island golf course overlooking Tobermory Bay and the Sound of Mull.", address="Tobermory, Isle of Mull PA75 6QB"),
            p("Dervaig", "historic_village", ["Dervaig", "Isle_of_Mull"]),
            p("MacCulloch's Fossil Tree", "historic_building", ["MacCulloch's_fossil_tree", "Ardtun"]),
            p("Loch Frisa", "lake", ["Loch_Frisa", "Isle_of_Mull"]),
            p("Mishnish Lochs", "nature_reserve", "Tobermory", description="Chain of moorland lochs and marshy ground inland from Tobermory, popular for wildlife watching.", address="Near Tobermory, Isle of Mull, Scotland"),
            p("Ardtun Fossils", "historic_building", ["Ardtun", "Isle_of_Mull"]),
            p("Isle of Ulva", "island", ["Ulva", "Isle_of_Mull"]),
        ],
    },
    {
        "region": "Argyll & the Isles",
        "prefecture": "Argyll and Bute",
        "city": "Tarbert",
        "tier": "minor",
        "station": "Tarbert Ferry Terminal",
        "places": [
            p("Tarbert Harbour", "harbour", "Tarbert,_Kintyre", description="Sheltered working harbour at the heart of Tarbert, central to the village's sailing and fishing identity.", address="Harbour Street, Tarbert PA29 6UD"),
            p("Tarbert Castle", "castle", ["Tarbert_Castle", "Tarbert,_Kintyre"]),
            p("East Loch Tarbert", "viewpoint", "East_Loch_Tarbert,_Argyll"),
            p("West Loch Tarbert", "viewpoint", "West_Loch_Tarbert,_Argyll"),
            p("White Shore", "beach", "Tarbert,_Kintyre", description="Pleasant shoreline and picnic area just outside Tarbert with wide sea views.", address="White Shore, near Tarbert, Scotland"),
            p("Stonefield Castle", "castle", ["Stonefield_Castle", "Tarbert,_Kintyre"]),
            p("Skipness Castle", "castle", ["Skipness_Castle", "Skipness"]),
            p("Skipness Chapel", "abbey", "Skipness"),
            p("Barmore Island", "viewpoint", "Tarbert,_Kintyre", description="Tidal island and local viewpoint just off Tarbert's shoreline.", address="Tarbert, Argyll and Bute, Scotland"),
            p("Ardpatrick Point", "viewpoint", "Kintyre", description="Headland viewpoint with open views over Loch Fyne and the Kilbrannan Sound area.", address="Ardpatrick, Kintyre, Scotland"),
            p("Kennacraig Ferry Terminal", "harbour", ["Kennacraig", "Tarbert,_Kintyre"]),
            p("Claonaig Ferry Terminal", "harbour", ["Claonaig", "Tarbert,_Kintyre"]),
            p("Kintyre Way", "trail", "Kintyre_Way"),
            p("Tarbert Golf Club", "golf_course", "Tarbert,_Kintyre", description="Scenic golf course overlooking West Loch Tarbert and the surrounding hills.", address="Tarbert, Argyll and Bute, Scotland"),
            p("Kilbrannan Sound Viewpoint", "viewpoint", "Kilbrannan_Sound", description="Sea viewpoint looking towards Arran and the waters between Kintyre and the island.", address="Near Tarbert, Kintyre, Scotland"),
        ],
    },
    {
        "region": "Argyll & the Isles",
        "prefecture": "Argyll and Bute",
        "city": "Helensburgh",
        "tier": "minor",
        "station": "Helensburgh Central",
        "places": [
            p("The Hill House", "historic_building", ["The_Hill_House", "Helensburgh"]),
            p("Henry Bell Monument", "historic_building", ["Henry_Bell", "Helensburgh"], description="Monument honouring the steamship pioneer associated with Helensburgh and the Comet.", address="Helensburgh waterfront, Scotland"),
            p("Helensburgh Pier", "harbour", "Helensburgh", description="Historic pier on the Clyde shoreline, once central to the town's 'doon the watter' holiday trade.", address="Helensburgh seafront, Scotland"),
            p("West Bay Esplanade", "beach", "Helensburgh", description="Broad promenade and shore with open views across the Firth of Clyde.", address="West Bay, Helensburgh, Scotland"),
            p("Hermitage Park", "park", "Helensburgh", description="Central public park with gardens, sports areas and a pavilion.", address="Hermitage Park, Helensburgh G84 8UE"),
            p("Geilston Garden", "garden", ["Geilston_Garden", "Helensburgh"]),
            p("Ardencaple Castle", "castle", ["Ardencaple_Castle", "Helensburgh"]),
            p("Rhu Marina", "harbour", ["Rhu", "Helensburgh"], address="Rhu Marina, Rhu G84 8LH"),
            p("Glenarn Gardens", "garden", ["Rhu", "Helensburgh"], description="Lovely hillside woodland garden near Rhu with rhododendrons, azaleas and Clyde views.", address="Rhu, Argyll and Bute, Scotland"),
            p("Duchess Woods", "park", "Helensburgh", description="Woodland reserve on the eastern side of town with quiet trails and spring flowers.", address="Duchess Woods, Helensburgh, Scotland"),
            p("John Muir Way", "trail", "John_Muir_Way"),
            p("Mackintosh Club", "historic_building", "Helensburgh", description="Charles Rennie Mackintosh-linked building in the town centre, complementing a Hill House visit.", address="6 Sinclair Street, Helensburgh G84 8SU"),
            p("St Michael and All Angels Church", "church", "Helensburgh", description="Prominent town church with a landmark spire in Helensburgh's gridded centre.", address="William Street, Helensburgh G84 8BD"),
            p("Gare Loch", "viewpoint", "Gare_Loch"),
            p("Kilcreggan Pier", "harbour", "Kilcreggan"),
        ],
    },
    {
        "region": "Argyll & the Isles",
        "prefecture": "Argyll and Bute",
        "city": "Iona",
        "tier": "mid",
        "station": "Iona Pier",
        "places": [
            p("Iona Abbey", "abbey", "Iona_Abbey"),
            p("St Oran's Chapel", "church", ["St_Oran's_Chapel", "Iona_Abbey"]),
            p("Reilig Odhrain", "historic_building", "Iona_Abbey", description="Ancient burial ground beside the abbey, traditionally linked with early Scottish and Norse kings.", address="Iona Abbey, Isle of Iona, Scotland"),
            p("Iona Nunnery", "abbey", "Iona_Nunnery"),
            p("Iona Heritage Centre", "museum", "Iona", description="Local heritage centre interpreting the island's Christian, cultural and community history.", address="Baile Mòr, Iona PA76 6SQ"),
            p("St Martin's Cross", "historic_building", "Iona_Abbey", description="Celebrated early medieval high cross standing in the abbey precinct and associated with Iona's monastic golden age.", address="Iona Abbey, Isle of Iona, Scotland"),
            p("St John's Cross", "historic_building", "Iona_Abbey", description="Famous carved high cross known today from a replica on site and the original preserved in the abbey museum.", address="Iona Abbey, Isle of Iona, Scotland"),
            p("Abbey Museum", "museum", "Iona_Abbey", description="Small museum displaying carved stones and artefacts from Iona's early Christian past.", address="Iona Abbey, Isle of Iona, Scotland"),
            p("Martyrs' Bay", "beach", "Iona", description="Beautiful sheltered bay with pale sand and views across the Sound of Iona.", address="Martyrs' Bay, Iona, Scotland"),
            p("Port Ban Beach", "beach", "Iona", description="White-sand beach at the north end of Iona, ideal for quiet walks and sea views.", address="Port Bàn, Iona, Scotland"),
            p("St Columba's Bay", "beach", "Iona", description="Pebble-and-sand bay on Iona's south coast, traditionally linked to Columba's landing.", address="South Iona, Scotland"),
            p("The Machair", "nature_reserve", "Iona", description="Flower-rich coastal grassland that helps give Iona its distinctive open and windswept beauty.", address="Iona, Argyll and Bute, Scotland"),
            p("Dùn Mòr", "viewpoint", "Iona", description="Hilltop viewpoint with commanding views across the island, the Sound of Iona and Mull.", address="Dùn Mòr, Iona, Scotland"),
            p("Torr an Aba", "viewpoint", "Iona_Abbey", description="Low mound in the abbey grounds associated with St Columba's writing and contemplation.", address="Iona Abbey, Isle of Iona, Scotland"),
            p("Port na Curaich", "beach", "Iona", description="Small cove traditionally connected with St Columba's arrival on the island.", address="West side of Iona, Scotland"),
            p("Iona Marble Quarry", "historic_building", "Iona", description="Historic quarry area associated with the island's distinctive green marble.", address="Iona, Argyll and Bute, Scotland"),
            p("Baile Mòr", "historic_village", "Iona"),
            p("Iona Parish Church", "church", "Iona", description="Parish church serving the small island community in Baile Mòr.", address="Baile Mòr, Iona, Scotland"),
            p("Cnoc a' Chalmain", "viewpoint", "Iona", description="Gentle hill and viewpoint giving excellent perspectives over Iona's crofts and coastline.", address="Iona, Argyll and Bute, Scotland"),
            p("Sound of Iona", "viewpoint", "Sound_of_Iona"),
            p("North End Beaches", "beach", "Iona", description="Series of glorious white-sand beaches and dunes at the island's quieter northern end.", address="North Iona, Scotland"),
            p("Cnoc Oran Viewpoint", "viewpoint", "Iona", description="Small rise with rewarding views across the abbey and out over the sea to Mull.", address="Near Iona Abbey, Scotland"),
            p("Sròn an t-Sailein", "viewpoint", "Iona", description="Coastal headland walk offering open Atlantic panoramas and a wilder side of Iona.", address="Iona, Argyll and Bute, Scotland"),
            p("Iona Pier", "harbour", "Iona", description="Arrival point for foot passengers from Fionnphort and the island's main transport hub.", address="Iona Pier, Isle of Iona, Scotland"),
            p("Camas Cuil an t-Saimh", "beach", "Iona", description="Quiet sandy bay on Iona's west side, valued for solitude and sea views.", address="Iona, Argyll and Bute, Scotland"),
        ],
    },
    {
        "region": "Argyll & the Isles",
        "prefecture": "Argyll and Bute",
        "city": "Mull",
        "tier": "mid",
        "station": "Craignure Ferry Terminal",
        "places": [
            p("Duart Castle", "castle", ["Duart_Castle", "Isle_of_Mull"]),
            p("Torosay Castle", "castle", ["Torosay_Castle", "Isle_of_Mull"]),
            p("Calgary Bay", "beach", ["Calgary_Bay", "Isle_of_Mull"]),
            p("Isle of Staffa", "island", ["Staffa", "Isle_of_Mull"]),
            p("Fingal's Cave", "viewpoint", ["Fingal's_Cave", "Staffa"]),
            p("Glengorm Castle", "castle", ["Glengorm_Castle", "Isle_of_Mull"]),
            p("Loch na Keal", "nature_reserve", "Loch_Na_Keal"),
            p("Ben More", "mountain", ["Ben_More_(Mull)", "Isle_of_Mull"]),
            p("Carsaig Arches", "viewpoint", ["Carsaig_Arches", "Ross_of_Mull"]),
            p("Malcolm's Point", "viewpoint", "Isle_of_Mull", description="Remote western point on Mull known for big skies, sea views and frequent whale-watching prospects.", address="West Mull, Scotland"),
            p("Lochbuie Stone Circle", "historic_building", ["Lochbuie_Stone_Circle", "Lochbuie"]),
            p("Loch Buie", "lake", "Lochbuie"),
            p("Eas Fors", "viewpoint", ["Eas_Fors", "Isle_of_Mull"]),
            p("Moy Castle", "castle", ["Moy_Castle", "Lochbuie"]),
            p("Ardtun Fossils", "historic_building", ["Ardtun", "Isle_of_Mull"]),
            p("Treshnish Isles", "island", ["Treshnish_Isles", "Isle_of_Mull"]),
            p("Erraid", "island", ["Erraid", "Ross_of_Mull"]),
            p("Fionnphort", "harbour", ["Fionnphort", "Ross_of_Mull"]),
            p("Uisken Beach", "beach", "Ross_of_Mull", description="Beautiful shell-sand beach on Mull's south-western peninsula with open Atlantic views.", address="Near Bunessan, Isle of Mull, Scotland"),
            p("Knockvologan Beach", "beach", "Ross_of_Mull", description="Large sandy beach near the Ross of Mull with turquoise water on bright days.", address="Ross of Mull, Isle of Mull, Scotland"),
            p("Ardalanish Bay", "beach", "Ross_of_Mull", description="Long sandy bay backed by dunes and grazing land on the Ross of Mull.", address="Ardalanish, Isle of Mull, Scotland"),
            p("Ross of Mull", "viewpoint", "Ross_of_Mull"),
            p("MacCulloch's Fossil Tree", "historic_building", ["MacCulloch's_fossil_tree", "Ardtun"]),
            p("Shiaba Village Ruins", "historic_building", ["Shiaba", "Isle_of_Mull"]),
            p("Isle of Ulva", "island", ["Ulva", "Isle_of_Mull"]),
        ],
    },
    {
        "region": "Fife",
        "prefecture": "Fife",
        "city": "St Andrews",
        "tier": "major",
        "station": "Leuchars",
        "places": [
            p("St Andrews Cathedral", "cathedral", "St_Andrews_Cathedral", address="The Pends, St Andrews KY16 9QL"),
            p("St Andrews Castle", "castle", "St_Andrews_Castle", address="The Scores, St Andrews KY16 9AR"),
            p("Old Course at St Andrews", "golf_course", "Old_Course_at_St_Andrews", address="Golf Place, St Andrews KY16 9JA"),
            p("R&A World Golf Museum", "museum", ["British_Golf_Museum", "Old_Course_at_St_Andrews"], address="Bruce Embankment, St Andrews KY16 9AB"),
            p("St Andrews Aquarium", "museum", "St_Andrews", description="Family-friendly aquarium beside the sea with penguins, seals and broad coastal views.", address="The Scores, St Andrews KY16 9AS"),
            p("The Scores", "viewpoint", "St_Andrews", description="Iconic clifftop street and promenade linking the castle and cathedral with sweeping views over the North Sea.", address="The Scores, St Andrews, Scotland"),
            p("West Sands Beach", "beach", "St_Andrews", description="Expansive sandy beach famous from Chariots of Fire and beloved for long walks beneath the golf links.", address="West Sands Road, St Andrews, Scotland"),
            p("East Sands", "beach", "St_Andrews", description="Town beach on the eastern side of St Andrews with easy access from the harbour and coastal path.", address="East Sands, St Andrews, Scotland"),
            p("St Andrews Botanic Garden", "garden", "St_Andrews_Botanic_Garden", address="Canongate, St Andrews KY16 8RT"),
            p("University of St Andrews", "historic_building", "University_of_St_Andrews"),
            p("St Salvator's Chapel", "church", "St_Salvator's_Chapel"),
            p("St Rule's Tower", "viewpoint", "St_Andrews_Cathedral", description="Tall medieval tower beside the cathedral ruins, climbed for classic views over St Andrews and the coast.", address="The Pends, St Andrews KY16 9QL"),
            p("St Andrews Museum", "museum", "St_Andrews_Museum"),
            p("St Andrews Harbour", "harbour", "St_Andrews", description="Historic harbour and pier area beneath the cathedral headland, popular for photos and coastal walks.", address="Harbour, St Andrews, Scotland"),
            p("St Andrews Preservation Trust Museum and Garden", "museum", "St_Andrews", description="Small local museum in a historic house with tranquil walled garden and displays on the town's past.", address="12 North Street, St Andrews KY16 9PW"),
            p("Blackfriars Chapel", "historic_building", "St_Andrews", description="Ruins of the former Dominican friary, preserving another strand of medieval St Andrews.", address="South Street, St Andrews, Scotland"),
            p("Bishop's Palace", "historic_building", ["St_Andrews_Cathedral", "St_Andrews"], description="Ruins beside the cathedral that once formed the residence of the bishops and archbishops of St Andrews.", address="The Pends, St Andrews KY16 9QL"),
            p("Martyrs' Monument", "historic_building", "St_Andrews", description="Hilltop memorial commemorating Protestant martyrs, with one of the best elevated views over the town.", address="The Scores, St Andrews, Scotland"),
            p("Wardlaw Museum", "museum", "University_of_St_Andrews", description="Contemporary university museum presenting collections from science, art and global culture.", address="7 The Scores, St Andrews KY16 9AR"),
            p("Holy Trinity Church", "church", ["Holy_Trinity_Church,_St_Andrews", "St_Andrews"]),
            p("Craigtoun Country Park", "park", "Craigtoun_Country_Park"),
            p("Balgove Course", "golf_course", ["Old_Course_at_St_Andrews", "St_Andrews"], description="Compact St Andrews Links course well suited to families and shorter rounds.", address="St Andrews Links, St Andrews, Scotland"),
            p("New Course", "golf_course", ["Old_Course_at_St_Andrews", "St_Andrews"], description="Historic championship links laid out in 1895 beside the world-famous Old Course.", address="St Andrews Links, St Andrews, Scotland"),
            p("Jubilee Course", "golf_course", ["Old_Course_at_St_Andrews", "St_Andrews"], description="Classic coastal links known as one of the most challenging public courses at St Andrews.", address="St Andrews Links, St Andrews, Scotland"),
            p("Castle Course", "golf_course", "St_Andrews", description="Dramatic clifftop course south of town with panoramic sea views from nearly every hole.", address="Kinkell Braes, St Andrews KY16 8PL"),
            p("Kingsbarns Golf Links", "golf_course", ["Kingsbarns_Golf_Links", "Kingsbarns"]),
            p("Scotland's Secret Bunker", "museum", "Scotland's_Secret_Bunker", address="Crown Buildings, Troywood, St Andrews KY16 8QH"),
            p("Fife Coastal Path", "trail", "Fife_Coastal_Path", description="Long-distance coastal trail whose St Andrews section links beaches, dunes, harbour and clifftop walks.", address="St Andrews shoreline, Scotland"),
            p("Lade Braes Walk", "trail", "St_Andrews", description="Leafy burnside walk from the town centre towards Craigtoun, popular with locals and visitors alike.", address="Lade Braes, St Andrews, Scotland"),
            p("St Leonard's Chapel", "church", "University_of_St_Andrews", description="Historic chapel within the former St Leonard's College precinct.", address="St Leonards, St Andrews, Scotland"),
            p("West Sands Dunes", "nature_reserve", "St_Andrews", description="Rolling dune landscape behind West Sands, rich in coastal atmosphere and migratory birdlife.", address="West Sands, St Andrews, Scotland"),
            p("Kingsbarns Distillery", "distillery", "Kingsbarns_Distillery"),
            p("Cambo Gardens", "garden", ["Cambo_House", "Kingsbarns"]),
            p("Kingsbarns Beach", "beach", "Kingsbarns"),
            p("Tentsmuir National Nature Reserve", "nature_reserve", "Tentsmuir_National_Nature_Reserve"),
            p("Tentsmuir Sands", "beach", "Tentsmuir"),
            p("Dunino Den", "nature_reserve", "Dunino"),
            p("St Mary's College Quad", "historic_building", "University_of_St_Andrews", description="Atmospheric university courtyard reflecting the collegiate heart of St Andrews.", address="South Street, St Andrews KY16 9JU"),
            p("Sallies Quad", "historic_building", "University_of_St_Andrews", description="Historic quadrangle around St Salvator's Chapel, one of the defining spaces of the university town.", address="North Street, St Andrews, Scotland"),
            p("Swilcan Bridge", "historic_building", "Swilcan_Bridge"),
        ],
    },
    {
        "region": "Fife",
        "prefecture": "Fife",
        "city": "Dunfermline",
        "tier": "mid",
        "station": "Dunfermline City",
        "places": [
            p("Dunfermline Abbey", "abbey", "Dunfermline_Abbey"),
            p("Dunfermline Palace", "historic_building", "Dunfermline_Palace"),
            p("Andrew Carnegie Birthplace Museum", "museum", "Andrew_Carnegie_Birthplace_Museum"),
            p("Pittencrieff Park", "park", "Pittencrieff_Park"),
            p("Pittencrieff House Museum", "museum", "Pittencrieff_Park", description="Museum in the historic laird's house at the heart of Pittencrieff Park, covering local and natural history.", address="Pittencrieff Park, Dunfermline KY12 8QH"),
            p("Carnegie Library", "historic_building", "Carnegie_Library_of_Dunfermline"),
            p("Dunfermline City Chambers", "historic_building", "Dunfermline_City_Chambers"),
            p("Abbot House Heritage Centre", "museum", "Abbot_House"),
            p("Dunfermline Museum and Art Gallery", "museum", "Dunfermline", description="Museum collections and civic displays interpreting the city's royal and industrial past.", address="Dunfermline, Fife, Scotland"),
            p("Dunfermline Carnegie Library & Galleries", "museum", "Carnegie_Library_of_Dunfermline", description="Award-winning combined library, museum and gallery venue in Dunfermline's heritage quarter.", address="1-7 Abbot Street, Dunfermline KY12 7NL"),
            p("St Margaret's Cave", "historic_building", "Dunfermline", description="Rock-cut cave traditionally associated with Queen Margaret's private devotions.", address="St Margaret Street, Dunfermline KY12 7PE"),
            p("Alhambra Theatre", "historic_building", "Alhambra_Theatre,_Dunfermline"),
            p("Carnegie Hall", "historic_building", ["Carnegie_Hall,_Dunfermline", "Dunfermline"]),
            p("St Leonard's Bastion", "historic_building", "Dunfermline_Palace", description="Surviving fragment of Dunfermline's medieval defensive works near the palace and abbey precinct.", address="Dunfermline heritage quarter, Scotland"),
            p("Townhill Country Park", "park", ["Townhill_Country_Park", "Townhill,_Fife"]),
            p("Townhill Loch", "lake", "Townhill,_Fife"),
            p("Calais Muir Woods", "nature_reserve", "Dunfermline", description="Local woodland on the edge of the city offering easy walking and wildlife spotting.", address="Calais Muir, Dunfermline, Scotland"),
            p("King Robert the Bruce's Tomb", "historic_building", "Dunfermline_Abbey", description="The burial site of Robert the Bruce within Dunfermline Abbey, one of Scotland's most resonant royal monuments.", address="Dunfermline Abbey, St Margaret Street, Dunfermline"),
            p("Malcolm Canmore's Tower", "historic_building", "Dunfermline", description="Site associated by tradition with Malcolm III and Margaret on a wooded hill above the city centre.", address="Pittencrieff Park, Dunfermline, Scotland"),
            p("Fife Pilgrim Way", "trail", "Fife_Pilgrim_Way"),
            p("Abbot House Gardens", "garden", "Abbot_House", description="Walled gardens beside Abbot House offering a peaceful break in the heritage quarter.", address="Maygate, Dunfermline KY12 7NE"),
            p("St Margaret's Memorial Church", "church", "St_Margaret's_Memorial_Church"),
            p("Charlestown Harbour", "harbour", "Charlestown,_Fife"),
            p("Public Park and Glen", "park", "Pittencrieff_Park", description="The glen and open lawns gifted by Carnegie remain Dunfermline's favourite urban green space.", address="Pittencrieff Park, Dunfermline, Scotland"),
            p("Broomhall House", "historic_building", "Broomhall_House"),
        ],
    },
    {
        "region": "Fife",
        "prefecture": "Fife",
        "city": "Kirkcaldy",
        "tier": "mid",
        "station": "Kirkcaldy",
        "places": [
            p("Kirkcaldy Galleries", "museum", "Kirkcaldy_Galleries"),
            p("Ravenscraig Castle", "castle", "Ravenscraig_Castle"),
            p("Kirkcaldy Waterfront", "viewpoint", "Kirkcaldy", description="Long seafront stretch along the Firth of Forth with promenades, beaches and sweeping views south.", address="The Esplanade, Kirkcaldy, Scotland"),
            p("Adam Smith Theatre", "historic_building", "Kirkcaldy", description="The town's principal theatre and performance venue, named for Kirkcaldy's most famous son.", address="Bennochy Road, Kirkcaldy KY1 1ET"),
            p("Beveridge Park", "park", "Beveridge_Park"),
            p("Dysart Harbour", "harbour", "Dysart,_Fife", description="Beautifully preserved historic harbour known for its appearance in television drama and maritime heritage.", address="Dysart Harbour, Kirkcaldy KY1 2TQ"),
            p("Dysart Village", "historic_village", "Dysart,_Fife"),
            p("Pathhead Sands", "beach", "Kirkcaldy", description="Popular urban beach with a broad sweep of sand and promenade access.", address="Pathhead, Kirkcaldy, Scotland"),
            p("Kirkcaldy Links Market", "historic_building", "Links_Market", description="Europe's longest street fair when in town, and a long-established part of Kirkcaldy's identity.", address="Kirkcaldy Esplanade, Scotland"),
            p("Sailors' Walk", "historic_building", "Kirkcaldy", description="Important surviving row of early burgh houses on the historic waterfront.", address="Sailors' Walk, Kirkcaldy KY1 1NW"),
            p("Ravenscraig Park", "park", "Ravenscraig_Castle", description="Clifftop and shoreline parkland around Ravenscraig Castle with excellent sea views.", address="Ravenscraig Park, Kirkcaldy, Scotland"),
            p("Seafield Tower", "historic_building", "Seafield_Tower"),
            p("Wemyss Caves", "historic_building", "Wemyss_Caves"),
            p("East Wemyss Caves", "historic_building", "East_Wemyss", description="Coastal caves noted for rare Pictish carvings and folklore along the Fife shore.", address="East Wemyss, Fife, Scotland"),
            p("Fife Coastal Path", "trail", "Fife_Coastal_Path", description="Kirkcaldy's section of the coastal path links beaches, harbours and cliff-top views.", address="Kirkcaldy shoreline, Scotland"),
            p("Adam Smith Memorial", "historic_building", ["Adam_Smith", "Kirkcaldy"], description="Town-centre memorial celebrating the economist and philosopher born in Kirkcaldy.", address="Kirkcaldy, Fife, Scotland"),
            p("Kirkcaldy Old Kirk", "church", "Kirkcaldy", description="Historic kirk linked with Adam Smith and the old burgh core.", address="Kirk Wynd, Kirkcaldy KY1 1EH"),
            p("St Bryce Kirk", "church", "Kirkcaldy", description="Striking ruined and rebuilt kirk whose tower remains a prominent Kirkcaldy landmark.", address="Kirkcaldy, Fife, Scotland"),
            p("War Memorial Gardens", "park", "Kirkcaldy", description="Formal gardens and civic memorial space close to the seafront.", address="Kirkcaldy Esplanade, Scotland"),
            p("Dunnikier Park", "park", "Dunnikier_Park"),
            p("Harbourmaster's House Dysart", "historic_building", "Dysart,_Fife", description="Historic harbour-side building enhancing Dysart's preserved maritime character.", address="Dysart Harbour, Kirkcaldy, Scotland"),
            p("Merchant's Quarter", "historic_building", "Kirkcaldy", description="Historic town-centre streets that recall Kirkcaldy's merchant and manufacturing past.", address="Kirkcaldy town centre, Scotland"),
            p("Beveridge Park Rose Garden", "garden", "Beveridge_Park", description="Ornamental garden area within Beveridge Park, especially attractive in summer.", address="Beveridge Park, Kirkcaldy, Scotland"),
            p("Ravenscraig Beach", "beach", "Kirkcaldy", description="Rocky-and-sandy shore below Ravenscraig with broad Forth views.", address="Ravenscraig, Kirkcaldy, Scotland"),
            p("Forth View Promenade", "viewpoint", "Kirkcaldy", description="Easy seafront walk offering classic Firth of Forth panoramas.", address="Kirkcaldy Esplanade, Scotland"),
        ],
    },
    {
        "region": "Fife",
        "prefecture": "Fife",
        "city": "Culross",
        "tier": "mid",
        "station": "Dunfermline City",
        "places": [
            p("Culross Palace", "historic_building", "Culross_Palace"),
            p("The Study", "historic_building", "Culross_Palace", description="Charming National Trust property in Culross used to interpret the village's domestic past.", address="Culross, Fife, Scotland"),
            p("Town House, Culross", "historic_building", "Culross", description="Distinctive civic building at the top of the village's steep cobbled streets.", address="Mercat Cross, Culross KY12 8JH"),
            p("Culross Abbey", "abbey", "Culross_Abbey"),
            p("Bruce's Castle", "castle", "Culross", description="Ruined tower house on the edge of the village associated with the Bruce family.", address="Culross, Fife, Scotland"),
            p("Mercat Cross", "historic_building", "Culross", description="Traditional burgh focal point at the heart of Culross's historic streetscape.", address="Mercat Cross, Culross, Scotland"),
            p("West Kirk of Culross", "church", "Culross", description="Atmospheric ruin and burial ground that predates Culross Abbey as the parish centre.", address="West Kirk, Culross, Scotland"),
            p("Back Causeway", "historic_building", "Culross", description="Steep, cobbled lane lined with whitewashed buildings and one of the village's signature views.", address="Back Causeway, Culross, Scotland"),
            p("Culross Village Streets", "historic_village", "Culross"),
            p("The Heiches", "garden", "Culross", description="Terraced hillside gardens and orchards rising above the palace.", address="The Heiches, Culross, Scotland"),
            p("The Tanhouse Brae", "historic_building", "Culross", description="Another of Culross's picturesque steep lanes linking the shore to the upper burgh.", address="Tanhouse Brae, Culross, Scotland"),
            p("Culross Harbour", "harbour", "Culross", description="Former trading harbour on the Forth, now a peaceful shoreline stop below the historic village.", address="Culross Harbour, Fife, Scotland"),
            p("Dunimarle Castle", "castle", "Dunimarle_Castle"),
            p("Dunimarle Mausoleum", "historic_building", "Dunimarle_Castle", description="Gothic mausoleum within the wider Dunimarle estate grounds.", address="Dunimarle Estate, near Culross, Scotland"),
            p("Preston Island Industrial Heritage", "museum", "Preston_Island"),
            p("Valleyfield Woodland Park", "park", ["Valleyfield,_Fife", "Culross"], description="Local woodland park near Culross with open paths and estuary views.", address="Valleyfield, Fife, Scotland"),
            p("Low Valleyfield Harbour", "harbour", "Low_Valleyfield"),
            p("Forth Shore at Culross", "viewpoint", "Culross", description="Estuary shoreline with broad mudflat, shipping and bridge views below the burgh.", address="Culross shore, Fife, Scotland"),
            p("Culross Abbey Churchyard", "historic_building", "Culross_Abbey", description="Historic churchyard surrounding the abbey and rich in local memorials.", address="Culross Abbey, Culross, Scotland"),
            p("Red Roofs Viewpoint", "viewpoint", "Culross", description="Classic elevated view over Culross's red pantiled roofs and the Firth of Forth.", address="Culross, Fife, Scotland"),
            p("Culross Town House Gallery", "gallery", "Culross", description="Exhibition space within the historic civic building, often featuring local art and interpretation.", address="Town House, Culross, Scotland"),
            p("Saint Serf's Legacy Trail", "trail", "Culross", description="Self-guided wander through places tied to Culross's saintly origins and medieval story.", address="Culross, Fife, Scotland"),
            p("Culross Pier and Shore Walk", "trail", "Culross", description="Easy shore walk joining the old harbour, estuary edge and village viewpoints.", address="Culross harbour, Scotland"),
            p("Culross Medieval Wynds", "historic_building", "Culross", description="Narrow lanes and closes that make Culross one of Scotland's best preserved historic burghs.", address="Culross, Fife, Scotland"),
            p("Dunimarle Estate Grounds", "park", "Dunimarle_Castle", description="Wooded grounds and lawns surrounding the mansion house west of Culross.", address="Dunimarle Estate, Culross, Scotland"),
        ],
    },
    {
        "region": "Fife",
        "prefecture": "Fife",
        "city": "East Neuk of Fife",
        "tier": "mid",
        "station": "Leuchars",
        "places": [
            p("Crail Harbour", "harbour", "Crail", description="Beautiful old fishing harbour tucked beneath Crail's burgh streets and sea walls.", address="Crail Harbour, Crail KY10 3SU"),
            p("Crail Museum and Heritage Centre", "museum", "Crail", description="Volunteer-run museum covering Crail's fishing, military and social history.", address="62 Marketgate North, Crail KY10 3TL"),
            p("Crail Pottery", "gallery", "Crail", description="Long-established craft pottery and gallery known for decorative ceramics inspired by the coast.", address="Marketgate, Crail, Scotland"),
            p("Crail Parish Church", "church", "Crail"),
            p("Anstruther Harbour", "harbour", "Anstruther", description="Working harbour and yachting base at the heart of one of the East Neuk's busiest villages.", address="Anstruther Harbour, Fife, Scotland"),
            p("Scottish Fisheries Museum", "museum", "Scottish_Fisheries_Museum"),
            p("Cellardyke Harbour", "harbour", "Cellardyke"),
            p("Pittenweem Harbour", "harbour", "Pittenweem", description="Compact harbour backed by one of the East Neuk's most atmospheric fishing villages.", address="Pittenweem Harbour, Fife, Scotland"),
            p("Pittenweem Priory", "historic_building", "Pittenweem_Priory"),
            p("Pittenweem Arts Festival", "gallery", "Pittenweem_Arts_Festival"),
            p("St Monans Windmill", "historic_building", "St_Monans_Windmill"),
            p("St Monans Church", "church", "St_Monans"),
            p("St Monans Harbour", "harbour", "St_Monans", description="Photogenic harbour ringed by tidal walls, one of the East Neuk's finest coastal scenes.", address="St Monans Harbour, Fife, Scotland"),
            p("Elie Chain Walk", "viewpoint", "Elie_Chain_Walk"),
            p("Elie Beach", "beach", "Elie", address="Ruby Bay, Elie, Fife, Scotland"),
            p("Earlsferry Harbour", "harbour", "Earlsferry"),
            p("Kellie Castle", "castle", "Kellie_Castle"),
            p("Balcarres House", "historic_building", "Balcarres_House"),
            p("Fife Coastal Path", "trail", "Fife_Coastal_Path", description="One of Scotland's best coastal trails, especially rewarding through the East Neuk's linked fishing villages.", address="East Neuk coastline, Fife, Scotland"),
            p("Isle of May", "island", "Isle_of_May"),
            p("Elie Ness Lighthouse", "lighthouse", "Elie_Ness_Lighthouse"),
            p("Lady's Tower", "historic_building", ["Elie", "Earlsferry"], description="Small tower on the shore at Elie, famous for its eccentric 18th-century bathing history.", address="Elie Ness, Fife, Scotland"),
            p("Kingsbarns Distillery", "distillery", "Kingsbarns_Distillery"),
            p("Cambo Gardens", "garden", ["Cambo_House", "Kingsbarns"]),
            p("Newark Castle, St Monans", "castle", "Newark_Castle,_St_Monans"),
        ],
    },
    {
        "region": "Fife",
        "prefecture": "Fife",
        "city": "Glenrothes",
        "tier": "minor",
        "station": "Markinch",
        "places": [
            p("Balfarg Henge", "historic_building", "Balfarg_Henge"),
            p("Riverside Park", "park", "Glenrothes", description="Large riverside park with walking paths, play areas and woodland on the town's western side.", address="Riverside Park, Glenrothes, Scotland"),
            p("Glenrothes Public Art Trail", "gallery", "Glenrothes", description="The new town is known for its public art, from large sculptures to murals and civic pieces.", address="Glenrothes town centre, Scotland"),
            p("Balbirnie House", "historic_building", "Balbirnie_House"),
            p("Balbirnie Park", "park", "Balbirnie_House", description="Landscape park around Balbirnie House with woodland walks and golf nearby.", address="Balbirnie Park, Markinch, Fife"),
            p("Leslie House", "historic_building", "Leslie_House"),
            p("Balgonie Castle", "castle", "Balgonie_Castle"),
            p("Lomond Hills Regional Park", "park", "Lomond_Hills"),
            p("Formonthills Park", "park", "Glenrothes", description="Open parkland and play space on the southern side of Glenrothes.", address="Formonthills Park, Glenrothes, Scotland"),
            p("Gilvenbank Park", "park", "Glenrothes", description="Neighbourhood park and green corridor within the planned new town.", address="Gilvenbank Park, Glenrothes, Scotland"),
            p("Markinch Parish Church", "church", "Markinch"),
            p("Fife Pilgrim Way", "trail", "Fife_Pilgrim_Way"),
            p("Falkland Palace", "castle", "Falkland_Palace"),
            p("Falkland Estate", "park", "Falkland,_Fife"),
            p("Balgeddie House", "historic_building", "Glenrothes", description="Country-house style landmark now known as one of the area's best-known historic properties.", address="Balgeddie Way, Glenrothes KY6 3ET"),
        ],
    },
    {
        "region": "Fife",
        "prefecture": "Fife",
        "city": "Loch Leven",
        "tier": "minor",
        "station": None,
        "places": [
            p("Loch Leven Castle", "castle", ["Lochleven_Castle", "Loch_Leven_(Perth_and_Kinross)"], lat=56.2009, lng=-3.3727, address="Castle Island, Loch Leven, Kinross, Scotland"),
            p("RSPB Loch Leven", "nature_reserve", "Loch_Leven_(Perth_and_Kinross)", description="Major wetland reserve famed for wintering geese, waterfowl and easy lochside walks.", address="Kinross, Perth and Kinross KY13 9LX"),
            p("Vane Farm Nature Reserve", "nature_reserve", "Loch_Leven_(Perth_and_Kinross)", description="Reserve area on the loch's shore with hides, paths and excellent birdwatching.", address="Near Kinross, Perth and Kinross, Scotland"),
            p("Kinross House", "historic_building", "Kinross_House"),
            p("Kinross Pier", "harbour", "Kinross", description="Main departure point for boat trips to Loch Leven Castle and a pleasant lochside promenade spot.", address="Pier Road, Kinross, Scotland"),
            p("Burleigh Castle", "castle", "Burleigh_Castle"),
            p("Benarty Hill", "viewpoint", "Benarty_Hill"),
            p("Bishop Hill", "viewpoint", "Bishop_Hill"),
            p("Milnathort Village", "historic_village", "Milnathort"),
            p("Loch Leven Heritage Trail", "trail", "Loch_Leven_(Perth_and_Kinross)", description="Circular route around the loch linking reserves, heritage sites and viewpoints.", address="Loch Leven, Perth and Kinross, Scotland"),
            p("Portmoak Church", "church", "Portmoak"),
            p("Burleigh Sands Viewpoint", "viewpoint", "Loch_Leven_(Perth_and_Kinross)", description="Shoreline viewpoint with broad views over the loch towards the Lomond and Cleish hills.", address="Loch Leven shoreline, Scotland"),
            p("Cleish Hills", "viewpoint", "Cleish_Hills"),
            p("St Serf's Island Viewpoint", "viewpoint", "St_Serf's_Island", description="Viewpoint towards the loch's historic island, long associated with early Christianity.", address="Loch Leven, Scotland"),
            p("Kinross Museum", "museum", "Kinross", description="Local displays interpreting Kinross-shire and Loch Leven's history.", address="Kinross, Perth and Kinross, Scotland"),
        ],
    },
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    existing = {path.name for path in OUT_DIR.glob("*.json")}
    timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")

    summary: list[tuple[str, str, int]] = []
    for city in CITIES:
        filename = f"{nk(city['city'])}.json"
        out_path = OUT_DIR / filename
        if filename in existing:
            summary.append((city["city"], "skipped", 0))
            continue
        records = [build_record(city, place, timestamp, idx) for idx, place in enumerate(city["places"])]
        with out_path.open("w", encoding="utf-8") as fh:
            json.dump({"records": records}, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        summary.append((city["city"], "written", len(records)))

    for city_name, status, count in summary:
        if status == "written":
            print(f"{city_name}: {count} records written")
        else:
            print(f"{city_name}: skipped")


if __name__ == "__main__":
    main()
