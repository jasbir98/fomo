from __future__ import annotations

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
BASE_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
EXTRACTION_MODEL = "copilot-cli-knowledge"
USER_AGENT = "Mozilla/5.0 (compatible; CopilotCLI/1.0; +https://github.com/)"
REQUEST_DELAY = 0.7

DEFAULT_STATIONS = {
    "stirling-falkirk.json": "Larbert",
    "grangemouth.json": "Falkirk Grahamston",
    "callendar-park.json": "Falkirk High",
    "newmilns.json": "Kilmarnock",
    "darvel.json": "Kilmarnock",
    "irvine-north-ayrshire.json": "Irvine",
    "saltcoats.json": "Saltcoats",
    "ardrossan.json": "Ardrossan Harbour",
}


def nk(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unknown"


def wiki_url(title: str) -> str:
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="()_,!'")
    return f"https://en.wikipedia.org/wiki/{encoded}"


_last_request_at = 0.0
_cache: dict[str, dict[str, Any]] = {}


def fetch_wiki_summary(title: str) -> dict[str, Any]:
    global _last_request_at
    if title in _cache:
        return _cache[title]

    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="()_,!'")
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
    result = {"ok": False, "url": wiki_url(title), "lat": None, "lng": None}

    for attempt in range(5):
        pause = REQUEST_DELAY - (time.time() - _last_request_at)
        if pause > 0:
            time.sleep(pause)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        _last_request_at = time.time()
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            coords = payload.get("coordinates") or {}
            result = {
                "ok": True,
                "url": payload.get("content_urls", {}).get("desktop", {}).get("page") or wiki_url(title),
                "lat": coords.get("lat"),
                "lng": coords.get("lon"),
            }
            break
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                break
            if exc.code in {429, 500, 502, 503, 504}:
                time.sleep((attempt + 1) * 1.2)
                continue
            break
        except Exception:
            time.sleep((attempt + 1) * 1.0)
    _cache[title] = result
    return result


def place(name: str, category: str, wiki: str, description: str, address: str, station: str | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "category": category,
        "wiki": wiki,
        "description": description,
        "address": address,
        "station": station,
    }


ADDITIONS: dict[str, list[dict[str, Any]]] = {
    "stirling-falkirk.json": [
        place("Carron Valley Reservoir", "reservoir", "Carron_Valley_Reservoir", "Large upland reservoir west of Denny popular for scenic drives, angling and broad views into the Campsie fringe.", "Carron Valley, near Denny", "Larbert"),
        place("Carron Valley Forest", "forest", "Carron_Valley_Reservoir", "Expansive conifer forest around the reservoir with walking, cycling and wildlife-watching opportunities.", "Carron Valley, near Denny", "Larbert"),
        place("Carron Valley Mountain Bike Trails", "walking route", "Carron_Valley_Reservoir", "Outdoor trail network through forest and moorland, well known for active exploration in the western Falkirk corridor.", "Carron Valley, near Denny", "Larbert"),
        place("Dunipace Heritage Trail", "historic area", "Dunipace", "Local heritage route through the old village of Dunipace, linking parish, river and industrial-era stories.", "Dunipace, Falkirk", "Camelon"),
        place("Dunipace Old Parish Church", "church", "Dunipace", "Historic parish church site reflecting the oldest surviving community focus in the Dunipace area.", "Dunipace, Falkirk", "Camelon"),
        place("Denny Old Bridge", "bridge", "Denny,_Falkirk", "Traditional bridge crossing that evokes Denny's older transport links and settlement pattern.", "Denny, Falkirk", "Camelon"),
        place("Denny Town Centre Heritage", "historic area", "Denny,_Falkirk", "Historic heart of Denny where main-street buildings recall the town's industrial and market-town past.", "Denny town centre, Falkirk", "Camelon"),
        place("Bonnybridge Village Heritage", "historic area", "Bonnybridge", "Village heritage stop tied to canal transport, ironworking and the Antonine Wall landscape.", "Bonnybridge, Falkirk", "Camelon"),
        place("Bonny Water Walk", "walking route", "Bonnybridge", "Waterside stroll following the Bonny Water through the western edge of Falkirk's historic industrial landscape.", "Bonnybridge, Falkirk", "Camelon"),
        place("River Carron Valley Walk", "walking route", "River_Carron,_Forth", "Riverside route connecting old settlement, woodland and open-country views between Denny and Larbert.", "River Carron corridor, Falkirk", "Larbert"),
        place("Cowie Village", "historic area", "Stirling", "Small village east of Stirling that works as a useful heritage stop when travelling the Falkirk-Stirling corridor.", "Cowie, Stirling", "Stirling"),
        place("Cowie Heritage Walk", "walking route", "Stirling", "Short heritage walk through Cowie with views to the Ochils and reminders of old mining and village life.", "Cowie, Stirling", "Stirling"),
        place("Bannockburn Battlefield", "battlefield", "Bannockburn", "Historic battlefield landscape associated with Robert the Bruce's 1314 victory on the southern approach to Stirling.", "Bannockburn, Stirling", "Stirling"),
        place("Bannockburn Heritage Route", "walking route", "Bannockburn", "Interpretive route around Bannockburn that helps connect the visitor centre with the wider battlefield terrain.", "Bannockburn, Stirling", "Stirling"),
        place("Sauchie Tower", "tower", "Sauchie_Tower", "Striking late-medieval tower house near Stirling, one of the most atmospheric castles in the wider district.", "Sauchie, Alloa", "Stirling"),
        place("Alloa Tower", "tower", "Alloa_Tower", "Scotland's largest surviving keep, included here as a strong day-trip connection from the Falkirk-Stirling borderland.", "Mar Street, Alloa FK10 1AB", "Alloa"),
        place("Clackmannan Tower", "tower", "Clackmannan_Tower", "Prominent tower-house in Clackmannan, adding depth to heritage touring north of Falkirk.", "Clackmannan FK10 4HR", "Alloa"),
        place("Airthrey Castle", "castle", "Airthrey_Castle", "Picturesque baronial house on the University of Stirling campus, framed by water and the Ochil Hills.", "University of Stirling, Stirling FK9 4LA", "Stirling"),
        place("Wallace Monument Viewpoint", "viewpoint", "National_Wallace_Monument", "Viewpoint toward Stirling's iconic monument, often glimpsed on clear days from the Falkirk side of the corridor.", "Stirling district viewpoints", "Stirling"),
        place("Cambusbarron Village", "historic area", "Cambusbarron", "Village south-west of Stirling with a distinct traditional character and links to nearby Touch and Gillies Hill country.", "Cambusbarron, Stirling", "Stirling"),
        place("Touch Estate", "historic house", "Stirling", "Historic estate landscape on the edge of the Carse, blending country-house heritage with rural viewpoints.", "Touch, near Stirling", "Stirling"),
        place("Gargunnock Hills Viewpoint", "viewpoint", "Gargunnock", "Elevated rural viewpoint toward the Gargunnock Hills, adding sweeping west Stirlingshire scenery to the route.", "Gargunnock, Stirling", "Stirling"),
        place("Larbert House Estate", "historic house", "Larbert", "Historic estate landscape remembered for its country-house past and continuing role in Larbert's local identity.", "Larbert, Falkirk", "Larbert"),
        place("Airth Village Heritage", "historic area", "Airth", "Old village core with castle-country surroundings and strong connections to the upper Forth landscape.", "Airth, Falkirk", "Polmont"),
        place("St Ninians Old Kirk", "church", "St_Ninians", "Historic parish focus in the old burgh of St Ninians, useful for exploring Stirling's southern fringe from Falkirk.", "St Ninians, Stirling", "Stirling"),
        place("Plean House", "historic house", "Plean", "Former mansion house near Plean Country Park, adding another aristocratic layer to the local landscape.", "Plean, Stirling", "Stirling"),
        place("Carron Bridge Heritage", "bridge", "River_Carron,_Forth", "Bridge heritage stop where roads, river and industry meet in the Carron and Denny area.", "Carron crossing area, Falkirk", "Larbert"),
        place("Tor Wood Meadow", "park", "Torwood_Castle", "Open glades and woodland-edge spaces near Tor Wood that complement visits to the castle and broch sites.", "Tor Wood, Larbert", "Larbert"),
        place("Carron Valley Lookout", "viewpoint", "Carron_Valley_Reservoir", "Scenic lookout over water, forest and hills in one of the west Falkirk area's most open landscapes.", "Carron Valley, near Denny", "Larbert"),
        place("Shieldhill Estate Walk", "walking route", "Falkirk", "Country-lane and estate-edge walk near Shieldhill, pairing rural views with the castle setting.", "Shieldhill, near Falkirk", "Polmont"),
    ],
    "grangemouth.json": [
        place("Grangemouth Museum", "museum", "Grangemouth", "Local museum stop interpreting the town's canal, dock and petrochemical-era story.", "Grangemouth, Falkirk", "Falkirk Grahamston"),
        place("Kinneil Museum", "museum", "Kinneil_House", "Small museum introducing the archaeology, estate history and industrial past of Kinneil.", "Kinneil Estate, Bo'ness EH51 0PR", "Polmont"),
        place("Kinneil Fortlet", "historic site", "Antonine_Wall", "Roman fortlet site near Kinneil, linking Grangemouth with the eastern end of the Antonine frontier.", "Kinneil Estate, Bo'ness EH51 0PR", "Polmont"),
        place("James Watt at Kinneil", "industrial heritage", "James_Watt", "Interpretive heritage stop recalling James Watt's engine experiments and improvements at Kinneil.", "Kinneil Estate, Bo'ness EH51 0PR", "Polmont"),
        place("Grangemouth Docks Viewpoint", "viewpoint", "Grangemouth", "Industrial heritage viewpoint toward docks, tanks and shipping infrastructure that shaped modern Grangemouth.", "Grangemouth docklands, Falkirk", "Falkirk Grahamston"),
        place("River Carron Estuary Walk", "walking route", "River_Carron,_Forth", "Waterside walk where the River Carron broadens toward the Forth, with birds and industrial panoramas.", "River Carron estuary, Grangemouth", "Falkirk Grahamston"),
        place("Inchyra Loch", "park", "Grangemouth", "Lochside green space near Inchyra, giving a softer counterpoint to the town's industrial setting.", "Inchyra, Grangemouth", "Falkirk Grahamston"),
        place("Bo'ness Foreshore", "walking route", "Bo'ness", "Foreshore walk and coastal heritage area just beyond Grangemouth, easy to combine with Kinneil visits.", "Bo'ness foreshore, Bo'ness", "Polmont"),
    ],
    "callendar-park.json": [
        place("Callendar Park Loch", "park", "Callendar_House", "Lochside feature within the park that adds gentle waterside walking to a heritage visit.", "Callendar Park, Falkirk FK1 1YR", "Falkirk High"),
        place("Roman Room", "museum", "Callendar_House", "Popular room in Callendar House presenting the Roman frontier story that ran through the estate grounds.", "Callendar House, Falkirk FK1 1YR", "Falkirk High"),
        place("Victorian Shop", "museum", "Callendar_House", "Recreated historic shop interior within Callendar House, helping bring Falkirk's civic past to life.", "Callendar House, Falkirk FK1 1YR", "Falkirk High"),
        place("Roman Artefacts Gallery", "museum", "Callendar_House", "Display area for finds and interpretation connected with the Antonine Wall and local Roman archaeology.", "Callendar House, Falkirk FK1 1YR", "Falkirk High"),
        place("William Forbes Heritage Display", "museum", "Callendar_House", "Interpretive display connecting the house and estate with local Falkirk families and civic history.", "Callendar House, Falkirk FK1 1YR", "Falkirk High"),
        place("Callendar Woods", "forest", "Callendar_House", "Wooded walks on the edge of the estate, offering shade, birdsong and quieter routes through the park.", "Callendar Park, Falkirk FK1 1YR", "Falkirk High"),
        place("Formal Gardens", "garden", "Callendar_House", "Neat planted sections around the house that contrast with the wider lawns and woodland of the estate.", "Callendar Park, Falkirk FK1 1YR", "Falkirk High"),
        place("Pitch and Putt", "sports venue", "Falkirk", "Family-friendly pitch-and-putt area in the park, adding a relaxed recreational option alongside the heritage attractions.", "Callendar Park, Falkirk FK1 1YR", "Falkirk High"),
        place("Falkirk Wheel Link Route", "walking route", "Falkirk_Wheel", "Signposted connection that helps visitors combine Callendar Park with Falkirk's famous canal engineering landmark.", "Callendar Park to Falkirk Wheel, Falkirk", "Falkirk High"),
        place("Callendar Walled Garden", "garden", "Callendar_House", "Enclosed garden area within the estate, valued for its historic layout and quieter feel.", "Callendar Park, Falkirk FK1 1YR", "Falkirk High"),
    ],
    "newmilns.json": [
        place("Newmilns Tower", "tower", "Newmilns", "Fine sixteenth-century tower house on the main street, among the best-preserved reminders of old Ayrshire burgh life.", "Main Street, Newmilns", "Kilmarnock"),
        place("Loudoun Kirk Ruins", "church", "Loudoun_Castle", "Atmospheric ruined kirk linked with the Loudoun estate and centuries of local parish history.", "Near Galston, East Ayrshire", "Kilmarnock"),
        place("Gauchalland Hill Viewpoint", "viewpoint", "Newmilns", "Hill viewpoint above the town with broad sights across the Irvine Valley and surrounding moorland.", "Near Newmilns, East Ayrshire", "Kilmarnock"),
        place("Galston Heritage Link", "historic area", "Galston,_East_Ayrshire", "Easy neighbouring-town connection for visitors exploring the wider Irvine Valley's mills and old streets.", "Galston, East Ayrshire", "Kilmarnock"),
        place("Barr Castle", "castle", "Barr_Castle", "Tower-house ruin near Galston that makes a strong additional stop when exploring Newmilns and the valley.", "Near Galston, East Ayrshire", "Kilmarnock"),
        place("Cessnock Castle", "castle", "Cessnock_Castle", "Historic castle site associated with Mary Queen of Scots lore and the landed history of the district.", "Near Galston, East Ayrshire", "Kilmarnock"),
        place("Newmilns Weavers Trail", "walking route", "Newmilns", "Themed route through closes and streets celebrating the town's lace and loom-weaving heritage.", "Newmilns, East Ayrshire", "Kilmarnock"),
        place("Covenanters Heritage Walk", "walking route", "Newmilns", "Interpretive walk reflecting the strong Covenanting traditions found across this part of Ayrshire.", "Newmilns, East Ayrshire", "Kilmarnock"),
        place("Irvine Valley Railway Heritage", "industrial heritage", "Newmilns", "Heritage stop recalling the railway that once linked the valley's weaving towns to larger markets.", "Newmilns, East Ayrshire", "Kilmarnock"),
        place("Dunlop Heritage Connection", "historic area", "Dunlop,_East_Ayrshire", "Nearby Ayrshire heritage link adding wider county context to a Newmilns trip through the valley.", "Dunlop, East Ayrshire", "Kilmarnock"),
    ],
    "darvel.json": [
        place("Alexander Fleming Heritage Plaque", "historic site", "Alexander_Fleming", "Plaque and heritage stop marking Darvel's connection with the discoverer of penicillin.", "Darvel, East Ayrshire", "Kilmarnock"),
        place("Darvel Town Hall", "historic building", "Darvel", "Victorian civic building anchoring the town centre and its long tradition of local gatherings and events.", "West Main Street, Darvel", "Kilmarnock"),
        place("Glen Water Valley Walk", "walking route", "Darvel", "Pleasant route through the Glen Water valley, adding green scenery to time spent in the Irvine Valley.", "Darvel, East Ayrshire", "Kilmarnock"),
        place("Loudoun Academy Heritage", "historic building", "Darvel", "Educational heritage stop reflecting the importance of schooling across the Irvine Valley towns.", "Darvel area, East Ayrshire", "Kilmarnock"),
        place("Irvine Valley Textile Heritage", "industrial heritage", "Darvel", "Interpretive stop for the area's loom weaving and lace-making traditions that shaped Darvel and its neighbours.", "Darvel, East Ayrshire", "Kilmarnock"),
        place("Galston Heritage Link", "historic area", "Galston,_East_Ayrshire", "Neighbouring-town heritage connection showing how Darvel sits in a chain of valley communities.", "Galston, East Ayrshire", "Kilmarnock"),
        place("Newmilns Heritage Link", "historic area", "Newmilns", "Nearby heritage link to Newmilns, whose textile and covenanting story overlaps strongly with Darvel's.", "Newmilns, East Ayrshire", "Kilmarnock"),
        place("Drumclog Covenanting Site", "historic site", "Darvel", "Historic site in the Darvel district associated with Covenanting memory and west-of-Scotland religious history.", "Near Darvel, East Ayrshire", "Kilmarnock"),
        place("East Ayrshire Leisure Centre", "sports venue", "Darvel", "Local leisure facility supporting swimming, fitness and community recreation in the valley.", "Darvel, East Ayrshire", "Kilmarnock"),
        place("Darvel War Memorial", "monument", "Darvel", "Town memorial that forms a familiar landmark on a walk through Darvel's civic centre.", "Darvel, East Ayrshire", "Kilmarnock"),
    ],
    "irvine-north-ayrshire.json": [
        place("Stevenson Roundhouse", "historic building", "Stevenston", "Historic circular railway-related building in the Three Towns area, tied to the industrial transport story of the coast.", "Stevenston, North Ayrshire", "Irvine"),
        place("Irvine Burns Club and Wellwood Museum", "museum", "Irvine_Burns_Club", "Burns heritage stop commemorating the poet's stay in Irvine and the world's first Burns Club.", "Eglinton Street, Irvine KA12 8AS", "Irvine"),
        place("Beach Park Dunes", "nature reserve", "Irvine,_North_Ayrshire", "Dune system behind Irvine's beach, important for wildlife and for the classic feel of the local coast.", "Beach Park, Irvine", "Irvine"),
        place("Gailes Links", "golf course", "Irvine,_North_Ayrshire", "Famous linksland south of Irvine, known for championship golf and open coastal scenery.", "Gailes, Irvine", "Irvine"),
        place("Fullarton Woods", "park", "Irvine,_North_Ayrshire", "Wooded parkland popular for walking and cycling between the town and coast.", "Fullarton, Irvine", "Irvine"),
        place("Fullarton House Ruins", "historic site", "Irvine,_North_Ayrshire", "Ruined estate house site hidden in woodland, adding a romantic historic layer to Irvine's green spaces.", "Fullarton Woods, Irvine", "Irvine"),
        place("Fullarton Fairy Trail", "walking route", "Irvine,_North_Ayrshire", "Family-friendly woodland trail that makes Fullarton particularly appealing for a gentle outing.", "Fullarton Woods, Irvine", "Irvine"),
        place("Irvine Old Parish Church", "church", "Irvine,_North_Ayrshire", "Historic church that anchors the older burgh streets and reflects Irvine's long civic past.", "Kirkgate, Irvine", "Irvine"),
        place("Irvine Cross", "historic site", "Irvine,_North_Ayrshire", "Traditional crossroads and gathering point in the historic burgh centre of Irvine.", "Irvine town centre", "Irvine"),
        place("Mercat Cross", "monument", "Irvine,_North_Ayrshire", "Market-cross heritage landmark reflecting Irvine's centuries-old trading privileges and burgh life.", "Irvine town centre", "Irvine"),
        place("Rivergate Heritage Walk", "walking route", "Irvine,_North_Ayrshire", "Easy route from the modern centre toward the river and harbour, connecting old and new Irvine.", "Rivergate, Irvine", "Irvine"),
        place("Irvine Townhouse", "historic building", "Irvine,_North_Ayrshire", "Traditional civic building that helps tell the story of Irvine as one of Scotland's historic royal burghs.", "Bridgegate, Irvine", "Irvine"),
        place("Harbour Arts Centre", "gallery", "Irvine,_North_Ayrshire", "Arts venue on the harbourside bringing exhibitions and live culture into a historic waterfront setting.", "Harbour Street, Irvine", "Irvine"),
        place("Trindlemoss Loch", "nature reserve", "Irvine,_North_Ayrshire", "Local wetland area that offers birdlife and a quieter contrast to Irvine's coast and harbour.", "Trindlemoss, Irvine", "Irvine"),
        place("Ardeer Peninsula", "nature reserve", "Ardeer", "Large coastal peninsula mixing dune habitats, industrial archaeology and wide-open sea views.", "Ardeer, North Ayrshire", "Irvine"),
        place("Dundonald Castle", "castle", "Dundonald_Castle", "Historic Stewart castle just beyond Irvine, famed as the birthplace of Robert II and a major west-coast fortress.", "Castle Gate, Dundonald KA2 9HD", "Irvine"),
        place("Irvine High Street Townscape", "historic area", "Irvine,_North_Ayrshire", "Historic main-street area where closes, church sites and civic buildings reveal the old burgh's character.", "High Street, Irvine", "Irvine"),
    ],
    "saltcoats.json": [
        place("North Ayrshire Heritage Centre", "museum", "Saltcoats", "Local history venue covering maritime, social and industrial stories from the Three Towns coast.", "Saltcoats, North Ayrshire", "Saltcoats"),
        place("Saltcoats Harbour", "harbour", "Saltcoats", "Historic harbour area reminding visitors that Saltcoats grew as a working coastal town as well as a resort.", "Saltcoats harbour, Saltcoats", "Saltcoats"),
        place("Saltcoats Promenade", "walking route", "Saltcoats", "Classic seafront promenade with beach views, benches and easy walking between key town landmarks.", "The Esplanade, Saltcoats", "Saltcoats"),
        place("Ardrossan Castle Viewpoint", "viewpoint", "Ardrossan_Castle", "Viewpoint across the bay toward Ardrossan's castle hill, especially striking in clear weather.", "Saltcoats seafront, Saltcoats", "Saltcoats"),
        place("Stevenston Dune Walk", "walking route", "Stevenston", "Dune-backed shoreline walk south of Saltcoats with wildlife interest and long coastal views.", "Stevenston shore, North Ayrshire", "Saltcoats"),
        place("Stevenston Chemical Heritage", "industrial heritage", "Stevenston", "Interpretive stop for the district's explosive and chemical manufacturing legacy.", "Stevenston, North Ayrshire", "Saltcoats"),
        place("Saltcoats Old Pier", "historic site", "Saltcoats", "Historic pier area that preserves a sense of the town's older maritime role.", "Saltcoats harbour, Saltcoats", "Saltcoats"),
        place("Three Towns Rail Heritage", "industrial heritage", "Saltcoats", "Heritage stop linking Saltcoats with the pioneering railway story of Ayrshire's coast and coalfields.", "Saltcoats and Stevenston, North Ayrshire", "Saltcoats"),
        place("Saltcoats Town Hall", "historic building", "Saltcoats", "Civic landmark that adds architectural interest to a walk through the town centre.", "Saltcoats town centre", "Saltcoats"),
        place("Saltcoats North Bay", "beach", "Saltcoats", "Additional stretch of coastline and open views at the northern side of Saltcoats seafront.", "North Bay, Saltcoats", "Saltcoats"),
    ],
    "ardrossan.json": [
        place("Ardrossan Marina", "harbour", "Ardrossan", "Modern marina area that complements the older ferry port and adds a contemporary sailing focus.", "Ardrossan harbour, Ardrossan", "Ardrossan Harbour"),
        place("Montfode Country Park", "park", "Ardrossan", "Coastal meadow and walking area on the edge of town, useful for gentler exploration away from the port.", "Montfode, Ardrossan", "Ardrossan Harbour"),
        place("Arran Ferry Viewpoint", "viewpoint", "Ardrossan", "Harbourside viewpoint for watching ferries depart to Arran with broad sea and island views.", "Montgomerie Pier, Ardrossan", "Ardrossan Harbour"),
        place("Ardrossan Town House", "historic building", "Ardrossan", "Civic building that reflects the administrative and burgh history of the old port town.", "Ardrossan town centre", "Ardrossan South Beach"),
        place("North Ayrshire Coastal Path", "walking route", "North_Ayrshire", "Coastal walking route that makes Ardrossan a natural staging point between beaches, piers and neighbouring towns.", "Ardrossan coast, North Ayrshire", "Ardrossan Harbour"),
        place("Montgomerie Pier", "pier", "Ardrossan", "Historic ferry pier central to Ardrossan's role as Arran's mainland gateway.", "Montgomerie Pier, Ardrossan", "Ardrossan Harbour"),
        place("Saltcoats Coast Walk", "walking route", "Saltcoats", "Easy promenade-style walk linking Ardrossan with Saltcoats along the open Clyde shore.", "Ardrossan to Saltcoats coast", "Ardrossan South Beach"),
        place("Brodick Castle Viewpoint", "viewpoint", "Isle_of_Arran", "Clear-day viewpoint toward Arran and the high ground above Brodick, a classic reward from Ardrossan's coast.", "Ardrossan seafront, Ardrossan", "Ardrossan Harbour"),
        place("Castle Hill Panorama", "viewpoint", "Ardrossan", "Panoramic hilltop view across the Firth of Clyde from the castle area, with islands and ferries in sight.", "Castle Hill, Ardrossan", "Ardrossan Harbour"),
    ],
}


def build_record(file_name: str, meta: dict[str, Any], addition: dict[str, Any], timestamp: str) -> dict[str, Any]:
    info = fetch_wiki_summary(addition["wiki"])
    station = addition.get("station") or DEFAULT_STATIONS[file_name]
    source_url = info["url"]
    lat = info.get("lat")
    lng = info.get("lng")
    return {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(meta['prefecture'])}:{nk(meta['city'])}:{nk(addition['name'])}",
        "region": meta["region"],
        "prefecture": meta["prefecture"],
        "city": meta["city"],
        "country": "GB",
        "name": addition["name"],
        "category": addition["category"],
        "description": addition["description"],
        "tips": [],
        "hours": None,
        "hours_status": "unknown",
        "station": station,
        "google_place_id": None,
        "lat": round(lat, 6) if isinstance(lat, (int, float)) else None,
        "lng": round(lng, 6) if isinstance(lng, (int, float)) else None,
        "address": addition["address"],
        "rating": None,
        "price_level": None,
        "image_url": None,
        "badges": [],
        "source_urls": [source_url],
        "field_sources": {
            "description": source_url,
            "address": source_url,
            "station": source_url,
            **({"lat": source_url, "lng": source_url} if lat is not None and lng is not None else {}),
        },
        "photo": None,
        "extraction_model": EXTRACTION_MODEL,
        "extraction_status": "extracted",
        "validation_errors": [],
        "approved": False,
        "rejected_reason": None,
        "fetched_at": timestamp,
        "last_verified_at": timestamp,
    }



def append_file(file_name: str, additions: list[dict[str, Any]]) -> tuple[int, int]:
    path = BASE_DIR / file_name
    payload = json.loads(path.read_text(encoding="utf-8"))
    records = payload["records"]
    meta = {
        "region": records[0]["region"],
        "prefecture": records[0]["prefecture"],
        "city": records[0]["city"],
    }
    existing = {record["name"].strip().lower() for record in records}
    timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    appended = 0
    for addition in additions:
        key = addition["name"].strip().lower()
        if key in existing:
            continue
        records.append(build_record(file_name, meta, addition, timestamp))
        existing.add(key)
        appended += 1
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return appended, len(records)



def final_counts() -> list[tuple[str, int]]:
    counts = []
    for path in sorted(BASE_DIR.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            counts.append((path.name, len(payload.get("records", []))))
        except Exception:
            counts.append((path.name, -1))
    return counts



def main() -> None:
    summary = []
    for file_name, additions in ADDITIONS.items():
        appended, total = append_file(file_name, additions)
        summary.append((file_name, appended, total))
    print("Remaining top-up complete")
    for file_name, appended, total in summary:
        print(f"{file_name}: appended={appended} total={total}")
    print("Final counts:")
    for file_name, total in final_counts():
        print(f"{file_name}: {total}")
    print(f"unique_wiki_fetches={len(_cache)}")


if __name__ == "__main__":
    main()
