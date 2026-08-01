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


def nk(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unknown"


def wiki_url(title: str) -> str:
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="()_,!'")
    return f"https://en.wikipedia.org/wiki/{encoded}"


_last_request_at = 0.0
_wiki_cache: dict[str, dict[str, Any]] = {}


def fetch_wiki_summary(title: str) -> dict[str, Any]:
    global _last_request_at
    if title in _wiki_cache:
        return _wiki_cache[title]

    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="()_,!'")
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
    result = {"ok": False, "url": wiki_url(title), "lat": None, "lng": None}

    for attempt in range(5):
        wait = REQUEST_DELAY - (time.time() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
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
    _wiki_cache[title] = result
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
    "falkirk.json": [
        place("Falkirk Museum and Gallery", "museum", "Falkirk", "Local museum displays and gallery spaces interpreting Falkirk's Roman, industrial and social history.", "Callendar House, Callendar Park, Falkirk FK1 1YR"),
        place("Dollar Park", "park", "Falkirk", "Traditional town park with bandstand, play areas, bowling greens and a Victorian layout close to central Falkirk.", "Dollar Park, Camelon Road, Falkirk"),
        place("Watling Lodge", "historic site", "Antonine_Wall", "Important Antonine Wall site where ditch, mound and fortlet earthworks are especially easy to read in the landscape.", "Watling Lodge, Tamfourhill, Falkirk"),
        place("Bonnyside Roman Wall", "historic site", "Antonine_Wall", "Quiet Roman frontier section near Bonnybridge with surviving embankments and a strong sense of the wall's line.", "Bonnyside, Bonnybridge, Falkirk"),
        place("Laurieston Village", "historic area", "Laurieston,_Falkirk", "Planned industrial village east of Falkirk with broad streets and heritage tied to the Carron ironworks and docks.", "Laurieston, Falkirk"),
        place("Larbert Old Church", "church", "Larbert", "Historic parish church site reflecting Larbert's older village identity before railway-era expansion.", "Denny Road, Larbert FK5 3AA", "Larbert"),
        place("Larbert House", "historic house", "Larbert", "Former country house estate remembered through surviving grounds and its role in Larbert's local history.", "Larbert, Falkirk", "Larbert"),
        place("Carron Works Heritage", "industrial heritage", "Carron_Company", "Industrial heritage stop recalling the famed Carron Company ironworks, cannon foundry and carronade production.", "Carron, Falkirk", "Larbert"),
        place("Bo'ness and Kinneil Railway", "heritage railway", "Bo'ness_and_Kinneil_Railway", "Volunteer-run heritage railway with steam and diesel trains through historic dockland and estate scenery.", "Union Street, Bo'ness EH51 9AQ", "Polmont"),
        place("Kinneil House", "historic house", "Kinneil_House", "Historic house with links to the Hamilton family and James Watt, standing within the wider Kinneil estate.", "Kinneil Estate, Bo'ness EH51 0PR", "Polmont"),
        place("Kinneil Museum", "museum", "Kinneil_House", "Small museum introducing the archaeology, industry and social history of the Kinneil estate and Bo'ness foreshore.", "Kinneil Estate, Bo'ness EH51 0PR", "Polmont"),
        place("Rosebank Distillery", "distillery", "Rosebank_distillery", "Revived Lowland whisky distillery on the canal, celebrated for its historic name and waterside setting.", "Camelon Road, Falkirk FK1 5SQ"),
        place("Airth Castle", "castle", "Airth_Castle", "Historic tower-house and later mansion in the countryside north of Falkirk, known for its long noble associations.", "Airth, Falkirk FK2 8JF", "Polmont"),
        place("Muiravonside Country Park", "park", "Falkirk", "Wooded country park with river gorge walks, ornamental gardens and family-friendly outdoor space on Falkirk's eastern side.", "The Loan, Whitecross, Falkirk EH49 6LW", "Polmont"),
        place("Polmont Woods", "forest", "Polmont", "Local woodland walking area offering peaceful trails and glimpses of the wider Avon and Union Canal landscapes.", "Polmont, Falkirk", "Polmont"),
        place("Callendar Walled Garden", "garden", "Callendar_House", "Restored walled garden area beside Callendar House, adding formal planting to the broader parkland visit.", "Callendar Park, Falkirk FK1 1YR"),
        place("Falkirk Trinity Church", "church", "Falkirk", "Prominent town-centre church and civic landmark on the High Street, continuing Falkirk's long parish tradition.", "Manse Place, Falkirk FK1 1JN"),
        place("Westquarter Glen", "park", "Falkirk", "Wooded glen on Falkirk's western side with streams, bridges and quieter local walking routes.", "Westquarter, Falkirk"),
        place("Dunipace Old Parish Church", "church", "Dunipace", "Historic church site near Denny and Bonnybridge, tied to the district's older rural communities.", "Dunipace, Falkirk", "Camelon"),
        place("Grangemouth Heritage Walk", "historic area", "Grangemouth", "Self-guided heritage area through the old canal and dock town, useful for understanding Grangemouth's industrial rise.", "Grangemouth town centre, Falkirk"),
        place("Helix Lagoon", "park", "The_Helix_(Falkirk)", "Waterside section of the Helix landscape with paths, bridges and reflective views toward the Kelpies.", "The Helix, Falkirk FK2 7ZT"),
        place("Falkirk Tunnel", "canal", "Union_Canal_(Scotland)", "Historic tunnel on the Union Canal route, linking Falkirk with one of Scotland's most impressive surviving canal engineering works.", "Union Canal, Falkirk"),
        place("Antonine Wall at Callendar Park", "historic site", "Antonine_Wall", "Stretch of the UNESCO-listed Roman frontier preserved within Callendar Park's grounds.", "Callendar Park, Falkirk FK1 1YR"),
        place("Antonine Wall at Rough Castle", "historic site", "Antonine_Wall", "Perhaps the most dramatic Antonine Wall landscape in the district, combining fort, ditch and outworks in one visit.", "Rough Castle, Bonnybridge FK4 2AA", "Camelon"),
        place("Seabegs Roman Fortlet", "historic site", "Antonine_Wall", "Smaller Roman fortlet site at Seabegs, adding archaeological depth to walks along the Antonine Wall corridor.", "Seabegs Wood, Bonnybridge, Falkirk", "Camelon"),
    ],
    "ayr.json": [
        place("Wellington Square", "historic square", "Ayr", "Elegant Georgian square near the seafront, lined with handsome terraces and long associated with civic Ayr.", "Wellington Square, Ayr"),
        place("Burns Monument Centre", "historic building", "Ayr", "Restored church building used for exhibitions and events, and one of Ayr's most distinctive civic spaces.", "Kay Park, Ayr Road, Ayr"),
        place("Heads of Ayr Farm Park", "park", "Ayr", "Popular family attraction on the coast with outdoor play areas, animal encounters and sea views toward Arran.", "Dunure Road, Ayr KA7 4LD"),
        place("Craigie House", "historic house", "Craigie_House", "Historic house and estate long associated with the Craigie district and the wider story of Ayr's southern edge.", "Craigie Road, Ayr"),
        place("Auld Brig", "bridge", "Ayr", "Famous old bridge over the River Ayr celebrated in Burns's poem The Brigs of Ayr and central to the town's story.", "Auld Brig, Ayr"),
        place("Wallace Tower", "monument", "Ayr", "Small surviving civic tower and landmark recalling older municipal Ayr and its market traditions.", "High Street, Ayr"),
        place("Ayr Citadel", "historic site", "Ayr", "Historic defensive quarter linked with Cromwell's citadel and later military use near the river mouth.", "South Harbour Street, Ayr"),
        place("Belleisle House", "historic house", "Belleisle_House", "Grand house within Belleisle Park, lending architectural interest to one of Ayr's finest green spaces.", "Doonfoot Road, Ayr KA7 4DU"),
        place("Belleisle Conservatory", "garden", "Belleisle_House", "Glasshouse and formal garden area within Belleisle Park, adding a classic Victorian park flourish.", "Belleisle Park, Ayr KA7 4DU"),
        place("Rozelle Estate Trails", "park", "Rozelle_House_Galleries", "Wooded and landscaped footpaths around the Rozelle estate, ideal for gentle walks close to Alloway.", "Rozelle Park, Ayr KA7 4NQ"),
        place("Ayr Pavilion", "historic building", "Ayr", "Longstanding seafront entertainment venue marking Ayr's development as a popular Clyde coast resort.", "The Esplanade, Ayr"),
        place("Lang Scots Mile", "walking route", "Ayr", "Classic local stroll along the seafront, prized for sunsets, sea air and easy walking between beach landmarks.", "Ayr seafront, Ayr"),
        place("Seafield Golf Course", "golf course", "Ayr", "Municipal coastal golf course south of the town, offering open views across Ayr Bay and Arran.", "Doonfoot Road, Ayr"),
        place("Burns Statue Square", "monument", "Ayr", "Busy town-centre square named for Robert Burns and a useful stop when exploring Ayr's civic core.", "Burns Statue Square, Ayr"),
        place("St John's Tower", "historic site", "Ayr", "Surviving medieval tower fragment reflecting the age and importance of old Ayr's ecclesiastical quarter.", "Ayr town centre"),
        place("New Bridge", "landmark", "Ayr", "Principal crossing over the River Ayr that frames good views back toward the harbour and old town bridges.", "New Bridge Street, Ayr"),
        place("Ayr Mercat Cross", "historic site", "Ayr", "Symbolic market-cross location evoking Ayr's long burgh history and commercial traditions.", "High Street, Ayr"),
        place("Ayr Esplanade", "walking route", "Ayr", "Wide promenade running beside the beach and Low Green, perfect for an easy seafront walk.", "The Esplanade, Ayr"),
        place("River Ayr Mouth", "viewpoint", "Ayr", "Pleasant waterside viewpoint where river, harbour and sea scenery meet at the edge of town.", "South Harbour, Ayr"),
        place("Alloway Railway Tunnel", "historic site", "Ayr", "Atmospheric old rail corridor near Alloway, now remembered as part of the area's transport heritage.", "Alloway, Ayr"),
        place("Seafield Beach", "beach", "Ayr", "Quieter stretch of Ayr's shoreline south of the main beach, good for long coastal walks.", "Seafield, Ayr"),
        place("Ayrshire Coastal Path - Ayr Section", "walking route", "Ayrshire_Coastal_Path", "Long-distance coastal trail section linking Ayr's beach, harbour, dunes and outlying shorelines.", "Ayr seafront and coast"),
        place("Gaiety Theatre", "theatre", "Ayr", "Victorian theatre and arts venue contributing to Ayr's lively cultural life in the town centre.", "Carrick Street, Ayr"),
        place("Craigie Park", "park", "Ayr", "Neighbourhood green space in the Craigie district with mature trees and a quieter local feel.", "Craigie Road, Ayr"),
        place("Belleisle Golf Course", "golf course", "Belleisle_House", "Well-known parkland course beside Belleisle Park, adding golfing heritage to the south Ayr landscape.", "Belleisle, Ayr"),
    ],
    "alloway.json": [
        place("Shanter Farm", "historic site", "Alloway", "Farm setting tied to the Tam o' Shanter story and often associated with wider Burns Country visits.", "Alloway, Ayr"),
        place("Land o' Burns Visitor Centre", "museum", "Alloway", "Burns-themed visitor stop interpreting the poet's life, characters and the surrounding countryside.", "Alloway, Ayr"),
        place("Alloway Village", "historic area", "Alloway", "Picturesque village core where many of Burns Country's best-known landmarks sit within walking distance.", "Alloway village, Ayr"),
        place("Burns Monument Lookout", "viewpoint", "Robert_Burns_Birthplace_Museum", "Pleasant viewpoint around the monument gardens with leafy views toward the Doon valley.", "Murdoch's Lone, Alloway, Ayr KA7 4PQ"),
        place("Cambusdoon House", "historic house", "Alloway", "Historic estate site near Alloway associated with the broader landscape of Burns Country and old Ayrshire families.", "Cambusdoon, Ayr"),
        place("Alloway Tunnel Greenway", "walking route", "Alloway", "Leafy path using the line of an old railway corridor on the edge of Burns Country.", "Alloway, Ayr"),
        place("Tam o' Shanter Trail", "walking route", "Alloway", "Themed route linking Alloway's kirk, bridge, monument and museum through the landscapes that inspired Burns.", "Alloway, Ayr"),
        place("Burns Memorial Gardens Walk", "garden", "Robert_Burns_Birthplace_Museum", "Short landscaped walk around the Burns Monument grounds, especially attractive in spring and summer.", "Murdoch's Lone, Alloway, Ayr KA7 4PQ"),
        place("Croy Shore", "beach", "Ayr", "Rocky and sandy shore south of Ayr, known for open sea views and access toward Electric Brae and Dunure.", "Croy Shore, South Ayrshire"),
        place("Kennedy's Pass", "viewpoint", "Turnberry_(golf_course)", "Dramatic coastal viewpoint in the Carrick area, pairing clifftop scenery with a sense of old routeways.", "Carrick coast, South Ayrshire"),
        place("Culzean Castle", "castle", "Culzean_Castle", "One of Scotland's greatest clifftop castles and a natural extension of an Alloway or Burns Country itinerary.", "Maybole KA19 8LE", "Maybole"),
        place("Culzean Country Park", "park", "Culzean_Castle", "Extensive coastal estate with gardens, woodland, beaches and sea views in the wider Burns Country region.", "Maybole KA19 8LE", "Maybole"),
        place("Culzean Beach", "beach", "Culzean_Castle", "Beach below the Culzean estate with cliffs, caves and broad Firth of Clyde views.", "Culzean, near Maybole", "Maybole"),
        place("Crossraguel Abbey", "abbey", "Crossraguel_Abbey", "Magnificent red-stone abbey ruin near Maybole, one of the richest medieval sites in south-west Scotland.", "Crossraguel, by Maybole KA19 8HQ", "Maybole"),
        place("Maybole Castle", "castle", "Maybole_Castle", "Tall urban castle on the High Street of old Carrick's capital, often paired with Burns Country touring.", "High Street, Maybole KA19 7AB", "Maybole"),
        place("Bachelors' Club", "museum", "Tarbolton", "National Trust for Scotland site in Tarbolton where Burns and friends once met, deepening the poet's local story.", "Sandgate Street, Tarbolton KA5 5RB"),
        place("Kirkoswald Village", "historic area", "Kirkoswald,_South_Ayrshire", "Attractive village associated with Burns characters, old coaching routes and nearby literary landmarks.", "Kirkoswald, South Ayrshire", "Maybole"),
        place("Kirkoswald Old Kirk", "church", "Kirkoswald,_South_Ayrshire", "Ruined kirk and kirkyard adding atmosphere to a Burns-themed detour toward the coast.", "Kirkoswald, South Ayrshire", "Maybole"),
        place("Turnberry Lighthouse", "lighthouse", "Turnberry_Lighthouse", "Classic Carrick lighthouse and golfing landmark visible on longer Burns Country coastal drives.", "Turnberry Point, Turnberry KA26 9LT", "Girvan"),
        place("Ailsa Craig Viewpoint", "viewpoint", "Ailsa_Craig", "Fine viewpoint toward Ailsa Craig, the volcanic island that dominates many South Ayrshire seascapes.", "Carrick coast, South Ayrshire"),
        place("Heads of Ayr Farm Park", "park", "Ayr", "Family-friendly coastal attraction just south of Ayr and easy to combine with Alloway village sights.", "Dunure Road, Ayr KA7 4LD", "Ayr"),
        place("Belleisle House", "historic house", "Belleisle_House", "Historic house in the parkland south of Ayr, close enough to feature on wider Alloway itineraries.", "Belleisle Park, Ayr KA7 4DU", "Ayr"),
        place("Rozelle House Galleries", "gallery", "Rozelle_House_Galleries", "Art venue and cultural stop in Rozelle Park, just north of Alloway.", "Monument Road, Ayr KA7 4NQ", "Ayr"),
        place("Maidens Harbour", "harbour", "Turnberry_(golf_course)", "Pretty little harbour village on the Carrick coast, good for views and short shoreline walks.", "Maidens, South Ayrshire", "Girvan"),
        place("Dunure Harbour", "harbour", "Dunure_Castle", "Characterful small harbour below Dunure Castle, combining boats, cliffs and the Ayrshire Coastal Path.", "Dunure, Ayr KA7 4LX", "Ayr"),
        place("Carrick Hills Viewpoint", "viewpoint", "Maybole", "Upland viewpoint in the old Carrick district with sweeping rural panoramas back toward the coast.", "Carrick Hills, South Ayrshire", "Maybole"),
        place("Greenan Shore", "beach", "Ayr", "Shoreline walk below Greenan Castle with rocky coves and classic views north to Ayr and south to Alloway.", "Greenan Shore, Ayr", "Ayr"),
        place("Low Green", "park", "Ayr", "Broad seafront lawn in Ayr that forms part of many longer Burns Country beach and town walks.", "The Esplanade, Ayr", "Ayr"),
        place("Burns Monument Centre", "historic building", "Ayr", "Striking restored church venue in Ayr, adding another Burns-associated stop near Alloway.", "Kay Park, Ayr Road, Ayr", "Ayr"),
        place("Heads of Ayr Beach", "beach", "Ayr", "Open coastal stretch south of Ayr with views toward the Carrick shore and Arran.", "Heads of Ayr, South Ayrshire", "Ayr"),
    ],
    "turnberry.json": [
        place("Culzean Beach", "beach", "Culzean_Castle", "Beautiful estate beach below the castle cliffs, reached by scenic paths through the Culzean grounds.", "Culzean, near Maybole", "Maybole"),
        place("Culzean Swan Pond", "garden", "Culzean_Castle", "Pretty ornamental water feature within the estate, surrounded by formal parkland and family paths.", "Culzean Country Park, Maybole KA19 8LE", "Maybole"),
        place("Culzean Deer Park", "park", "Culzean_Castle", "Wooded and open estate area where wildlife, long drives and big sea views define the Culzean experience.", "Culzean Country Park, Maybole KA19 8LE", "Maybole"),
        place("Eisenhower Apartment", "historic building", "Culzean_Castle", "The famous apartment gifted to General Eisenhower inside the castle, adding wartime interest to the estate.", "Culzean Castle, Maybole KA19 8LE", "Maybole"),
        place("Culzean Walled Garden", "garden", "Culzean_Castle", "Formal garden space within the estate, rewarding visitors who want more than the headline castle view.", "Culzean Country Park, Maybole KA19 8LE", "Maybole"),
        place("Caves of Culzean", "historic site", "Culzean_Castle", "Sea caves beneath the estate cliffs that add geological drama to beach walks under the castle.", "Culzean shore, South Ayrshire", "Maybole"),
        place("Maidens Beach", "beach", "Turnberry_(golf_course)", "Small coastal beach near the harbour village, with lovely views north toward Culzean.", "Maidens, South Ayrshire", "Girvan"),
        place("Croy Shore", "beach", "Ayr", "Rocky coastal strip near Electric Brae, valued for its sense of open sea and uncluttered shoreline.", "Croy Shore, South Ayrshire", "Ayr"),
        place("Turnberry Beach", "beach", "Turnberry_(golf_course)", "Broad sweep of shore below the famous links and lighthouse, with excellent Ailsa Craig views.", "Turnberry, South Ayrshire", "Girvan"),
        place("Turnberry Point", "viewpoint", "Turnberry_Lighthouse", "Headland viewpoint where golf, cliffs, lighthouse and the sea come together in classic Ayrshire style.", "Turnberry Point, South Ayrshire", "Girvan"),
        place("Souter Johnnie's Cottage", "historic house", "Kirkoswald,_South_Ayrshire", "Thatched cottage in Kirkoswald linked to Tam o' Shanter and a popular literary heritage detour.", "Main Street, Kirkoswald KA19 8HY", "Maybole"),
        place("Bachelors' Club Tarbolton", "museum", "Tarbolton", "National Trust property associated with Robert Burns and one of the most evocative literary sites in Ayrshire.", "Sandgate Street, Tarbolton KA5 5RB"),
        place("Kirkoswald Village", "historic area", "Kirkoswald,_South_Ayrshire", "Pleasant village rich in Burns connections and traditional South Ayrshire character.", "Kirkoswald, South Ayrshire", "Maybole"),
        place("Kirkoswald Old Kirk", "church", "Kirkoswald,_South_Ayrshire", "Atmospheric ruined kirk and graveyard that suit a slow heritage stop on the road to Turnberry.", "Kirkoswald, South Ayrshire", "Maybole"),
        place("Kennedy's Pass", "viewpoint", "Turnberry_(golf_course)", "Clifftop viewpoint in the Carrick coast area with a dramatic sense of the shoreline's rugged character.", "Carrick coast, South Ayrshire", "Girvan"),
        place("Ballochmyle Viaduct", "landmark", "Ballochmyle_Viaduct", "Remarkable railway viaduct over the River Ayr, included here as a classic Ayrshire engineering detour.", "Near Mauchline, East Ayrshire"),
        place("Carrick Hills Viewpoint", "viewpoint", "Maybole", "High rural viewpoint above the Carrick plain, good for understanding Turnberry's wider landscape setting.", "Carrick Hills, South Ayrshire", "Maybole"),
        place("Ailsa Craig Boat View", "viewpoint", "Ailsa_Craig", "Classic sea view location for Scotland's volcanic island landmark, especially striking in clear evening light.", "Turnberry coast, South Ayrshire", "Girvan"),
        place("Dunure Harbour", "harbour", "Dunure_Castle", "Small stone harbour full of character, sitting just below one of Ayrshire's finest castle ruins.", "Dunure, South Ayrshire", "Ayr"),
        place("Bargany Gardens", "garden", "Girvan", "Renowned private gardens in the Girvan district, especially celebrated for seasonal displays and mature plantings.", "Bargany, Girvan", "Girvan"),
        place("Glenapp Castle Viewpoint", "viewpoint", "Ballantrae", "Viewpoint area toward the grand castle hotel estate and the wilder southern end of the Ayrshire coast.", "Near Ballantrae, South Ayrshire", "Girvan"),
        place("Pinwherry Castle", "castle", "Pinwherry", "Ruined tower-house in a quiet rural setting south of Girvan, echoing the feudal history of Carrick.", "Pinwherry, South Ayrshire", "Girvan"),
        place("Lendalfoot Beach", "beach", "Lendalfoot", "Open stretch of shingle and sand on the coast south of Turnberry, framed by dramatic headlands.", "Lendalfoot, South Ayrshire", "Girvan"),
        place("Bennane Head", "viewpoint", "Lendalfoot", "Dramatic coastal viewpoint on the route south, known for cliffs, sea stacks and stormy-weather scenery.", "Bennane Head, South Ayrshire", "Girvan"),
        place("Culzean Home Farm", "historic site", "Culzean_Castle", "Part of the wider estate story, recalling the practical working landscape behind the castle's grandeur.", "Culzean estate, Maybole KA19 8LE", "Maybole"),
        place("Maybole Collegiate Church", "church", "Maybole", "Historic church site reflecting Maybole's importance as the old capital of Carrick.", "Maybole, South Ayrshire", "Maybole"),
        place("Brown Carrick Hill", "viewpoint", "Ayr", "Excellent hill walk and viewpoint above the Ayrshire coast, offering a wider panorama over Turnberry country.", "Brown Carrick Hill, South Ayrshire", "Ayr"),
        place("Turnberry Golf Academy", "sports venue", "Turnberry_(golf_course)", "Practice and coaching facility that complements the resort's championship courses and golfing reputation.", "Turnberry Resort, South Ayrshire", "Girvan"),
    ],
    "kilmarnock.json": [
        place("Johnnie Walker Bond", "industrial heritage", "Kilmarnock", "Warehouse and heritage area recalling Kilmarnock's long association with the Johnnie Walker whisky story.", "Kilmarnock town centre"),
        place("Caprington Castle", "castle", "Caprington_Castle", "Private castle and estate west of town, notable as a visible survivor of Ayrshire's landed past.", "Caprington, Kilmarnock"),
        place("Riccarton Parish Church", "church", "Kilmarnock", "Historic church in old Riccarton village, linking Kilmarnock with an earlier settlement pattern.", "Riccarton, Kilmarnock"),
        place("Howard Park", "park", "Kilmarnock", "Popular local park with open lawns, sports space and a long role in town recreation.", "Howard Park Drive, Kilmarnock"),
        place("Annanhill Golf Course", "golf course", "Kilmarnock", "Public golf course and green space on the edge of town, valued for broad views and easy play.", "Annanhill, Kilmarnock"),
        place("Kilmarnock and Troon Railway Heritage", "industrial heritage", "Kilmarnock", "Interpretive stop for one of Scotland's earliest railways, central to Kilmarnock's transport story.", "Kilmarnock town centre"),
        place("Kilmarnock Railway Station Heritage", "historic site", "Kilmarnock", "Station area reflecting the town's railway growth and its role as a major west of Scotland junction.", "Station Brae, Kilmarnock"),
        place("Craufurdland Castle", "castle", "Craufurdland_Castle", "Historic castle and estate northeast of Kilmarnock with centuries of family and regional history.", "Fenwick, East Ayrshire"),
        place("Kilmaurs Place Ruins", "historic site", "Kilmaurs", "Ruined former residence of the Earls of Glencairn, an appealing detour from Kilmarnock into older Ayrshire history.", "Kilmaurs, East Ayrshire"),
        place("Cunninghamhead Estate", "historic house", "Cunninghamhead", "Historic estate area east of Irvine and near Kilmarnock, remembered for its house and landscaped grounds.", "Near Kilmarnock, East Ayrshire"),
        place("Massey Tower", "historic building", "Kilmarnock", "Traditional old tower-house element remembered within Kilmarnock's layered urban history.", "Kilmarnock town centre"),
        place("Kay Park Bandstand", "landmark", "Kilmarnock", "Bandstand and ornamental features that help make Kay Park one of the town's classic Victorian green spaces.", "Kay Park, Kilmarnock"),
        place("Dean Castle Woodland Walk", "walking route", "Dean_Castle", "Woodland trails around the estate offering a quieter way to enjoy the Dean landscape beyond the castle itself.", "Dean Castle Country Park, Kilmarnock"),
        place("Riccarton Castle Mound", "historic site", "Kilmarnock", "Subtle earthwork site recalling older fortification and settlement around Riccarton.", "Riccarton, Kilmarnock"),
        place("Old High Kirk", "church", "Kilmarnock", "Historic church site that adds depth to the town-centre story of religion, burgh life and architecture.", "Kilmarnock town centre"),
        place("Dean Park Wetlands", "nature reserve", "Dean_Castle", "Wetland and riverside habitats within the country park, good for easy nature watching close to the castle.", "Dean Castle Country Park, Kilmarnock"),
    ],
    "irvine.json": [
        place("Harbour Arts Centre", "gallery", "Irvine,_North_Ayrshire", "Cultural venue by the waterfront hosting exhibitions, performance and community arts in a former harbour building.", "Harbour Street, Irvine"),
        place("Irvine Townhouse", "historic building", "Irvine,_North_Ayrshire", "Traditional civic building standing as a reminder of Irvine's long burgh history.", "Bridgegate, Irvine"),
        place("Fullarton Fairy Trail", "walking route", "Irvine,_North_Ayrshire", "Family-friendly woodland path in the Fullarton area with imaginative installations and easy walking.", "Fullarton Woods, Irvine"),
        place("Fullarton House Ruins", "historic site", "Irvine,_North_Ayrshire", "Ruins and surviving fragments of the old Fullarton estate in wooded parkland near the coast.", "Fullarton Woods, Irvine"),
        place("Fullarton Woods", "park", "Irvine,_North_Ayrshire", "Mature woodland park popular for walking and cycling between the town and the shore.", "Fullarton, Irvine"),
        place("Ardeer Quarry Nature Reserve", "nature reserve", "Ardeer", "Rewilded quarry landscape known for birds, wildflowers and a more remote feel than most urban coast sites.", "Ardeer, North Ayrshire"),
        place("Ardeer Peninsula", "nature reserve", "Ardeer", "Broad coastal peninsula with dunes, industrial history and significant wildlife habitats.", "Ardeer peninsula, North Ayrshire"),
        place("Trindlemoss Loch", "nature reserve", "Irvine,_North_Ayrshire", "Wetland nature area on the edge of Irvine, good for birds and gentle local walks.", "Trindlemoss, Irvine"),
        place("Irvine Old Parish Church", "church", "Irvine,_North_Ayrshire", "Historic parish church reflecting the religious and architectural history of the old burgh.", "Kirkgate, Irvine"),
        place("Beach Park Dunes", "nature reserve", "Irvine,_North_Ayrshire", "Sandy dunes and grassy shoreline habitats behind the beach, adding nature interest to a seafront visit.", "Irvine Beach Park, Irvine"),
        place("Rivergate Waterfront Walk", "walking route", "Irvine,_North_Ayrshire", "Easy walk linking the town centre with river and harbour scenery as Irvine opens toward the coast.", "Rivergate area, Irvine"),
        place("Eglinton Loch", "park", "Eglinton_Country_Park", "Scenic loch at the heart of Eglinton Country Park, surrounded by paths and estate landscapes.", "Eglinton Country Park, Irvine KA12 8TA"),
        place("The Big Idea Site", "industrial heritage", "Irvine,_North_Ayrshire", "Former innovation-centre location on the waterfront, still part of Irvine's dockland redevelopment story.", "Irvine Harbourside, Irvine"),
        place("Irvine Moor Heritage Walk", "walking route", "Irvine,_North_Ayrshire", "Local route out toward the moorland hinterland that once shaped travel and farming around the town.", "Irvine Moor, North Ayrshire"),
        place("Seagate Ramparts", "historic site", "Seagate_Castle", "Historic area around Seagate Castle where old defensive and burgh traces linger in the street pattern.", "Seagate, Irvine"),
        place("Ravenpark Golf Course", "golf course", "Irvine,_North_Ayrshire", "Local golf course and open green landscape on the edge of Irvine.", "Irvine, North Ayrshire"),
    ],
    "largs.json": [
        place("Great Cumbrae Island", "island", "Great_Cumbrae", "Short ferry trip from Largs to a beloved island day-trip destination with cycling, beaches and coastal views.", "Great Cumbrae, Firth of Clyde", "Largs"),
        place("Millport Promenade", "walking route", "Great_Cumbrae", "Classic island seafront at Millport, easily reached from Largs and perfect for a leisurely waterfront stroll.", "Millport, Great Cumbrae", "Largs"),
        place("Cathedral of the Isles", "cathedral", "Cathedral_of_the_Isles", "Tiny Gothic cathedral in Millport, often described as Britain's smallest cathedral and a highlight of a Cumbrae visit.", "College Street, Millport, Great Cumbrae", "Largs"),
        place("Garrison House", "historic building", "Great_Cumbrae", "Grand former military building in Millport that adds civic history to island excursions from Largs.", "Millport, Great Cumbrae", "Largs"),
        place("Clark Memorial Church", "church", "Clark_Memorial_Church", "Distinctive church on the seafront adding an architectural landmark to Largs promenade views.", "Bath Street, Largs KA30 8BL"),
        place("Noddsdale Water", "walking route", "Largs", "Peaceful inland walk following burn-side scenery just beyond the busier seafront.", "Noddsdale, near Largs"),
        place("Southannan Estate", "historic house", "Largs", "Historic estate area south of town, part of the older landed landscape around the Clyde coast.", "Southannan, Largs"),
        place("Brisbane House Ruins", "historic site", "Largs", "Ruined remains linked to the Brisbane family, adding another layer to Largs's older story.", "Largs, North Ayrshire"),
        place("Largs Yacht Haven", "harbour", "Largs", "Modern marina and sailing centre bringing a contemporary watersports focus to the resort town.", "Irvine Road, Largs"),
        place("Kelburn Glen", "park", "Kelburn_Castle", "Wooded gorge and trail network at the Kelburn estate, ideal for adventurous family walks.", "Kelburn Estate, Fairlie, Largs KA29 0BE"),
        place("Haylie Brae Viewpoint", "viewpoint", "Largs", "Elevated viewpoint above town with sweeping Clyde views toward Great Cumbrae and Bute.", "Haylie Brae, Largs"),
        place("Douglas Park", "park", "Largs", "Town park and recreation space offering a pleasant inland break from the promenade.", "Largs town centre"),
        place("Fairlie Castle", "castle", "Fairlie_Castle", "Small but striking castle ruin north of Largs, easily combined with a drive along the coast.", "Fairlie, North Ayrshire", "Largs"),
        place("Cumbrae Viewpoint", "viewpoint", "Great_Cumbrae", "Seafront or hillside viewpoints from Largs toward Great Cumbrae, central to the town's appeal.", "Largs, North Ayrshire"),
        place("Pencil Hill Walk", "walking route", "Battle_of_Largs", "Short climb toward the monument with rewarding views over the resort and the island-dotted Clyde.", "Largs hillside"),
        place("Skelmorlie Aisle", "church", "Skelmorlie_Aisle", "Ornate aisle and monument in nearby Largs parish history, notable for sculpture and period detail.", "Largs, North Ayrshire"),
    ],
    "prestwick.json": [
        place("Prestwick Shore Golf Walk", "walking route", "Prestwick_Golf_Club", "Easy walk along the shore and linksland that explains why Prestwick became such a famous golfing place.", "Prestwick shore and links"),
        place("Prestwick St Ninian Golf Club", "golf course", "Prestwick", "Established local golf club continuing the long golfing tradition that defines Prestwick.", "Prestwick, South Ayrshire"),
        place("Prestwick St Cuthbert Golf Club", "golf course", "Prestwick", "Another of Prestwick's historic golf clubs, adding depth to the town's world-famous sporting landscape.", "Prestwick, South Ayrshire"),
        place("Monkton Old Church", "church", "Monkton,_South_Ayrshire", "Historic church and village stop just inland from Prestwick, well suited to a short heritage detour.", "Monkton, South Ayrshire"),
        place("Adamton Country Park", "park", "Prestwick", "Open green space on the edge of Prestwick, useful for easy walks away from the shore.", "Adamton, Prestwick"),
        place("Auchincruive Estate", "historic house", "Auchincruive", "Large riverside estate associated with education, landscape gardens and notable Ayrshire architecture.", "Auchincruive, near Prestwick"),
        place("Oswald Hall", "historic building", "Auchincruive", "Key building on the Auchincruive estate, adding architectural interest to the wider grounds.", "Auchincruive Estate, near Prestwick"),
        place("Monkton and Prestwick North Church", "church", "Prestwick", "Prominent parish church serving the northern side of the town and nearby village communities.", "Prestwick, South Ayrshire"),
        place("Kingcase Parish Church", "church", "Prestwick", "Traditional parish church in the southern part of Prestwick, embedded in the town's residential heritage.", "Prestwick, South Ayrshire"),
        place("Prestwick South Parish Church", "church", "Prestwick", "Well-known local church that forms part of a walking route through old and modern Prestwick.", "Prestwick, South Ayrshire"),
        place("Ayrshire Coastal Path Prestwick", "walking route", "Ayrshire_Coastal_Path", "Long-distance coastal trail segment using Prestwick's promenade, shore and links scenery.", "Prestwick seafront"),
        place("Prestwick Toll", "historic area", "Prestwick", "Historic junction area recalling the old road network and coaching-era development of the town.", "Prestwick Toll, Prestwick"),
        place("Shaw Monument", "monument", "Prestwick", "Local memorial landmark adding a civic note to a walk around the town and its shore.", "Prestwick, South Ayrshire"),
        place("Pow Burn Walk", "walking route", "Prestwick", "Short waterside route following the burn that crosses the town on its way to the coast.", "Prestwick, South Ayrshire"),
        place("Monkton Village Heritage", "historic area", "Monkton,_South_Ayrshire", "Quiet village heritage stop with church, old buildings and a contrasting rural feel close to Prestwick Airport.", "Monkton, South Ayrshire"),
        place("St Quivox Church Ruins", "church", "Ayr", "Atmospheric church ruins inland from Prestwick, useful for a short detour into older Ayrshire history.", "St Quivox, South Ayrshire"),
        place("Prestwick Sailing Waterfront", "harbour", "Prestwick", "Seafront area where sailing culture and open views over the Clyde reinforce Prestwick's coastal character.", "Prestwick promenade and shore"),
        place("Links Road Heritage Mile", "historic area", "Prestwick_Golf_Club", "Prestwick's classic route through golf, old town and seafront architecture.", "Links Road, Prestwick"),
    ],
    "girvan.json": [
        place("Girvan Lighthouse", "lighthouse", "Girvan", "Harbour lighthouse that adds a maritime focal point to Girvan's shoreline and fishing-town character.", "Girvan Harbour, Girvan"),
        place("Water of Girvan Walk", "walking route", "Girvan", "Pleasant riverside walk following the Water of Girvan as it threads through the town toward the sea.", "Girvan, South Ayrshire"),
        place("Bargany Gardens", "garden", "Girvan", "Celebrated private gardens in the district, best known for snowdrops, daffodils and mature planting displays.", "Near Girvan, South Ayrshire"),
        place("Glenapp Castle Viewpoint", "viewpoint", "Ballantrae", "Viewpoint along the southern coast toward the grand Glenapp estate and its dramatic backdrop.", "Near Ballantrae, South Ayrshire", "Girvan"),
        place("Pinwherry Castle", "castle", "Pinwherry", "Rural ruined tower-house south of Girvan, adding a quieter castle stop beyond the better-known coast ruins.", "Pinwherry, South Ayrshire", "Girvan"),
        place("Lendalfoot Coastal Path", "walking route", "Lendalfoot", "Scenic stretch of coast south of Girvan with open views, beach access and big-headland scenery.", "Lendalfoot, South Ayrshire", "Girvan"),
        place("Bennane Head Viewpoint", "viewpoint", "Lendalfoot", "Dramatic coastal viewpoint on the route to Ballantrae, noted for cliffs and sea stacks.", "Bennane Head, South Ayrshire", "Girvan"),
        place("Shalloch on Minnoch", "mountain", "Shalloch_on_Minnoch", "Serious hillwalk in the nearby uplands, popular with experienced walkers seeking broad western views.", "Galloway hills near Girvan", "Girvan"),
        place("Girvan Golf Course", "golf course", "Girvan", "Coastal golf setting with sea air and views that fit Girvan's relaxed resort atmosphere.", "Girvan, South Ayrshire"),
        place("Stumpy Tower", "landmark", "Girvan", "Local landmark on the seafront, often noticed during walks between the beach and harbour.", "Girvan seafront, Girvan"),
        place("Killochan Castle Viewpoint", "viewpoint", "Girvan", "Rural viewpoint toward an old estate landscape inland from Girvan.", "Near Girvan, South Ayrshire"),
        place("Ballantrae Beach", "beach", "Ballantrae", "Small but attractive beach further down the coast, easy to combine with a Girvan driving route.", "Ballantrae, South Ayrshire", "Girvan"),
        place("Sawney Bean Cave Viewpoint", "viewpoint", "Lendalfoot", "Folklore-rich coastal viewpoint associated with the legendary Bennane Cave story.", "Bennane Cave area, South Ayrshire", "Girvan"),
        place("Dailly Heritage Walk", "historic area", "Girvan", "Heritage walk in the inland Carrick village of Dailly, useful for exploring the district beyond the shore.", "Dailly, South Ayrshire", "Girvan"),
        place("Turnberry Coastal View", "viewpoint", "Turnberry_(golf_course)", "Northward coastal viewpoint showing how Girvan links visually with Turnberry and Ailsa Craig.", "North of Girvan, South Ayrshire", "Girvan"),
        place("Girvan Promenade Gardens", "park", "Girvan", "Neat seafront planting and open spaces that brighten the walk between beach and harbour.", "Girvan promenade, Girvan"),
        place("Pinbain Hill Viewpoint", "viewpoint", "Ballantrae", "Wild-feeling coastal and hill viewpoint south of Girvan with fine sea panoramas.", "Pinbain, South Ayrshire", "Girvan"),
    ],
    "stranraer.json": [
        place("Corsewall Lighthouse", "lighthouse", "Corsewall_Lighthouse", "Remote lighthouse on the Rhins coast, prized for rugged scenery and birdlife.", "Corsewall Point, Kirkcolm, Stranraer"),
        place("Castle Kennedy Gardens", "garden", "Castle_Kennedy", "Famous landscaped gardens with lochs, specimen planting and ruined castle views near Stranraer.", "Castle Kennedy, Stranraer DG9 8SF"),
        place("Southern Upland Way Terminus", "walking route", "Southern_Upland_Way", "Western end of Scotland's coast-to-coast trail, making Stranraer a landmark finish or starting point.", "Stranraer seafront, Stranraer"),
        place("Loch Ryan Shore Walk", "walking route", "Loch_Ryan", "Waterside walk with seabirds, ferry views and changing light over the long sea loch.", "Loch Ryan shore, Stranraer"),
        place("Ryan Centre", "theatre", "Stranraer", "Important local arts and events venue that adds a contemporary cultural stop to the town centre.", "St John Street, Stranraer"),
        place("Cairnryan Viewpoint", "viewpoint", "Loch_Ryan", "Viewpoint over ferry traffic and the narrowing of Loch Ryan on the road north of Stranraer.", "Cairnryan, Stranraer"),
        place("Killantringan Lighthouse", "lighthouse", "Portpatrick", "Handsome lighthouse on a cliffy stretch of coast between Portpatrick and the Rhins north shore.", "Killantringan, near Portpatrick", "Stranraer"),
        place("Port Logan", "harbour", "Port_Logan", "Small harbour village with clear water, botanical links and an appealing remote-coast atmosphere.", "Port Logan, Stranraer"),
        place("Sandhead Beach", "beach", "Sandhead", "Long sandy beach and dune-backed shoreline on the west side of the Rhins.", "Sandhead, Stranraer"),
        place("Ringdoo Sands", "beach", "Sandhead", "Wild-feeling beach and dune area near Sandhead, good for quiet walks and coastal birdlife.", "Sandhead, Stranraer"),
        place("Castle Kennedy Ruins", "historic site", "Castle_Kennedy", "Ruined seat of the Kennedy family overlooking the lochs and gardens near Stranraer.", "Castle Kennedy, Stranraer"),
        place("Drummore Harbour", "harbour", "Drummore", "Colourful working harbour near the Mull of Galloway, good for adding another coastal stop to a Stranraer circuit.", "Drummore, Stranraer"),
        place("Stairhaven Coastal Circuit", "walking route", "Stairhaven", "Quiet shoreline circuit around a tiny former harbour and exposed west-facing coast.", "Stairhaven, Stranraer"),
        place("Ardwell Bay", "beach", "Drummore", "Small bay and coastal walk area on the southern Rhins with clear views and a remote feel.", "Ardwell Bay, Stranraer"),
        place("Leswalt Old Church", "church", "Leswalt", "Historic parish church site in a peaceful village north of Stranraer, adding inland heritage to the region.", "Leswalt, Stranraer"),
        place("Cairn Pat Viewpoint", "viewpoint", "Loch_Ryan", "High viewpoint area over Loch Ryan and the western approaches to Stranraer.", "Near Stranraer, Dumfries and Galloway"),
    ],
    "maybole.json": [
        place("Baltersan Castle", "castle", "Maybole", "Ruinous tower-house west of town, one of several reminders of Maybole's dense noble and defensive history.", "Near Maybole, South Ayrshire", "Maybole"),
        place("Maybole Collegiate Church", "church", "Maybole", "Historic church site reflecting the town's importance in medieval Carrick.", "Maybole town centre", "Maybole"),
        place("Carrick Hills Walk", "walking route", "Maybole", "Upland walking country above Maybole with rewarding views over coast, farmland and hill country.", "Carrick Hills, South Ayrshire", "Maybole"),
        place("Dunure Castle", "castle", "Dunure_Castle", "Dramatic ruin on the coast north of Maybole, ideal for combining with wider Carrick heritage touring.", "Dunure, Ayr KA7 4LX", "Maybole"),
        place("Blairquhan Castle Viewpoint", "viewpoint", "Maybole", "Viewpoint and estate approach area toward one of Ayrshire's grand inland castles.", "Blairquhan, South Ayrshire", "Maybole"),
        place("Kirkoswald Village", "historic area", "Kirkoswald,_South_Ayrshire", "Characterful village near Maybole with Burns associations and old coaching-road atmosphere.", "Kirkoswald, South Ayrshire", "Maybole"),
        place("Croy Shore", "beach", "Ayr", "Open coastal stop on the Carrick shore often visited on the drive between Ayr, Maybole and Turnberry.", "Croy Shore, South Ayrshire", "Maybole"),
        place("Culzean Beach", "beach", "Culzean_Castle", "Sea-level extension to a Culzean visit, with cliffs and caves below the estate.", "Culzean shore, near Maybole", "Maybole"),
        place("Brown Carrick Trails", "walking route", "Ayr", "Walking routes over Brown Carrick and nearby hills, providing longer countryside options from Maybole.", "Brown Carrick, South Ayrshire", "Maybole"),
    ],
    "isle-of-arran.json": [
        place("Sannox Bay", "beach", "Sannox", "Beautiful bay on northern Arran with mountain backdrops and one of the island's most photogenic shorelines.", "Sannox, Isle of Arran"),
        place("Corrie Harbour", "harbour", "Corrie,_Arran", "Small harbour and waterfront in Corrie, framed by cottages and the dramatic ridge of Goat Fell.", "Corrie, Isle of Arran"),
        place("Kildonan Castle", "castle", "Kildonan_Castle", "Picturesque ruined castle on Arran's south coast, beautifully placed beside the sea.", "Kildonan, Isle of Arran"),
        place("Lagg Distillery", "distillery", "Lagg_distillery", "Modern south Arran distillery celebrating the island's peated whisky tradition.", "Lagg, Isle of Arran"),
        place("Brodick Bay", "bay", "Isle_of_Arran", "Broad bay at Arran's main port, with ferry views and an immediate sense of the island's mountain scenery.", "Brodick, Isle of Arran"),
        place("Brodick Castle Gardens", "garden", "Brodick_Castle", "Celebrated formal gardens and woodland around the castle, especially noted for rhododendrons and woodland planting.", "Brodick, Isle of Arran KA27 8HY"),
        place("Lamlash Promenade", "walking route", "Lamlash", "Gentle waterfront walk facing Holy Isle, one of the most relaxing short strolls on Arran.", "Lamlash, Isle of Arran"),
        place("Holy Isle Viewpoint", "viewpoint", "Lamlash", "One of the island's most characteristic outlooks, where Arran's shore faces the distinctive shape of Holy Isle.", "Lamlash, Isle of Arran"),
        place("Clauchlands Point", "viewpoint", "Isle_of_Arran", "Scenic coastal point near Brodick offering open sea views and quieter walking away from the ferry terminal.", "Near Brodick, Isle of Arran"),
        place("Blackwaterfoot Beach", "beach", "Isle_of_Arran", "Expansive west-coast beach popular for sunset views and easy access to King's Cave country.", "Blackwaterfoot, Isle of Arran"),
        place("Arran Coastal Way", "walking route", "Isle_of_Arran", "Long-distance island route linking bays, villages, beaches and mountain-backed sections of coast.", "Around the Isle of Arran"),
        place("Glen Rosa", "walking route", "Goat_Fell", "Iconic glen and walking area north of Brodick, popular with hikers heading toward the island's granite hills.", "Glen Rosa, Isle of Arran"),
    ],
}


def build_record(existing_meta: dict[str, Any], place_meta: dict[str, Any], timestamp: str) -> dict[str, Any]:
    info = fetch_wiki_summary(place_meta["wiki"])
    source_url = info["url"]
    station = place_meta.get("station") or existing_meta.get("default_station")
    lat = info.get("lat")
    lng = info.get("lng")
    return {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(existing_meta['prefecture'])}:{nk(existing_meta['city'])}:{nk(place_meta['name'])}",
        "region": existing_meta["region"],
        "prefecture": existing_meta["prefecture"],
        "city": existing_meta["city"],
        "country": "GB",
        "name": place_meta["name"],
        "category": place_meta["category"],
        "description": place_meta["description"],
        "tips": [],
        "hours": None,
        "hours_status": "unknown",
        "station": station,
        "google_place_id": None,
        "lat": round(lat, 6) if isinstance(lat, (int, float)) else None,
        "lng": round(lng, 6) if isinstance(lng, (int, float)) else None,
        "address": place_meta["address"],
        "rating": None,
        "price_level": None,
        "image_url": None,
        "badges": [],
        "source_urls": [source_url],
        "field_sources": {
            "description": source_url,
            "address": source_url,
            **({"station": source_url} if station else {}),
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



def append_records(file_name: str, additions: list[dict[str, Any]]) -> tuple[int, int]:
    path = BASE_DIR / file_name
    data = json.loads(path.read_text(encoding="utf-8"))
    records = data["records"]
    existing_names = {record["name"].strip().lower() for record in records}
    meta = {
        "region": records[0]["region"],
        "prefecture": records[0]["prefecture"],
        "city": records[0]["city"],
        "default_station": records[0].get("station"),
    }
    timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    appended = 0
    for addition in additions:
        key = addition["name"].strip().lower()
        if key in existing_names:
            continue
        records.append(build_record(meta, addition, timestamp))
        existing_names.add(key)
        appended += 1
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return appended, len(records)



def main() -> None:
    summary: list[tuple[str, int, int]] = []
    for file_name, additions in ADDITIONS.items():
        appended, total = append_records(file_name, additions)
        summary.append((file_name, appended, total))
    print("Top-up complete")
    for file_name, appended, total in summary:
        print(f"{file_name}: appended={appended} total={total}")
    print(f"unique_wiki_fetches={len(_wiki_cache)}")


if __name__ == "__main__":
    main()
