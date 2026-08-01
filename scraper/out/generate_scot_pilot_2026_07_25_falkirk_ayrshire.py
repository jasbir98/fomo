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
OUTPUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
SCRIPT_NAME = "copilot-cli-knowledge"
USER_AGENT = "Mozilla/5.0 (compatible; CopilotCLI/1.0; +https://github.com/)"
REQUEST_DELAY = 0.8


def nk(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unknown"


last_request_at = 0.0
wiki_cache: dict[str, dict[str, Any]] = {}


def wiki_url(title: str) -> str:
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="()_,!'")
    return f"https://en.wikipedia.org/wiki/{encoded}"


def fetch_wiki_summary(title: str) -> dict[str, Any]:
    global last_request_at
    if title in wiki_cache:
        return wiki_cache[title]

    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="()_,!'")
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"

    for attempt in range(5):
        elapsed = time.time() - last_request_at
        if elapsed < REQUEST_DELAY:
            time.sleep(REQUEST_DELAY - elapsed)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        last_request_at = time.time()
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            coords = payload.get("coordinates") or {}
            result = {
                "ok": True,
                "title": payload.get("titles", {}).get("canonical") or title,
                "url": payload.get("content_urls", {}).get("desktop", {}).get("page") or wiki_url(title),
                "description": payload.get("extract"),
                "lat": coords.get("lat"),
                "lng": coords.get("lon"),
            }
            wiki_cache[title] = result
            return result
        except urllib.error.HTTPError as exc:
            if exc.code in {404}:
                break
            if exc.code in {429, 500, 502, 503, 504}:
                time.sleep((attempt + 1) * 1.5)
                continue
            break
        except Exception:
            time.sleep((attempt + 1) * 1.0)
    result = {"ok": False, "title": title, "url": wiki_url(title), "description": None, "lat": None, "lng": None}
    wiki_cache[title] = result
    return result


def place(
    name: str,
    category: str,
    *,
    wiki: str | None = None,
    wikis: list[str] | None = None,
    description: str | None = None,
    address: str | None = None,
    station: str | None = None,
    hours: str | None = None,
    hours_status: str | None = None,
    lat: float | None = None,
    lng: float | None = None,
    extra_source_urls: list[str] | None = None,
) -> dict[str, Any]:
    titles = list(wikis or ([] if wiki is None else [wiki]))
    return {
        "name": name,
        "category": category,
        "wikis": titles,
        "description": description,
        "address": address,
        "station": station,
        "hours": hours,
        "hours_status": hours_status,
        "lat": lat,
        "lng": lng,
        "extra_source_urls": extra_source_urls or [],
    }


CITIES: list[dict[str, Any]] = [
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Falkirk",
        "city": "Falkirk",
        "output_file": "falkirk.json",
        "default_station": "Falkirk Grahamston",
        "places": [
            place("The Falkirk Wheel", "landmark", wiki="Falkirk_Wheel", address="Lime Road, Tamfourhill, Falkirk FK1 4RS", station="Falkirk Grahamston", hours="Visitor centre open daily 10am-5:30pm; boat trips run Apr-Oct", hours_status="known", extra_source_urls=["https://www.scottishcanals.co.uk/falkirk-wheel/"]),
            place("The Kelpies", "landmark", wiki="The_Kelpies", address="The Helix, Grangemouth, Falkirk FK2 7ZT"),
            place("Helix Park", "park", wiki="The_Helix_(Falkirk)", address="The Helix, Falkirk FK2 7ZT"),
            place("Callendar House", "museum", wiki="Callendar_House", address="Callendar Park, Falkirk FK1 1YR", station="Falkirk High"),
            place("Callendar Park", "park", wikis=["Callendar_House", "Antonine_Wall"], description="Historic parkland around Callendar House with woodland walks, play areas, formal grounds and stretches of the Antonine Wall earthworks.", address="Callendar Park, Falkirk FK1 1YR", station="Falkirk High"),
            place("Falkirk Steeple", "landmark", wiki="Falkirk_Steeple", address="High Street, Falkirk FK1 1HG"),
            place("Rough Castle Roman Fort", "historic site", wiki="Rough_Castle_Fort", address="Bonnyside Road, Bonnybridge FK4 2AA", station="Camelon"),
            place("Antonine Wall", "historic site", wiki="Antonine_Wall", description="UNESCO World Heritage Roman frontier running across central Scotland; the Falkirk district contains some of its best-preserved ramparts, ditches and fort sites.", address="Falkirk district, Scotland", station="Camelon"),
            place("Seabegs Wood", "nature reserve", wiki="Antonine_Wall", description="Woodland section of the Antonine Wall corridor with peaceful walking paths and visible traces of the Roman frontier near Bonnybridge.", address="Bonnybridge, Falkirk", station="Camelon"),
            place("Camelon Roman Fort", "historic site", wiki="Camelon", description="Site of an important Roman fort and settlement at Camelon, associated with the Antonine Wall frontier and later military activity.", address="Camelon, Falkirk", station="Camelon"),
            place("Falkirk Stadium", "sports venue", wiki="Falkirk_Stadium", address="4 Stadium Way, Falkirk FK2 9EE"),
            place("Union Canal", "canal", wiki="Union_Canal_(Scotland)", description="The eastern canal linked to the Falkirk Wheel, popular for towpath walks, boat trips and views over the surrounding countryside.", address="Tamfourhill, Falkirk", station="Falkirk High"),
            place("Forth and Clyde Canal", "canal", wiki="Forth_and_Clyde_Canal", description="Historic sea-to-sea canal crossing Falkirk, central to the area's industrial heritage and now a scenic route for boating and walking.", address="Falkirk, Scotland", station="Falkirk Grahamston"),
            place("Torwood Castle", "castle", wiki="Torwood_Castle", address="Tor Wood, Larbert FK5 4SN", station="Larbert"),
            place("Dunmore Pineapple", "historic site", wiki="Dunmore_Pineapple", description="Eccentric 18th-century garden folly topped with a giant stone pineapple, one of Scotland's most distinctive architectural curiosities.", address="Dunmore Park, Airth FK2 8LU", station="Polmont"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Falkirk",
        "city": "Stirling",
        "output_file": "stirling-falkirk.json",
        "default_station": "Larbert",
        "places": [
            place("Falkirk Wheel", "landmark", wiki="Falkirk_Wheel", description="Engineering icon on the southern approach toward Stirling, often paired with itineraries between Falkirk, Larbert and Bannockburn.", address="Lime Road, Tamfourhill, Falkirk FK1 4RS", station="Falkirk Grahamston"),
            place("Torwood Broch", "historic site", wiki="Torwood_Castle", description="Rare Iron Age broch site hidden in woodland near Tor Wood, hinting at much earlier settlement along the Falkirk-Stirling corridor.", address="Tor Wood, Larbert", station="Larbert"),
            place("Tor Wood", "forest", wiki="Torwood_Castle", description="Ancient woodland of giant oaks and folklore-rich paths close to Larbert, Torwood Castle and the Bannockburn approach.", address="Tor Wood, Larbert", station="Larbert"),
            place("Torwood Castle", "castle", wiki="Torwood_Castle", address="Tor Wood, Larbert FK5 4SN", station="Larbert"),
            place("Battle of Bannockburn Visitor Centre", "battlefield", wiki="Battle_of_Bannockburn", description="Modern visitor centre and battlefield landscape commemorating Robert the Bruce's 1314 victory, an easy detour from the Falkirk-to-Stirling corridor.", address="Glasgow Road, Whins of Milton, Stirling FK7 0LJ", station="Stirling"),
            place("Carron Works Heritage", "industrial heritage", wiki="Carron_Company", description="Legacy of the celebrated Carron Company ironworks, famed for cannon production and the carronade, which shaped the industrial story of the Falkirk-Stirling area.", address="Carron, Falkirk", station="Larbert"),
            place("Larbert Old Church", "church", wiki="Larbert", description="Historic parish church site reflecting Larbert's older settlement before the town expanded as a transport and healthcare hub.", address="Denny Road, Larbert", station="Larbert"),
            place("Shieldhill Castle", "castle", wiki="Falkirk", description="Country-house style castle accommodation near Falkirk and Stirling, useful as a heritage stop on rural drives around the district.", address="Shieldhill, near Falkirk", station="Polmont"),
            place("Denny Heritage Trail", "historic area", wiki="Denny,_Stirlingshire", description="A walk through old Denny linking the town's industrial, canal and railway-era story in the western part of Falkirk council area.", address="Denny town centre, Falkirk", station="Camelon"),
            place("Plean Country Park", "park", wiki="Plean", description="Wooded former estate park with trails, open glades and easy family walking routes south of Stirling.", address="Plean, Stirling FK7 8BB", station="Stirling"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Falkirk",
        "city": "Grangemouth",
        "output_file": "grangemouth.json",
        "default_station": "Falkirk Grahamston",
        "places": [
            place("The Kelpies", "landmark", wiki="The_Kelpies", address="The Helix, Grangemouth, Falkirk FK2 7ZT"),
            place("Inchyra Park", "park", wiki="Grangemouth", description="Large public park in Grangemouth with sports pitches, open lawns and space for local events.", address="Inchyra Road, Grangemouth"),
            place("Zetland Park", "park", wiki="Grangemouth", description="Victorian-era town park with flower displays, play areas and a boating pond close to central Grangemouth.", address="Abbots Road, Grangemouth"),
            place("Grangemouth Heritage Centre", "museum", wiki="Grangemouth", description="Local heritage displays interpreting Grangemouth's canal, petrochemical and dockland history.", address="Bo'ness Road, Grangemouth"),
            place("Watling Lodge", "historic site", wiki="Antonine_Wall", description="Prominent Antonine Wall earthwork and fortlet site near Falkirk, often visited from Grangemouth and the Helix area.", address="Tamfourhill Road, Falkirk", station="Falkirk Grahamston"),
            place("Kinneil House", "historic house", wiki="Kinneil_House", address="Kinneil Estate, Bo'ness EH51 0PR", station="Polmont"),
            place("Bo'ness and Kinneil Railway", "heritage railway", wiki="Bo'ness_and_Kinneil_Railway", address="Union Street, Bo'ness EH51 9AQ", station="Polmont", hours="Most train operating days are seasonal weekends and event dates", hours_status="known"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Falkirk",
        "city": "Callendar Park",
        "output_file": "callendar-park.json",
        "default_station": "Falkirk High",
        "places": [
            place("Callendar House", "museum", wiki="Callendar_House", address="Callendar Park, Falkirk FK1 1YR"),
            place("Callendar Park", "park", wikis=["Callendar_House", "Antonine_Wall"], description="Expansive historic estate park with mature trees, walking loops, play areas and broad lawns around Callendar House.", address="Callendar Park, Falkirk FK1 1YR"),
            place("Antonine Wall in Callendar Park", "historic site", wiki="Antonine_Wall", description="A section of the Roman frontier passes through the estate, making Callendar Park one of the easiest places to combine parkland walks with Antonine Wall history.", address="Callendar Park, Falkirk FK1 1YR"),
            place("Georgian Kitchen", "museum", wiki="Callendar_House", description="Recreated Georgian kitchen within Callendar House, laid out to show how an aristocratic household would have functioned in the 19th century.", address="Callendar House, Falkirk FK1 1YR"),
            place("Callendar Park Trails and Grounds", "park", wiki="Callendar_House", description="Family-friendly footpaths, picnic lawns and open park views make the grounds a relaxed outdoor stop even without entering the house museum.", address="Callendar Park, Falkirk FK1 1YR"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "East Ayrshire",
        "city": "Kilmarnock",
        "output_file": "kilmarnock.json",
        "default_station": "Kilmarnock",
        "places": [
            place("Dean Castle", "castle", wiki="Dean_Castle", address="Dean Road, Kilmarnock KA3 1XB"),
            place("Dean Castle Country Park", "park", wiki="Dean_Castle", description="Riverside country park surrounding Dean Castle with woodland trails, urban farm features, wetlands and family recreation space.", address="Dean Road, Kilmarnock KA3 1XB"),
            place("Dick Institute", "museum", wiki="Dick_Institute", address="Elmbank Avenue, Kilmarnock KA1 3BU"),
            place("Burns Monument", "monument", wiki="Burns_Monument,_Kilmarnock", address="Kay Park, Kilmarnock KA3 7RU"),
            place("Kay Park", "park", wiki="Kay_Park", address="Kay Park, Kilmarnock KA3 7RU"),
            place("Rugby Park", "sports venue", wiki="Rugby_Park", address="Rugby Road, Kilmarnock KA1 2DP"),
            place("Kilmarnock Cross", "historic area", wiki="Kilmarnock", description="Traditional civic heart of Kilmarnock, surrounded by historic buildings and long connected with market and town life.", address="King Street, Kilmarnock"),
            place("Palace Theatre", "theatre", wiki="Palace_Theatre,_Kilmarnock", address="Green Street, Kilmarnock KA1 3BN"),
            place("Laigh Kirk", "church", wiki="Kilmarnock", description="Historic parish church in central Kilmarnock reflecting the town's religious and architectural heritage.", address="John Finnie Street, Kilmarnock"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "East Ayrshire",
        "city": "Irvine",
        "output_file": "irvine.json",
        "default_station": "Irvine",
        "places": [
            place("Scottish Maritime Museum", "museum", wiki="Scottish_Maritime_Museum", address="Linthouse, Irvine Harbour, Irvine KA12 8QE"),
            place("Irvine Harbour", "harbour", wiki="Irvine,_North_Ayrshire", description="Historic harbour area at the mouth of the River Irvine, now a focal point for waterfront walks, museum visits and maritime heritage.", address="Harbour Street, Irvine"),
            place("Irvine Beach Park", "beach", wiki="Irvine,_North_Ayrshire", description="Wide sandy seafront backed by dunes and recreation space, popular for sunsets, walking and views across the Firth of Clyde.", address="Beach Drive, Irvine"),
            place("Eglinton Country Park", "park", wiki="Eglinton_Country_Park", address="Kilwinning Road, Irvine KA12 8TA"),
            place("Seagate Castle", "castle", wiki="Seagate_Castle", address="Seagate, Irvine KA12 8AF"),
            place("Irvine Burns Club", "museum", wiki="Irvine_Burns_Club", address="Wellwood Burns Centre, Eglinton Street, Irvine KA12 8AS"),
            place("Magnum Leisure Centre", "sports venue", wiki="Irvine,_North_Ayrshire", description="Large leisure complex close to the waterfront with swimming, ice sports and family activity spaces.", address="Harbour Street, Irvine KA12 8PP"),
            place("Dundonald Castle", "castle", wiki="Dundonald_Castle", address="Castle Gate, Dundonald KA2 9HD", station="Irvine"),
            place("Glasgow Vennel", "historic street", wiki="Irvine,_North_Ayrshire", description="One of Irvine's best-known old streets, preserving a sense of the medieval burgh layout near the centre of town.", address="Glasgow Vennel, Irvine"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "East Ayrshire",
        "city": "Newmilns",
        "output_file": "newmilns.json",
        "default_station": "Kilmarnock",
        "places": [
            place("Loudoun Hill", "viewpoint", wiki="Loudoun_Hill", address="Near Darvel and Newmilns, East Ayrshire"),
            place("Loudoun Castle", "castle", wiki="Loudoun_Castle", address="Loudoun Castle Estate, Galston KA4 8PD"),
            place("Newmilns Lace and Textile Heritage", "museum", wiki="Newmilns", description="Newmilns is closely associated with Scotland's lace industry, and local heritage displays celebrate generations of weaving and textile craftsmanship.", address="Main Street, Newmilns"),
            place("River Irvine Walk", "park", wiki="River_Irvine", description="Riverside stroll through the Irvine Valley with views of older mill buildings and the surrounding countryside.", address="Newmilns, East Ayrshire"),
            place("Newmilns Tower and Town Heritage", "historic area", wiki="Newmilns", description="Historic core of Newmilns with older closes, bridge viewpoints and reminders of the burgh's industrial past.", address="Castle Street, Newmilns"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "East Ayrshire",
        "city": "Darvel",
        "output_file": "darvel.json",
        "default_station": "Kilmarnock",
        "places": [
            place("Lochfield, Darvel", "historic house", wiki="Lochfield,_Darvel", description="Cottage birthplace of Sir Alexander Fleming, connecting Darvel with the story of penicillin and modern medicine.", address="Lochfield, Darvel KA17 0ES"),
            place("Loudoun Hill", "viewpoint", wiki="Loudoun_Hill", address="Near Darvel, East Ayrshire"),
            place("Darvel Heritage Trail", "historic area", wiki="Darvel", description="Self-guided exploration of Darvel's weaving, covenanting and railway-era past through the main street and surrounding closes.", address="West Main Street, Darvel"),
            place("Irvine Valley Paths", "park", wiki="Darvel", description="Network of local walking routes heading out from Darvel into the rolling Irvine Valley countryside.", address="Darvel, East Ayrshire"),
            place("Darvel Parish Church", "church", wiki="Darvel", description="Prominent town church representing Darvel's Victorian civic character and long-established parish history.", address="West Main Street, Darvel"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "South Ayrshire",
        "city": "Ayr",
        "output_file": "ayr.json",
        "default_station": "Ayr",
        "places": [
            place("Ayr Beach", "beach", wiki="Ayr", description="Long sandy beach and esplanade popular for family walks, sea views and easy access to the town centre.", address="Esplanade, Ayr"),
            place("Ayr Racecourse", "sports venue", wiki="Ayr_Racecourse", address="2-6 Whitletts Road, Ayr KA8 0JE"),
            place("Ayr Harbour", "harbour", wiki="Ayr", description="Working and leisure harbour on the River Ayr, linked to the town's maritime trade and seaside character.", address="South Harbour Street, Ayr"),
            place("Low Green", "park", wiki="Ayr", description="Broad seafront green space beside the beach, used for strolling, events and classic Ayr sunsets.", address="Ayr Esplanade, Ayr"),
            place("Auld Kirk of Ayr", "church", wiki="Auld_Kirk_of_Ayr", address="Kirkhall, Ayr KA7 1QW"),
            place("Loudoun Hall", "historic building", wiki="Ayr", description="One of Ayr's oldest surviving houses, a turreted burgh building linked with civic life and centuries of High Street history.", address="122-124 High Street, Ayr KA7 1QW"),
            place("Ayr Town Hall", "historic building", wiki="Ayr_Town_Hall", address="New Bridge Street, Ayr KA7 1JX"),
            place("Ayr Carnegie Library", "library", wiki="Ayr", description="Historic Carnegie library building reflecting the civic ambition of Victorian Ayr and the town's cultural heritage.", address="Main Street, Ayr"),
            place("Tam o' Shanter Experience", "museum", wiki="Ayr", description="Burns-themed heritage attraction in Ayr celebrating Tam o' Shanter and the town's literary connection with Robert Burns.", address="High Street, Ayr"),
            place("Belleisle Park", "park", wiki="Ayr", description="Large public park around Belleisle House with formal gardens, woodland walks, golf and wide views toward the Doon valley.", address="Doonfoot Road, Ayr KA7 4DU"),
            place("Rozelle Park", "park", wiki="Ayr", description="Landscaped south Ayr park with gardens, sculpture trails and easy access to the town's Burns Country attractions.", address="Monument Road, Ayr KA7 4NQ"),
            place("Rozelle House", "gallery", wiki="Ayr", description="Victorian mansion within Rozelle Park that now hosts art exhibitions and local cultural displays.", address="Monument Road, Ayr KA7 4NQ"),
            place("River Ayr Way", "walking route", wiki="River_Ayr_Way", address="River Ayr corridor, Ayr"),
            place("Greenan Castle", "castle", wiki="Greenan_Castle", address="Greenan Shore, Ayr"),
            place("Electric Brae", "viewpoint", wiki="Electric_Brae", address="A719, near Dunure"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "South Ayrshire",
        "city": "Alloway",
        "output_file": "alloway.json",
        "default_station": "Ayr",
        "places": [
            place("Burns Cottage", "historic house", wiki="Burns_Cottage", address="Murdoch's Lone, Alloway, Ayr KA7 4PQ"),
            place("Robert Burns Birthplace Museum", "museum", wiki="Robert_Burns_Birthplace_Museum", address="Murdoch's Lone, Alloway, Ayr KA7 4PQ"),
            place("Burns Monument and Gardens", "monument", wiki="Robert_Burns_Birthplace_Museum", description="Landscaped memorial gardens and dramatic 19th-century monument celebrating Robert Burns beside the Brig o' Doon and museum complex.", address="Murdoch's Lone, Alloway, Ayr KA7 4PQ"),
            place("Brig o' Doon", "bridge", wiki="Brig_o'_Doon", address="Brig o' Doon, Alloway, Ayr KA7 4PQ"),
            place("Auld Kirk, Alloway", "church", wiki="Alloway", description="Atmospheric ruined medieval kirk made famous in Tam o' Shanter, standing among old gravestones in the heart of Burns Country.", address="Alloway, Ayr KA7 4PQ"),
            place("Poet's Path", "walking route", wiki="Robert_Burns_Birthplace_Museum", description="Short landscaped path linking the museum, Brig o' Doon and Burns Monument through the heart of Burns Country.", address="Alloway village, Ayr KA7 4PQ"),
            place("Greenan Castle", "castle", wiki="Greenan_Castle", address="Greenan Shore, Ayr"),
            place("Doonfoot Beach", "beach", wiki="Ayr", description="Quiet stretch of sand near Alloway at the mouth of the River Doon, ideal for coastal walks and views back to Greenan Castle.", address="Doonfoot Road, Ayr"),
            place("River Doon Walk", "walking route", wiki="River_Doon", description="Scenic riverside walks around Alloway following the waterway made famous in Burns's poetry.", address="River Doon, Alloway"),
            place("Souter Johnnie's Cottage", "historic house", wiki="Kirkoswald,_South_Ayrshire", description="Traditional thatched cottage in Kirkoswald associated with Burns's Tam o' Shanter and its convivial cobbler character.", address="Main Street, Kirkoswald KA19 8HY", station="Maybole"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "South Ayrshire",
        "city": "Turnberry",
        "output_file": "turnberry.json",
        "default_station": "Girvan",
        "places": [
            place("Trump Turnberry Resort", "golf resort", wiki="Turnberry_(golf_course)", description="Legendary Ayrshire golf resort on the coast, home to the Open Championship-hosting Ailsa Course and wide sea views toward Ailsa Craig.", address="Maidens Road, Turnberry KA26 9LT"),
            place("Ailsa Course", "golf course", wiki="Turnberry_(golf_course)", description="Famous championship links course repeatedly used for the Open, known for cliff-top holes and dramatic lighthouse views.", address="Maidens Road, Turnberry KA26 9LT"),
            place("Turnberry Lighthouse", "lighthouse", wiki="Turnberry_Lighthouse", address="Turnberry Point, Turnberry KA26 9LT"),
            place("Ailsa Craig Viewpoint", "viewpoint", wiki="Ailsa_Craig", description="Classic coastal viewpoint toward the volcanic island of Ailsa Craig, a striking constant on the horizon from Turnberry's shoreline.", address="Turnberry coast, South Ayrshire"),
            place("Culzean Castle", "castle", wiki="Culzean_Castle", address="Maybole KA19 8LE", station="Maybole"),
            place("Culzean Country Park", "park", wiki="Culzean_Castle", description="Extensive clifftop estate grounds surrounding Culzean Castle with formal gardens, woodland walks and sea panoramas.", address="Maybole KA19 8LE", station="Maybole"),
            place("Electric Brae", "viewpoint", wiki="Electric_Brae", address="A719, near Croy Shore"),
            place("Dunure Castle", "castle", wiki="Dunure_Castle", address="Dunure, Ayr KA7 4LX", station="Ayr"),
            place("Crossraguel Abbey", "abbey", wiki="Crossraguel_Abbey", address="By Maybole KA19 8HQ", station="Maybole"),
            place("Kennedy's Castle", "historic site", wiki="Turnberry,_South_Ayrshire", description="Ruined clifftop stronghold traditionally linked with the Kennedy family and dramatic views over the Ayrshire coast.", address="Dunure, South Ayrshire", station="Ayr"),
            place("Maybole Castle", "castle", wiki="Maybole_Castle", address="High Street, Maybole KA19 7AB", station="Maybole"),
            place("Maidens Harbour", "harbour", wiki="Turnberry,_South_Ayrshire", description="Pretty harbour village south of Culzean and Turnberry, good for coastal views and short promenade walks.", address="Maidens, Girvan KA26 9NR", station="Girvan"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "South Ayrshire",
        "city": "Girvan",
        "output_file": "girvan.json",
        "default_station": "Girvan",
        "places": [
            place("Girvan Harbour", "harbour", wiki="Girvan", description="Busy small harbour and marina with fishing heritage, seafront walks and excellent views to Ailsa Craig.", address="Harbour Road, Girvan"),
            place("Girvan Beach", "beach", wiki="Girvan", description="Broad sandy beach backed by the promenade, ideal for family strolls and island views.", address="Promenade, Girvan"),
            place("McKechnie Institute", "museum", wiki="Girvan", description="Victorian civic building housing local collections and telling the story of Girvan and Carrick.", address="Dalrymple Street, Girvan KA26 9BQ"),
            place("Ailsa Craig Viewpoint", "viewpoint", wiki="Ailsa_Craig", description="One of the best mainland viewing points for Ailsa Craig, especially from the seafront and harbour.", address="Girvan seafront, Girvan"),
            place("Kennedy's Cross", "monument", wiki="Girvan", description="Historic monument associated with the Kennedy family and the district's medieval past.", address="Girvan, South Ayrshire"),
            place("Knockdolian Hill Fort", "historic site", wiki="Girvan", description="Prominent hill fort site above the coast, combining archaeological interest with wide sea and upland views.", address="Knockdolian Hill, Girvan"),
            place("Carleton Castle", "castle", wiki="Carleton_Castle", address="Lendalfoot, Girvan KA26 0JT"),
            place("Ardmillan Castle", "castle", wiki="Ardmillan_Castle", address="Near Ballantrae, South Ayrshire"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "South Ayrshire",
        "city": "Stranraer",
        "output_file": "stranraer.json",
        "default_station": "Stranraer",
        "places": [
            place("Castle of St John", "castle", wiki="Castle_of_St_John", address="George Street, Stranraer DG9 7JP"),
            place("Stranraer Museum", "museum", wiki="Stranraer", description="Local museum telling the story of Stranraer, Loch Ryan and the wider Rhins of Galloway.", address="George Street, Stranraer DG9 7JP"),
            place("Agnew Park", "park", wiki="Stranraer", description="Victorian park on Loch Ryan with boating lake views and family-friendly space close to the seafront.", address="Agnew Crescent, Stranraer"),
            place("Stranraer Harbour", "harbour", wiki="Stranraer", description="Harbourfront on Loch Ryan reflecting the town's long role as a maritime gateway in south-west Scotland.", address="West Pier, Stranraer"),
            place("Glenwhan Gardens", "garden", wiki="Glenwhan_Gardens", address="Dunragit, Stranraer DG9 8PH"),
            place("Logan Botanic Garden", "garden", wiki="Logan_Botanic_Garden", address="Port Logan, Stranraer DG9 9ND"),
            place("Mull of Galloway Lighthouse", "lighthouse", wiki="Mull_of_Galloway", description="Scotland's southernmost headland with clifftop walks, seabirds and a striking lighthouse viewpoint.", address="Drummore, Stranraer DG9 9HP"),
            place("Portpatrick Harbour", "harbour", wiki="Portpatrick", description="Picturesque harbour village on the Rhins coast with colourful houses, walks and sea views.", address="Portpatrick, Stranraer DG9 8BT"),
            place("Dunskey Castle", "castle", wiki="Dunskey_Castle", address="Portpatrick, Stranraer"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "South Ayrshire",
        "city": "Prestwick",
        "output_file": "prestwick.json",
        "default_station": "Prestwick Town",
        "places": [
            place("Prestwick Golf Club", "golf course", wiki="Prestwick_Golf_Club", address="2 Links Road, Prestwick KA9 1QG"),
            place("Prestwick Promenade", "beach", wiki="Prestwick", description="Long promenade and beach with views toward Arran and easy walking between the old town and the seafront.", address="The Esplanade, Prestwick"),
            place("Old St Nicholas Church", "church", wiki="Prestwick", description="Ruined medieval parish church in old Prestwick, long tied to pilgrims, golf history and the old burgh core.", address="The Cross, Prestwick KA9 1AJ"),
            place("Bruce's Well", "historic site", wiki="Prestwick", description="Traditional Robert the Bruce site on the old course, adding legend to Prestwick's golfing heritage.", address="Prestwick Old Course, Prestwick"),
            place("Glasgow Prestwick Airport", "aviation heritage", wiki="Glasgow_Prestwick_Airport", address="Prestwick KA9 2PL", station="Prestwick International Airport"),
            place("Bogside Flats Nature Reserve", "nature reserve", wiki="Prestwick", description="Wetland and mudflat reserve on the Ayrshire coast, valued for birdwatching and migratory species.", address="Bogside, Ayrshire coast", station="Prestwick Town"),
            place("Prestwick Old Town", "historic area", wiki="Prestwick", description="Compact medieval core around the Cross with old inns, kirkyard history and one of Scotland's best-known golfing streetscapes.", address="The Cross, Prestwick"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "South Ayrshire",
        "city": "Maybole",
        "output_file": "maybole.json",
        "default_station": "Maybole",
        "places": [
            place("Maybole Castle", "castle", wiki="Maybole_Castle", address="High Street, Maybole KA19 7AB"),
            place("Crossraguel Abbey", "abbey", wiki="Crossraguel_Abbey", address="By Maybole KA19 8HQ"),
            place("Culzean Castle", "castle", wiki="Culzean_Castle", address="Maybole KA19 8LE"),
            place("Cassillis House", "historic house", wiki="Maybole", description="Grand historic house on the River Doon estate, associated with the Kennedy family and the old power centre of Carrick.", address="Cassillis Estate, Maybole"),
            place("Kennedy's Castle", "historic site", wiki="Maybole", description="Ruined Kennedy stronghold tied to the powerful Carrick family network around Maybole and Dunure.", address="Dunure, South Ayrshire"),
            place("Maybole Heritage Trail", "historic area", wiki="Maybole", description="Walk around the old capital of Carrick, known for its remarkable concentration of towers, castles and historic buildings.", address="Maybole town centre"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "North Ayrshire",
        "city": "Largs",
        "output_file": "largs.json",
        "default_station": "Largs",
        "places": [
            place("Vikingar!", "museum", wiki="Largs", description="Family-friendly heritage attraction exploring the Viking age and the 1263 Battle of Largs through exhibits and interpretation.", address="Greenock Road, Largs KA30 8QL"),
            place("Pencil Monument", "monument", wiki="Largs", description="Tall memorial above Largs commemorating the Battle of Largs and offering broad views over the Clyde.", address="Largs KA30 8JZ"),
            place("Largs Pier", "pier", wiki="Largs", description="Victorian pier and waterfront focal point for ferries, coastal walks and classic Clyde resort views.", address="Main Street, Largs"),
            place("Kelburn Castle", "castle", wiki="Kelburn_Castle", address="Kelburn Estate, Fairlie, Largs KA29 0BE"),
            place("Kelburn Country Park", "park", wiki="Kelburn_Castle", description="Woodland and glen walks, sculpture trails and outdoor family activities around the Kelburn estate.", address="Kelburn Estate, Fairlie, Largs KA29 0BE"),
            place("Largs Museum", "museum", wiki="Largs", description="Local museum interpreting the town's seaside, military and social history.", address="2 Manse Court, Largs KA30 8AW"),
            place("Great Cumbrae Ferry Connection", "ferry", wiki="Great_Cumbrae", description="Short ferry crossing from Largs to Great Cumbrae, making the promenade a gateway to island cycling and day trips.", address="Largs Pier, Largs"),
            place("Battle of Largs Site", "historic site", wiki="Battle_of_Largs", address="Largs seafront, Largs"),
            place("Brisbane Glen", "park", wiki="Largs", description="Leafy inland glen on the edge of town, suited to quieter walks away from the seafront.", address="Brisbane Glen Road, Largs"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "North Ayrshire",
        "city": "Isle of Arran",
        "output_file": "isle-of-arran.json",
        "default_station": "Brodick Ferry Terminal",
        "places": [
            place("Brodick Castle", "castle", wiki="Brodick_Castle", address="Brodick, Isle of Arran KA27 8HY"),
            place("Arran Heritage Museum", "museum", wiki="Isle_of_Arran", description="Local museum near Brodick with agricultural buildings, costumes and island history exhibits explaining life on Arran.", address="Brodick, Isle of Arran KA27 8DP"),
            place("Goat Fell", "mountain", wiki="Goat_Fell", address="Goat Fell, Isle of Arran"),
            place("Lochranza Castle", "castle", wiki="Lochranza_Castle", address="Lochranza, Isle of Arran KA27 8HL"),
            place("Arran Distillery", "distillery", wiki="Arran_Distillery", address="Lochranza, Isle of Arran KA27 8HJ"),
            place("Machrie Moor Stone Circles", "historic site", wiki="Machrie_Moor_Stone_Circles", address="Machrie Moor, Isle of Arran"),
            place("Glenashdale Falls", "waterfall", wiki="Glenashdale_Falls", address="Whiting Bay, Isle of Arran"),
            place("King's Cave", "historic site", wiki="Isle_of_Arran", description="Sea cave on Arran's west coast linked by tradition to Robert the Bruce and reached by a rewarding coastal walk.", address="Blackwaterfoot, Isle of Arran"),
            place("Holy Isle", "island", wiki="Lamlash", description="Dramatic island off Lamlash with a Buddhist centre, wild coastal scenery and commanding views across Arran's southeast shore.", address="Off Lamlash, Isle of Arran"),
            place("Whiting Bay", "beach", wiki="Whiting_Bay", description="Attractive bay on Arran's southeast coast, base for coastal walks and the Glenashdale Falls route.", address="Whiting Bay, Isle of Arran"),
            place("Lamlash Bay", "bay", wiki="Lamlash", description="Sheltered bay facing Holy Isle, popular for waterfront walks and one of Arran's prettiest village settings.", address="Lamlash, Isle of Arran"),
            place("String Road", "scenic route", wiki="Isle_of_Arran", description="Cross-island road climbing through open moorland and giving scenic views between Brodick and Blackwaterfoot.", address="B880, Isle of Arran"),
            place("Corrie and Sannox", "scenic area", wiki="Corrie,_Arran", description="Northern Arran villages known for sea views, mountain backdrops and access to coastal and upland walks.", address="Corrie and Sannox, Isle of Arran"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "North Ayrshire",
        "city": "Irvine",
        "output_file": "irvine-north-ayrshire.json",
        "default_station": "Irvine",
        "places": [
            place("Scottish Maritime Museum", "museum", wiki="Scottish_Maritime_Museum", address="Linthouse, Irvine Harbour, Irvine KA12 8QE"),
            place("Irvine Harbour", "harbour", wiki="Irvine,_North_Ayrshire", description="Historic harbour district blending old docks, museum spaces and waterfront walking routes.", address="Harbour Street, Irvine"),
            place("Eglinton Country Park", "park", wiki="Eglinton_Country_Park", address="Kilwinning Road, Irvine KA12 8TA"),
            place("Irvine Beach Park", "beach", wiki="Irvine,_North_Ayrshire", description="Sandy shore and dunes forming one of the best urban beach outings on the Ayrshire coast.", address="Beach Drive, Irvine"),
            place("Magnum Leisure Centre", "sports venue", wiki="Irvine,_North_Ayrshire", description="Waterside activity centre for swimming, ice sports and family recreation.", address="Harbour Street, Irvine KA12 8PP"),
            place("Ardeer Quarry Nature Reserve", "nature reserve", wiki="Ardeer", description="Wildlife-rich reserve on the Ardeer peninsula, popular with birdwatchers and walkers.", address="Ardeer, Stevenston"),
            place("Nobel Explosives Heritage", "industrial heritage", wiki="Ardeer", description="Interpretive stop for the peninsula's gunpowder and explosives manufacturing history associated with Nobel's works.", address="Ardeer Peninsula, Stevenston"),
            place("Seagate Castle", "castle", wiki="Seagate_Castle", address="Seagate, Irvine KA12 8AF"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "North Ayrshire",
        "city": "Saltcoats",
        "output_file": "saltcoats.json",
        "default_station": "Saltcoats",
        "places": [
            place("Saltcoats Beach", "beach", wiki="Saltcoats", description="Town beach and esplanade with broad sea views toward Arran and the Firth of Clyde.", address="The Esplanade, Saltcoats"),
            place("Saltcoats Museum", "museum", wiki="Saltcoats", description="Small heritage museum covering the story of Saltcoats and the Three Towns communities.", address="14 Manse Street, Saltcoats KA21 5AA"),
            place("Horse Isle Viewpoint", "viewpoint", wiki="Horse_Isle", description="Seafront viewpoint toward the small island bird sanctuary lying just offshore from Saltcoats and Ardrossan.", address="Saltcoats seafront"),
            place("Three Towns Heritage Trail", "historic area", wiki="Saltcoats", description="Coastal route linking Saltcoats, Ardrossan and Stevenston through the historic Three Towns conurbation.", address="Saltcoats, Ardrossan and Stevenston coast"),
            place("Stevenston Beach", "beach", wiki="Stevenston", description="Long sandy shoreline south of Saltcoats, popular for walking, birdlife and open views over the Clyde.", address="Stevenston Shore, Stevenston"),
        ],
    },
    {
        "region": "Ayrshire & Arran",
        "prefecture": "North Ayrshire",
        "city": "Ardrossan",
        "output_file": "ardrossan.json",
        "default_station": "Ardrossan Harbour",
        "places": [
            place("Ardrossan Castle", "castle", wiki="Ardrossan_Castle", address="Castle Hill, Ardrossan KA22"),
            place("Ardrossan Harbour", "harbour", wiki="Ardrossan", description="Important ferry and marina harbour with strong links to Arran and the wider Clyde coast.", address="Montgomerie Pier, Ardrossan"),
            place("South Beach", "beach", wiki="Ardrossan", description="Town beach and promenade stretching south of the harbour with wide views toward Arran.", address="South Crescent Road, Ardrossan"),
            place("Horse Isle Viewpoint", "viewpoint", wiki="Horse_Isle", description="Good coastal viewpoint toward the nearby island nature reserve and the busy Clyde shipping lanes.", address="Ardrossan seafront"),
            place("Arran Ferry Terminal", "ferry", wiki="Ardrossan", description="Main ferry gateway between the mainland and Brodick on Arran, making Ardrossan a classic island transfer point.", address="Ardrossan Harbour, Ardrossan"),
            place("North Shore Promenade", "park", wiki="Ardrossan", description="Quieter coastal stretch north of the harbour, useful for walking and views back toward the castle hill.", address="North Shore, Ardrossan"),
        ],
    },
]


def primary_wiki_info(wikis: list[str]) -> dict[str, Any] | None:
    for title in wikis:
        info = fetch_wiki_summary(title)
        if info.get("ok"):
            return info
    return fetch_wiki_summary(wikis[0]) if wikis else None



def build_record(city_meta: dict[str, Any], place_meta: dict[str, Any], timestamp: str) -> dict[str, Any]:
    wikis = place_meta["wikis"]
    primary_info = primary_wiki_info(wikis) if wikis else None

    description = place_meta["description"] or (primary_info or {}).get("description")
    if not description:
        description = f"Visitor attraction in {city_meta['city']}, {city_meta['prefecture']}, Scotland."

    lat = place_meta["lat"]
    lng = place_meta["lng"]
    if lat is None and primary_info:
        lat = primary_info.get("lat")
    if lng is None and primary_info:
        lng = primary_info.get("lng")

    station = place_meta["station"] or city_meta.get("default_station")
    address = place_meta["address"] or f"{city_meta['city']}, {city_meta['prefecture']}, Scotland"

    source_urls: list[str] = []
    for title in wikis:
        info = fetch_wiki_summary(title)
        url = info.get("url") or wiki_url(title)
        if url not in source_urls:
            source_urls.append(url)
    for extra in place_meta["extra_source_urls"]:
        if extra not in source_urls:
            source_urls.append(extra)

    field_sources: dict[str, str] = {}
    if source_urls:
        primary_source = source_urls[0]
        field_sources["description"] = primary_source
        if lat is not None:
            field_sources["lat"] = primary_source
        if lng is not None:
            field_sources["lng"] = primary_source
        field_sources["address"] = primary_source
        if station:
            field_sources["station"] = primary_source
    if place_meta["hours"] and place_meta["extra_source_urls"]:
        field_sources["hours"] = place_meta["extra_source_urls"][-1]

    return {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(city_meta['prefecture'])}:{nk(city_meta['city'])}:{nk(place_meta['name'])}",
        "region": city_meta["region"],
        "prefecture": city_meta["prefecture"],
        "city": city_meta["city"],
        "country": "GB",
        "name": place_meta["name"],
        "category": place_meta["category"],
        "description": description,
        "tips": [],
        "hours": place_meta["hours"],
        "hours_status": place_meta["hours_status"] or ("known" if place_meta["hours"] else "unknown"),
        "station": station,
        "google_place_id": None,
        "lat": round(lat, 6) if isinstance(lat, (int, float)) else None,
        "lng": round(lng, 6) if isinstance(lng, (int, float)) else None,
        "address": address,
        "rating": None,
        "price_level": None,
        "image_url": None,
        "badges": [],
        "source_urls": source_urls,
        "field_sources": field_sources,
        "photo": None,
        "extraction_model": SCRIPT_NAME,
        "extraction_status": "extracted",
        "validation_errors": [],
        "approved": False,
        "rejected_reason": None,
        "fetched_at": timestamp,
        "last_verified_at": timestamp,
    }



def write_files() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    written: list[tuple[str, int]] = []
    skipped: list[str] = []

    for city_meta in CITIES:
        out_path = OUTPUT_DIR / city_meta["output_file"]
        if out_path.exists():
            skipped.append(city_meta["output_file"])
            continue
        records = [build_record(city_meta, place_meta, timestamp) for place_meta in city_meta["places"]]
        payload = {"records": records}
        out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        json.loads(out_path.read_text(encoding="utf-8"))
        written.append((city_meta["output_file"], len(records)))

    print("Generated Scottish place files")
    print(f"written={len(written)} skipped={len(skipped)} unique_wiki_fetches={len(wiki_cache)}")
    for filename, count in written:
        print(f"WROTE {filename} records={count}")
    for filename in skipped:
        print(f"SKIPPED {filename}")


if __name__ == "__main__":
    write_files()
