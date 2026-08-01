import json
import math
import os
import re
import time
import html
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse, unquote
from urllib.request import Request, urlopen

BATCH_ID = "scot-pilot-2026-07-25"
OUTPUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
SCRIPT_UA = "Mozilla/5.0 (compatible; CopilotCLI/1.0; +https://github.com)"
SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"
TIMESTAMP = datetime.now(timezone.utc).isoformat(timespec="microseconds")


def nk(v: str) -> str:
    v = v.lower().strip()
    v = re.sub(r"[^a-z0-9]+", "-", v)
    return v.strip("-") or "unknown"


@dataclass(frozen=True)
class CityMeta:
    region: str
    prefecture: str
    city: str
    tier: str
    lat: float
    lng: float
    target: int
    radius_km: float


CITIES: List[CityMeta] = [
    CityMeta("Edinburgh & Lothians", "East Lothian", "North Berwick", "mid", 56.0584, -2.7229, 24, 18.0),
    CityMeta("Edinburgh & Lothians", "East Lothian", "Dunbar", "mid", 56.0000, -2.5167, 24, 18.0),
    CityMeta("Edinburgh & Lothians", "East Lothian", "Musselburgh", "mid", 55.9410, -3.0540, 24, 14.0),
    CityMeta("Edinburgh & Lothians", "East Lothian", "East Linton", "minor", 55.9867, -2.6805, 16, 18.0),
    CityMeta("Edinburgh & Lothians", "East Lothian", "Haddington", "mid", 55.9560, -2.7830, 24, 16.0),
    CityMeta("Edinburgh & Lothians", "East Lothian", "Tantallon", "minor", 56.0800, -2.6570, 16, 12.0),
    CityMeta("Edinburgh & Lothians", "Midlothian", "Dalkeith", "mid", 55.8936, -3.0686, 24, 16.0),
    CityMeta("Edinburgh & Lothians", "Midlothian", "Penicuik", "minor", 55.8293, -3.2266, 16, 18.0),
    CityMeta("Edinburgh & Lothians", "Midlothian", "Bonnyrigg", "minor", 55.8738, -3.1045, 16, 14.0),
    CityMeta("Edinburgh & Lothians", "West Lothian", "Linlithgow", "mid", 55.9750, -3.6030, 24, 18.0),
    CityMeta("Edinburgh & Lothians", "West Lothian", "South Queensferry", "major", 55.9904, -3.3987, 38, 20.0),
    CityMeta("Edinburgh & Lothians", "West Lothian", "Bathgate", "minor", 55.9039, -3.6437, 16, 15.0),
    CityMeta("Edinburgh & Lothians", "West Lothian", "Livingston", "mid", 55.9020, -3.5221, 24, 17.0),
]
CITY_BY_NAME = {c.city: c for c in CITIES}


MANUAL_SPECS: Dict[str, List[Dict[str, Any]]] = {
    "North Berwick": [
        {
            "name": "Scottish Seabird Centre",
            "category": "visitor centre",
            "description": "Harbourside marine discovery centre with immersive wildlife exhibits, seasonal boat trips, and some of the best easy-access views of Bass Rock and the Firth of Forth islands.",
            "official_urls": ["https://www.scottishseabirdcentre.org/"],
            "lat": 56.0607,
            "lng": -2.7176,
            "address": "Scottish Seabird Centre, The Harbour, North Berwick, East Lothian",
            "hours": None,
            "hours_status": "unknown",
            "station": "North Berwick",
        },
        {
            "name": "Bass Rock",
            "wiki_title": "Bass_Rock",
            "category": "landmark",
            "description": "Dramatic volcanic island rising from the outer Firth of Forth, famed for its fortress remains and one of the world's largest northern gannet colonies. Seasonal boat trips from North Berwick give close-up views of the white-clad cliffs.",
            "official_urls": ["https://www.scottishseabirdcentre.org/"],
            "address": "Bass Rock, Firth of Forth, East Lothian",
            "hours": "Boat trips usually run seasonally in spring and summer",
            "hours_status": "known",
        },
        {
            "name": "North Berwick Law",
            "wiki_title": "North_Berwick_Law",
            "category": "viewpoint",
            "description": "The town's volcanic cone is East Lothian's classic short summit walk, crowned by a whale-bone arch and sweeping views from Edinburgh to the Bass Rock.",
            "address": "North Berwick Law, North Berwick, East Lothian",
        },
        {
            "name": "National Museum of Flight",
            "wiki_title": "National_Museum_of_Flight",
            "category": "museum",
            "description": "One of Scotland's largest aviation collections, spread across a former RAF airfield with Concorde, military aircraft, and spacious wartime hangars.",
            "official_urls": ["https://www.nms.ac.uk/national-museum-of-flight/"],
            "address": "East Fortune Airfield, East Fortune, East Lothian",
        },
        {
            "name": "Dirleton Castle",
            "wiki_title": "Dirleton_Castle",
            "category": "castle",
            "description": "Atmospheric medieval stronghold with ruined towers, elegant courtyards, and one of the finest formal herbaceous gardens in Historic Environment Scotland's care.",
            "official_urls": ["https://www.historicenvironment.scot/visit/all/dirleton-castle/"],
            "lat": 56.0454,
            "lng": -2.7870,
            "address": "Dirleton Castle, Castle Hill, Dirleton, East Lothian",
        },
        {
            "name": "Yellowcraig Beach",
            "wiki_title": "Yellowcraig",
            "category": "beach",
            "description": "Broad sandy beach backed by dunes and pinewoods, with excellent island views and easy family walks to the Fidra lighthouse panorama.",
            "address": "Yellowcraig Beach, Dirleton, East Lothian",
        },
        {
            "name": "Fidra",
            "wiki_title": "Fidra",
            "category": "island",
            "description": "Wild uninhabited island off Yellowcraig, associated with a Stevenson lighthouse and often seen from the shore or sea safari trips.",
            "lat": 56.0911,
            "lng": -2.7938,
            "address": "Fidra, Firth of Forth, East Lothian",
        },
        {
            "name": "North Berwick Harbour",
            "category": "harbour",
            "description": "Compact historic harbour at the heart of the resort town, ringed by boat trips, sea views, and easy access to the High Street and seabird centre.",
            "official_urls": ["https://www.scottishseabirdcentre.org/"],
            "lat": 56.0613,
            "lng": -2.7173,
            "address": "The Harbour, North Berwick, East Lothian",
        },
        {
            "name": "John Muir Way (North Berwick section)",
            "wiki_title": "John_Muir_Way",
            "category": "park",
            "description": "Coastal long-distance path linking beaches, birdlife, and harbour views around North Berwick before continuing across East Lothian.",
            "address": "John Muir Way, North Berwick, East Lothian",
        },
        {
            "name": "Archerfield Walled Garden",
            "category": "garden",
            "description": "Stylish restored walled garden on the Archerfield estate, blending formal planting with sculpture and family-friendly grounds.",
            "official_urls": ["https://archerfieldwalledgarden.com/"],
            "lat": 56.0419,
            "lng": -2.8017,
            "address": "Archerfield Walled Garden, Dirleton, East Lothian",
        },
        {
            "name": "North Berwick Golf Club",
            "category": "golf course",
            "description": "Historic seaside club on West Links Road, renowned for classic links golf and coastal views across the Firth of Forth.",
            "official_urls": ["https://www.northberwickgolfclub.com/"],
            "lat": 56.0615,
            "lng": -2.7367,
            "address": "New Clubhouse, Beach Road, North Berwick, East Lothian",
        },
        {
            "name": "The Glen",
            "category": "park",
            "description": "Leafy public park and walk between the town centre and east beach, opening into one of North Berwick's best coastal viewpoints.",
            "lat": 56.0619,
            "lng": -2.7093,
            "address": "The Glen, North Berwick, East Lothian",
        },
    ],
    "Dunbar": [
        {
            "name": "John Muir's Birthplace",
            "category": "museum",
            "description": "Compact museum in the conservationist's old home, tracing John Muir's Dunbar childhood and the global legacy of his environmental campaigning.",
            "official_urls": ["https://www.johnmuirbirthplace.com/"],
            "lat": 56.0004,
            "lng": -2.5164,
            "address": "126 High Street, Dunbar, East Lothian",
        },
        {
            "name": "Dunbar Castle",
            "wiki_title": "Dunbar_Castle",
            "category": "castle",
            "description": "Ruined headland fortress associated with Black Agnes, commanding rugged views over the harbour and sea approaches to the old royal burgh.",
            "address": "Castle Park, Dunbar, East Lothian",
        },
        {
            "name": "Dunbar Harbour",
            "category": "harbour",
            "description": "Historic working harbour enclosed by stout stone piers, still lively with fishing boats, sea views, and access to the town's castle and battery walks.",
            "lat": 56.0001,
            "lng": -2.5129,
            "address": "Victoria Harbour, Dunbar, East Lothian",
        },
        {
            "name": "John Muir Country Park",
            "wiki_title": "John_Muir_Country_Park",
            "category": "park",
            "description": "Dunes, lagoons, grassland, and shoreline paths combine in this coastal park celebrating Dunbar's most famous son and its rich birdlife.",
            "address": "John Muir Country Park, Dunbar, East Lothian",
        },
        {
            "name": "Barns Ness Lighthouse",
            "wiki_title": "Barns_Ness_Lighthouse",
            "category": "lighthouse",
            "description": "Photogenic Stevenson-designed lighthouse standing above wave-cut cliffs east of Dunbar, popular for dramatic seascapes and coastal walks.",
            "address": "Barns Ness, Dunbar, East Lothian",
        },
        {
            "name": "Dunbar Town House Museum & Gallery",
            "category": "museum",
            "description": "Civic museum and gallery in a prominent High Street building, covering Dunbar's maritime, military, and social history.",
            "official_urls": ["https://www.eastlothian.gov.uk/info/210574/museums/12139/dunbar_town_house_museum_and_gallery"],
            "lat": 56.0007,
            "lng": -2.5153,
            "address": "High Street, Dunbar, East Lothian",
        },
        {
            "name": "Belhaven Bay",
            "wiki_title": "Belhaven_Bay",
            "category": "beach",
            "description": "Expansive sandy bay at the edge of the John Muir Country Park, widely loved for sunsets, birdlife, and the bridge-framed estuary views at low tide.",
            "lat": 55.9956,
            "lng": -2.5496,
            "address": "Belhaven Bay, Dunbar, East Lothian",
        },
    ],
    "Musselburgh": [
        {
            "name": "Musselburgh Racecourse",
            "wiki_title": "Musselburgh_Racecourse",
            "category": "sports venue",
            "description": "Scotland's seaside racecourse stages a busy flat and jumps calendar just east of the River Esk, with a long tradition of sporting spectacle.",
            "address": "Linkfield Road, Musselburgh, East Lothian",
        },
        {
            "name": "Musselburgh Links",
            "wiki_title": "Musselburgh_Links",
            "category": "golf course",
            "description": "Claiming roots in the seventeenth century, this celebrated links is one of the oldest recorded golf courses still in play anywhere in the world.",
            "address": "Musselburgh Links, Kilwinning Street, Musselburgh, East Lothian",
        },
        {
            "name": "Newhailes House & Gardens",
            "wiki_title": "Newhailes_House",
            "category": "country house",
            "description": "Stately Palladian mansion with atmospheric interiors, woodland walks, and an eighteenth-century designed landscape overlooking the Forth.",
            "official_urls": ["https://www.nts.org.uk/visit/places/newhailes"],
            "address": "Newhailes Road, Musselburgh, East Lothian",
        },
        {
            "name": "Inveresk Lodge Garden",
            "wiki_title": "Inveresk_Lodge_Garden",
            "category": "garden",
            "description": "Intimate walled National Trust garden on a sunny slope above Musselburgh, known for colourful borders, clipped hedges, and Forth views.",
            "official_urls": ["https://www.nts.org.uk/visit/places/inveresk-lodge-garden"],
            "address": "24 Inveresk Village Road, Musselburgh, East Lothian",
        },
        {
            "name": "Prestongrange Museum",
            "wiki_title": "Prestongrange_Museum",
            "category": "museum",
            "description": "Open-air industrial heritage site preserving the stories of mining, brickmaking, pottery, and power generation along the East Lothian coast.",
            "lat": 55.9605,
            "lng": -2.9801,
            "address": "Morrison's Haven, Prestonpans, East Lothian",
        },
        {
            "name": "Levenhall Links",
            "wiki_title": "Levenhall_Links",
            "category": "nature reserve",
            "description": "Coastal reserve of lagoons, grassland, and hides developed on reclaimed land, attracting winter wildfowl and easy birdwatching close to town.",
            "address": "Levenhall Links, Musselburgh, East Lothian",
        },
        {
            "name": "Fisherrow Harbour",
            "category": "harbour",
            "description": "Compact historic harbour with a marina basin, seafood boats, and access to the seafront promenade, leisure centre, and beach.",
            "lat": 55.9442,
            "lng": -3.0284,
            "address": "Fisherrow Harbour, Musselburgh, East Lothian",
        },
        {
            "name": "Brunton Theatre",
            "category": "theatre",
            "description": "Key east-of-Edinburgh performance venue with a long-running programme of theatre, music, comedy, and community events.",
            "official_urls": ["https://www.thebrunton.co.uk/"],
            "lat": 55.9413,
            "lng": -3.0505,
            "address": "Ladywell Way, Musselburgh, East Lothian",
        },
        {
            "name": "Pinkie House",
            "wiki_title": "Pinkie_House",
            "category": "historic building",
            "description": "Important Renaissance house on Musselburgh's inland edge, notable for its painted gallery and links to Scottish and British history.",
            "address": "Pinkie Road, Musselburgh, East Lothian",
        },
        {
            "name": "Lewisvale Park",
            "category": "park",
            "description": "Large community park of lawns and tree-lined paths just south of the High Street, useful for a gentler break between heritage stops.",
            "lat": 55.9387,
            "lng": -3.0430,
            "address": "Lewisvale Park, Musselburgh, East Lothian",
        },
    ],
    "East Linton": [
        {
            "name": "Preston Mill & Phantassie Doocot",
            "wiki_title": "Preston_Mill",
            "category": "historic building",
            "description": "Picture-postcard watermill with its distinctive conical roof, standing beside the River Tyne opposite a remarkable sixteenth-century doocot.",
            "official_urls": ["https://www.nts.org.uk/visit/places/preston-mill"],
            "address": "Prestonkirk, East Linton, East Lothian",
        },
        {
            "name": "Hailes Castle",
            "wiki_title": "Hailes_Castle",
            "category": "castle",
            "description": "A romantic riverside ruin tucked into a wooded loop of the Tyne, representing one of the oldest stone castles still standing in Scotland.",
            "lat": 55.9975,
            "lng": -2.6931,
            "address": "Hailes Castle, East Linton, East Lothian",
        },
        {
            "name": "Tyninghame Beach",
            "category": "beach",
            "description": "Beautifully unspoilt beach reached through estate woodland and dunes, with broad sands and peaceful views back toward Bass Rock.",
            "lat": 56.0414,
            "lng": -2.6748,
            "address": "Tyninghame Beach, Tyninghame, East Lothian",
        },
        {
            "name": "East Linton Bridge",
            "category": "bridge",
            "description": "Handsome old bridge over the River Tyne at the heart of the conservation village, a natural starting point for exploring mills and riverside walks.",
            "lat": 55.9868,
            "lng": -2.6792,
            "address": "Bridge Street, East Linton, East Lothian",
        },
        {
            "name": "John Muir Way (East Linton section)",
            "category": "park",
            "description": "Waymarked long-distance path linking village, river, and coast, ideal for a gentler walk into the surrounding East Lothian landscape.",
            "lat": 55.9867,
            "lng": -2.6805,
            "address": "John Muir Way, East Linton, East Lothian",
        },
    ],
    "Haddington": [
        {
            "name": "St Mary's Church",
            "wiki_title": "St_Mary%27s_Church,_Haddington",
            "category": "church",
            "description": "Grand collegiate church beside the Tyne, often described as one of Scotland's finest parish churches thanks to its scale, stonework, and history.",
            "lat": 55.9498,
            "lng": -2.7748,
            "address": "Sidegate, Haddington, East Lothian",
        },
        {
            "name": "John Gray Centre",
            "category": "museum",
            "description": "Haddington's combined local history museum, archives, and library, presenting East Lothian stories through changing displays and research collections.",
            "official_urls": ["https://www.johngraycentre.org/"],
            "lat": 55.9509,
            "lng": -2.7835,
            "address": "15 Lodge Street, Haddington, East Lothian",
        },
        {
            "name": "Lennoxlove House",
            "wiki_title": "Lennoxlove_House",
            "category": "country house",
            "description": "Historic seat of the Dukes of Hamilton, with centuries of royal and aristocratic associations on the edge of Haddington.",
            "official_urls": ["https://www.lennoxlove.com/"],
            "address": "Lennoxlove House, Haddington, East Lothian",
        },
        {
            "name": "Traprain Law",
            "wiki_title": "Traprain_Law",
            "category": "viewpoint",
            "description": "Volcanic hill and Iron Age stronghold rising sharply from the plain, rewarding walkers with sweeping views across East Lothian.",
            "address": "Traprain Law, East Lothian",
        },
        {
            "name": "Nungate Bridge",
            "wiki_title": "Nungate_Bridge",
            "category": "bridge",
            "description": "Historic stone bridge spanning the River Tyne on Haddington's eastern approach, tied to the old burgh's routes and mills.",
            "lat": 55.9558,
            "lng": -2.7718,
            "address": "Nungate, Haddington, East Lothian",
        },
        {
            "name": "Amisfield Walled Garden",
            "category": "garden",
            "description": "Beautifully restored community-run walled garden where formal beds, fruit, and flowers revive part of the old Amisfield estate.",
            "official_urls": ["https://amisfield.org.uk/"],
            "lat": 55.9686,
            "lng": -2.7886,
            "address": "Amisfield Walled Garden, Haddington, East Lothian",
        },
        {
            "name": "Chesters Hill Fort",
            "wiki_title": "Chesters_Hill_Fort",
            "category": "prehistoric site",
            "description": "Well-preserved Iron Age hill fort earthworks set above the Tyne valley, a rewarding stop for prehistoric Scotland enthusiasts.",
            "address": "Chesters Hill Fort, East Lothian",
        },
        {
            "name": "Yester Castle",
            "wiki_title": "Yester_Castle",
            "category": "castle",
            "description": "Atmospheric ruined castle set in woodland near Gifford, famous for the vaulted underground chamber known as the Goblin Ha'.",
            "address": "Yester Castle, Gifford, East Lothian",
        },
        {
            "name": "Haddington Golf Club",
            "category": "golf course",
            "description": "Parkland course just south of town with open outlooks toward the Lammermuirs and an established local sporting history.",
            "official_urls": ["https://www.haddingtongolfclub.com/"],
            "lat": 55.9414,
            "lng": -2.7928,
            "address": "Whittingehame Drive, Haddington, East Lothian",
        },
        {
            "name": "Poldrate Mill",
            "category": "historic building",
            "description": "Historic mill site and riverside quarter recalling Haddington's long commercial relationship with the Tyne and the burgh's eastern approaches.",
            "lat": 55.9565,
            "lng": -2.7760,
            "address": "Poldrate, Haddington, East Lothian",
        },
        {
            "name": "River Tyne Riverside Walk",
            "category": "park",
            "description": "Pleasant urban walk following the Tyne past bridges, church towers, and green edges that reveal Haddington at a slower pace.",
            "lat": 55.9529,
            "lng": -2.7791,
            "address": "Riverside Walk, Haddington, East Lothian",
        },
    ],
    "Tantallon": [
        {
            "name": "Tantallon Castle",
            "wiki_title": "Tantallon_Castle",
            "category": "castle",
            "description": "One of Scotland's most spectacular ruined fortresses, strung along the cliff edge with immense red-sandstone walls and unforgettable Bass Rock views.",
            "official_urls": ["https://www.historicenvironment.scot/visit/all/tantallon-castle/"],
            "lat": 56.0838,
            "lng": -2.6388,
            "address": "Tantallon Castle, North Berwick, East Lothian",
        },
        {
            "name": "Seacliff Beach",
            "category": "beach",
            "description": "Secluded sandy curve below the castle coast, admired for surf, dramatic cliffs, and one of the smallest harbours in Britain.",
            "lat": 56.0625,
            "lng": -2.6416,
            "address": "Seacliff Beach, East Lothian",
        },
        {
            "name": "Auldhame Castle",
            "wiki_title": "Auldhame_Castle",
            "category": "castle",
            "description": "Roofless medieval tower house standing close to the cliffs south of Tantallon, evocative even in its fragmentary state.",
            "address": "Auldhame, East Lothian",
        },
        {
            "name": "Fenton Tower",
            "wiki_title": "Fenton_Tower",
            "category": "historic building",
            "description": "Restored sixteenth-century tower house tucked inland from Tantallon's coast, associated with James VI and East Lothian's lairdly history.",
            "address": "Kingston, North Berwick, East Lothian",
        },
        {
            "name": "Canty Bay",
            "category": "beach",
            "description": "Small coastal bay and headland viewpoint looking north to Bass Rock and west toward the castle walls above the cliffs.",
            "lat": 56.0840,
            "lng": -2.6542,
            "address": "Canty Bay, East Lothian",
        },
        {
            "name": "Bass Rock Viewpoint",
            "category": "viewpoint",
            "description": "Clifftop viewing area near Tantallon where the Bass Rock seems to float offshore above busy seabird waters.",
            "lat": 56.0829,
            "lng": -2.6460,
            "address": "Tantallon coast, East Lothian",
        },
        {
            "name": "Seacliff Harbour",
            "category": "harbour",
            "description": "Tiny hand-cut harbour tucked beneath the cliffs, often claimed as the smallest working harbour in Britain.",
            "official_urls": ["https://www.seacliff.scot/"],
            "lat": 56.0638,
            "lng": -2.6413,
            "address": "Seacliff, East Lothian",
        },
        {
            "name": "St Baldred's Cave",
            "category": "landmark",
            "description": "Sea cave and pilgrimage site connected in local tradition with St Baldred, reached along the dramatic cliff-fringed coast.",
            "lat": 56.0624,
            "lng": -2.6444,
            "address": "St Baldred's Cave, East Lothian",
        },
        {
            "name": "Ravensheugh Sands",
            "category": "beach",
            "description": "Quieter strip of sand and rock platforms below the castle coast, appealing to walkers and photographers on fair-weather days.",
            "lat": 56.0695,
            "lng": -2.6462,
            "address": "Ravensheugh Sands, East Lothian",
        },
        {
            "name": "Gin Head",
            "category": "viewpoint",
            "description": "Prominent headland above the Tantallon shoreline, rewarding short walks with expansive sea and island views.",
            "lat": 56.0706,
            "lng": -2.6387,
            "address": "Gin Head, East Lothian",
        },
        {
            "name": "Fidra",
            "wiki_title": "Fidra",
            "category": "island",
            "description": "Offshore island and Stevenson lighthouse view that adds another classic East Lothian seascape to the Tantallon coast drive.",
            "lat": 56.0911,
            "lng": -2.7938,
            "address": "Fidra, Firth of Forth, East Lothian",
        },
        {
            "name": "Dirleton Castle",
            "wiki_title": "Dirleton_Castle",
            "category": "castle",
            "description": "Major nearby medieval ruin with gardens, easily paired with Tantallon for a fuller East Lothian castle day.",
            "lat": 56.0454,
            "lng": -2.7870,
            "address": "Dirleton Castle, Dirleton, East Lothian",
        },
        {
            "name": "Yellowcraig Beach",
            "wiki_title": "Yellowcraig",
            "category": "beach",
            "description": "Broad popular beach west of the castle coast, valued for dunes, woodland edge, and postcard views to Fidra.",
            "address": "Yellowcraig Beach, Dirleton, East Lothian",
        },
        {
            "name": "North Berwick Law",
            "wiki_title": "North_Berwick_Law",
            "category": "viewpoint",
            "description": "Distinct volcanic cone whose summit panorama helps place the whole Tantallon shoreline and islands in context.",
            "address": "North Berwick Law, East Lothian",
        },
    ],
    "Dalkeith": [
        {
            "name": "Dalkeith Country Park",
            "category": "park",
            "description": "Large estate park of river walks, giant trees, adventure spaces, and scenic approaches to Dalkeith Palace on the Buccleuch family's historic lands.",
            "official_urls": ["https://www.dalkeithcountrypark.co.uk/"],
            "lat": 55.8931,
            "lng": -3.0535,
            "address": "Dalkeith Country Park, Dalkeith, Midlothian",
        },
        {
            "name": "Dalkeith Palace",
            "wiki_title": "Dalkeith_Palace",
            "category": "country house",
            "description": "Grand eighteenth-century palace set deep within parkland, replacing earlier castle structures and remaining one of Midlothian's standout noble residences.",
            "address": "Dalkeith Country Park, Dalkeith, Midlothian",
        },
        {
            "name": "National Mining Museum Scotland",
            "wiki_title": "National_Mining_Museum_Scotland",
            "category": "museum",
            "description": "Former Lady Victoria Colliery turned major industrial museum, with pithead gear, machinery, and the human stories of Scotland's coalfield communities.",
            "address": "Newtongrange, Midlothian",
        },
        {
            "name": "Newbattle Abbey",
            "wiki_title": "Newbattle_Abbey",
            "category": "historic building",
            "description": "Once a Cistercian abbey and later a stately house, now a richly layered historic campus surrounded by woodland and the River South Esk.",
            "address": "Newbattle Road, Dalkeith, Midlothian",
        },
        {
            "name": "Vogrie Country Park",
            "wiki_title": "Vogrie_Country_Park",
            "category": "park",
            "description": "Popular Midlothian country park offering mansion views, landscaped grounds, woodland trails, and family-friendly outdoor space.",
            "address": "Vogrie Country Park, Gorebridge, Midlothian",
        },
        {
            "name": "Cousland Smiddy",
            "wiki_title": "Cousland_Smiddy",
            "category": "museum",
            "description": "Preserved village smithy that vividly evokes the craft traditions once central to rural Midlothian life.",
            "lat": 55.9108,
            "lng": -3.0188,
            "address": "Cousland, Midlothian",
        },
    ],
    "Penicuik": [
        {
            "name": "Penicuik House",
            "wiki_title": "Penicuik_House",
            "category": "historic building",
            "description": "Romantic classical ruin within a broad designed landscape, recalling the ambition of the Clerks of Penicuik and their Enlightenment estate.",
            "address": "Penicuik Estate, Midlothian",
        },
        {
            "name": "Pentland Hills Regional Park",
            "wiki_title": "Pentland_Hills",
            "category": "park",
            "description": "Big skies, moorland ridges, reservoirs, and easy access from the town make the Pentlands one of the capital region's great walking landscapes.",
            "address": "Pentland Hills Regional Park, Midlothian",
        },
        {
            "name": "Glencorse Reservoir",
            "wiki_title": "Glencorse_Reservoir",
            "category": "park",
            "description": "Scenic reservoir and woodland fringe below the Pentlands, popular for reflective waterside walks and hill photography.",
            "address": "Glencorse Reservoir, Midlothian",
        },
        {
            "name": "Loganlea Reservoir",
            "wiki_title": "Loganlea_Reservoir",
            "category": "park",
            "description": "Quiet upland reservoir framed by Pentland slopes, ideal for a short scenic stop before heading onto longer hill routes.",
            "address": "Loganlea Reservoir, Midlothian",
        },
        {
            "name": "Harlaw Reservoir",
            "wiki_title": "Harlaw_Reservoir",
            "category": "park",
            "description": "Popular reservoir walk on the northern side of the Pentlands, with easy paths, birdlife, and broad water views.",
            "address": "Harlaw Reservoir, Midlothian",
        },
        {
            "name": "Valleyfield Woodland Park",
            "category": "park",
            "description": "Leafy local parkland in Penicuik with waymarked paths and fine viewpoints back toward the Pentland ridge.",
            "lat": 55.8299,
            "lng": -3.2311,
            "address": "Valleyfield Woodland Park, Penicuik, Midlothian",
        },
    ],
    "Bonnyrigg": [
        {
            "name": "Rosslyn Chapel",
            "wiki_title": "Rosslyn_Chapel",
            "category": "church",
            "description": "World-famous late medieval chapel dense with carved symbolism, beautiful stonework, and centuries of legend in the glen above the North Esk.",
            "official_urls": ["https://www.rosslynchapel.com/visit/"],
            "address": "Rosslyn Chapel, Roslin, Midlothian",
        },
        {
            "name": "Rosslyn Castle",
            "wiki_title": "Rosslyn_Castle",
            "category": "castle",
            "description": "Romantic ruined castle perched above Rosslyn Glen, once a seat of the St Clair family and still dramatic from the riverside paths.",
            "address": "Rosslyn Castle, Roslin, Midlothian",
        },
        {
            "name": "Roslin Glen Country Park",
            "wiki_title": "Roslin_Glen",
            "category": "park",
            "description": "Wooded gorge of the River North Esk with footpaths, rocky viewpoints, and a memorable sequence of heritage sites around Roslin.",
            "lat": 55.8570,
            "lng": -3.1365,
            "address": "Roslin Glen Country Park, Roslin, Midlothian",
        },
        {
            "name": "Hawthornden Castle",
            "wiki_title": "Hawthornden_Castle",
            "category": "historic building",
            "description": "Storied riverside castle long associated with poets and literary retreat culture, seen to best effect from glen walks rather than from inside.",
            "address": "Hawthornden, Midlothian",
        },
        {
            "name": "Butterfly & Insect World",
            "category": "visitor centre",
            "description": "Family attraction with tropical butterfly house and insect displays, adding an indoor wildlife option close to Bonnyrigg and Roslin.",
            "official_urls": ["https://www.dobbies.com/our-centres/butterfly-and-insect-world/"],
            "lat": 55.8628,
            "lng": -3.1224,
            "address": "Dobbie's Garden Centre, Melville Nursery, Lasswade, Midlothian",
        },
    ],
    "Linlithgow": [
        {
            "name": "Linlithgow Palace",
            "wiki_title": "Linlithgow_Palace",
            "category": "palace",
            "description": "Magnificent royal ruin beside the loch, famous as Mary Queen of Scots' birthplace and one of the most evocative Renaissance palaces in Scotland.",
            "official_urls": ["https://www.historicenvironment.scot/visit/all/linlithgow-palace/"],
            "address": "Linlithgow Palace, Linlithgow, West Lothian",
        },
        {
            "name": "St Michael's Parish Church",
            "wiki_title": "St_Michael%27s_Church,_Linlithgow",
            "category": "church",
            "description": "Landmark burgh church beside the palace, instantly recognisable for its striking modern crown spire and centuries of civic history.",
            "lat": 55.9775,
            "lng": -3.6034,
            "address": "Kirkgate, Linlithgow, West Lothian",
        },
        {
            "name": "Linlithgow Loch",
            "wiki_title": "Linlithgow_Loch",
            "category": "park",
            "description": "Wildfowl-rich loch edging the palace peel, ideal for an easy waterside circuit with memorable reflections of Linlithgow's skyline.",
            "lat": 55.9802,
            "lng": -3.6069,
            "address": "Linlithgow Loch, Linlithgow, West Lothian",
        },
        {
            "name": "Blackness Castle",
            "wiki_title": "Blackness_Castle",
            "category": "castle",
            "description": "Powerful shore fortress projecting into the Forth like a stone ship, with ramparts that frame the bridges and estuary beyond.",
            "official_urls": ["https://www.historicenvironment.scot/visit/all/blackness-castle/"],
            "address": "Blackness Castle, Blackness, West Lothian",
        },
        {
            "name": "House of the Binns",
            "wiki_title": "House_of_the_Binns",
            "category": "country house",
            "description": "National Trust house and estate commanding fine Forth views, packed with family history, collections, and attractive woodland walks.",
            "official_urls": ["https://www.nts.org.uk/visit/places/house-of-the-binns"],
            "address": "Binns View, Linlithgow, West Lothian",
        },
        {
            "name": "Beecraigs Country Park",
            "wiki_title": "Beecraigs_Country_Park",
            "category": "park",
            "description": "Forested hill park above Linlithgow with lochs, cycling and walking routes, and wide views over central Scotland.",
            "lat": 55.9638,
            "lng": -3.6680,
            "address": "Beecraigs Country Park, Linlithgow, West Lothian",
        },
        {
            "name": "Linlithgow Canal Centre",
            "category": "visitor centre",
            "description": "Friendly canal-side hub for boat trips, kayaking, and interpretation of the Union Canal's engineering and leisure heritage.",
            "official_urls": ["https://www.re-uk.org/project/linlithgow-canal-centre/"],
            "lat": 55.9752,
            "lng": -3.5895,
            "address": "Manse Road Basin, Linlithgow, West Lothian",
        },
    ],
    "South Queensferry": [
        {
            "name": "Forth Bridge",
            "wiki_title": "Forth_Bridge",
            "category": "bridge",
            "description": "Iconic red cantilever railway bridge and UNESCO World Heritage Site, dominating every waterfront view in South Queensferry.",
            "address": "Forth Bridge, South Queensferry, West Lothian",
        },
        {
            "name": "Queensferry Crossing",
            "wiki_title": "Queensferry_Crossing",
            "category": "bridge",
            "description": "Elegant modern cable-stayed crossing that adds a contemporary counterpart to the older Forth bridges on the same dramatic estuary stage.",
            "address": "Queensferry Crossing, South Queensferry, West Lothian",
        },
        {
            "name": "Forth Road Bridge",
            "wiki_title": "Forth_Road_Bridge",
            "category": "bridge",
            "description": "Landmark suspension bridge whose deck and towers remain a defining part of the Queensferry skyline.",
            "address": "Forth Road Bridge, South Queensferry, West Lothian",
        },
        {
            "name": "Deep Sea World",
            "category": "visitor centre",
            "description": "Marine attraction on the waterfront best known for its long underwater tunnel, sharks, rays, and strong bridge views from the shore.",
            "official_urls": ["https://www.deepseaworld.com/visitor-information/opening-times/"],
            "lat": 55.9885,
            "lng": -3.4048,
            "address": "Forthside Terrace, South Queensferry, West Lothian",
        },
        {
            "name": "Hopetoun House",
            "wiki_title": "Hopetoun_House",
            "category": "country house",
            "description": "One of Scotland's grandest stately homes, set in expansive designed landscape above the Forth and famed for architecture, interiors, and grounds.",
            "official_urls": ["https://hopetoun.co.uk/"],
            "address": "Hopetoun House, South Queensferry, West Lothian",
        },
        {
            "name": "Inchcolm Abbey",
            "wiki_title": "Inchcolm_Abbey",
            "category": "abbey",
            "description": "Remarkably complete island abbey reached by boat, combining monastic ruins, military layers, and memorable views back to the bridges.",
            "address": "Inchcolm Island, Firth of Forth",
        },
        {
            "name": "Port Edgar Marina",
            "category": "harbour",
            "description": "Busy marina and watersports base below the road bridge, offering some of the town's best close-up views of the engineering trio across the Forth.",
            "official_urls": ["https://www.portedgar.co.uk/"],
            "lat": 55.9918,
            "lng": -3.4071,
            "address": "Port Edgar Marina, South Queensferry, West Lothian",
        },
        {
            "name": "Priory Church",
            "wiki_title": "Priory_Church,_South_Queensferry",
            "category": "church",
            "description": "Historic waterfront church linked to medieval ferry traffic and pilgrimage, standing prominently on the cobbled High Street.",
            "address": "The Loan, South Queensferry, West Lothian",
        },
        {
            "name": "South Queensferry Tolbooth",
            "wiki_title": "South_Queensferry_Tolbooth",
            "category": "historic building",
            "description": "Civic landmark on the High Street, preserving the burgh's mercantile past and now housing local heritage interpretation.",
            "address": "High Street, South Queensferry, West Lothian",
        },
    ],
    "Bathgate": [
        {
            "name": "Cairnpapple Hill",
            "wiki_title": "Cairnpapple_Hill",
            "category": "prehistoric site",
            "description": "Major Neolithic and Bronze Age ceremonial site on a breezy summit with some of West Lothian's broadest views.",
            "official_urls": ["https://www.historicenvironment.scot/visit/all/cairnpapple-hill/"],
            "address": "Cairnpapple Hill, Bathgate, West Lothian",
        },
        {
            "name": "Torphichen Preceptory",
            "wiki_title": "Torphichen_Preceptory",
            "category": "historic building",
            "description": "Rare Scottish remnant of the Knights Hospitaller, preserving an important fragment of crusading and medieval ecclesiastical history.",
            "address": "Torphichen, West Lothian",
        },
        {
            "name": "Bennie Museum",
            "category": "museum",
            "description": "Small local history museum telling Bathgate's story through archaeology, industry, and community memorabilia.",
            "official_urls": ["https://www.benniemuseum.org.uk/"],
            "lat": 55.9028,
            "lng": -3.6449,
            "address": "9 Mansefield Street, Bathgate, West Lothian",
        },
        {
            "name": "Kirkton Public Park",
            "category": "park",
            "description": "Victorian-style public park in the heart of Bathgate, with mature planting and an easy central green retreat.",
            "lat": 55.9009,
            "lng": -3.6448,
            "address": "Kirkton Park, Bathgate, West Lothian",
        },
        {
            "name": "Balbardie Park of Peace",
            "category": "park",
            "description": "Quiet landscaped parkland combining memorial planting with a pleasant local walking circuit.",
            "lat": 55.8997,
            "lng": -3.6458,
            "address": "Balbardie Park of Peace, Bathgate, West Lothian",
        },
    ],
    "Livingston": [
        {
            "name": "Almond Valley Heritage Centre",
            "category": "museum",
            "description": "Family-friendly heritage centre set around former industrial buildings, mixing local history, animals, and riverside grounds.",
            "official_urls": ["https://www.almondvalley.co.uk/"],
            "lat": 55.8936,
            "lng": -3.5450,
            "address": "Millfield, Livingston, West Lothian",
        },
        {
            "name": "Five Sisters Zoo",
            "wiki_title": "Five_Sisters_Zoo",
            "category": "wildlife park",
            "description": "Well-known independent zoo with a broad animal collection and a strong local profile as a family day out in West Lothian.",
            "official_urls": ["https://fivesisterszoo.co.uk/"],
            "address": "Gavieside, West Calder, West Lothian",
        },
        {
            "name": "Almondell & Calderwood Country Park",
            "wiki_title": "Almondell_and_Calderwood_Country_Park",
            "category": "park",
            "description": "Riverside country park of mature woodland, bridges, and old estate traces along the winding River Almond.",
            "address": "Almondell Road, Broxburn, West Lothian",
        },
        {
            "name": "Howden Park Centre",
            "category": "theatre",
            "description": "Livingston's main arts venue, hosting theatre, exhibitions, film, and community events beside the formal grounds of Howden House.",
            "official_urls": ["https://www.howdenparkcentre.co.uk/"],
            "lat": 55.8861,
            "lng": -3.5387,
            "address": "Howden Park Centre, Howden, Livingston, West Lothian",
        },
        {
            "name": "Jupiter Artland",
            "wiki_title": "Jupiter_Artland",
            "category": "gallery",
            "description": "Major contemporary sculpture park and gallery set in landscaped grounds just west of Edinburgh, rewarding slow exploration outdoors.",
            "official_urls": ["https://www.jupiterartland.org/"],
            "address": "Bonnington House Steadings, Wilkieston, West Lothian",
        },
        {
            "name": "Dechmont Law",
            "wiki_title": "Dechmont_Law",
            "category": "viewpoint",
            "description": "Tree-lined hill rising above Livingston, offering a quick elevated walk with broad views across the central belt.",
            "address": "Dechmont Law, Livingston, West Lothian",
        },
    ],
}

OFFICIAL_BY_WIKI_TITLE: Dict[str, List[str]] = {
    "National_Museum_of_Flight": ["https://www.nms.ac.uk/national-museum-of-flight/"],
    "Dirleton_Castle": ["https://www.historicenvironment.scot/visit/all/dirleton-castle/"],
    "John_Muir_Country_Park": ["https://www.visitscotland.com/info/see-do/john-muir-country-park-p246751"],
    "Musselburgh_Racecourse": ["https://www.musselburgh-racecourse.co.uk/"],
    "Musselburgh_Links": ["https://www.musselburgholdlinks.com/"],
    "Preston_Mill": ["https://www.nts.org.uk/visit/places/preston-mill"],
    "Rosslyn_Chapel": ["https://www.rosslynchapel.com/visit/"],
    "Linlithgow_Palace": ["https://www.historicenvironment.scot/visit/all/linlithgow-palace/"],
    "Blackness_Castle": ["https://www.historicenvironment.scot/visit/all/blackness-castle/"],
    "Forth_Bridge": ["https://www.theforthbridges.org/"],
    "Queensferry_Crossing": ["https://www.theforthbridges.org/"],
    "Forth_Road_Bridge": ["https://www.theforthbridges.org/"],
    "Hopetoun_House": ["https://hopetoun.co.uk/"],
    "Inchcolm_Abbey": ["https://www.historicenvironment.scot/visit/all/inchcolm-abbey-and-island/"],
    "Cairnpapple_Hill": ["https://www.historicenvironment.scot/visit/all/cairnpapple-hill/"],
    "Torphichen_Preceptory": ["https://www.historicenvironment.scot/visit/all/torphichen-preceptory/"],
    "Jupiter_Artland": ["https://www.jupiterartland.org/"],
}

CATEGORY_OVERRIDES: Dict[str, str] = {
    "Bass Rock": "landmark",
    "North Berwick Law": "viewpoint",
    "Yellowcraig": "beach",
    "Fidra": "island",
    "Craigleith": "island",
    "Tantallon Castle": "castle",
    "Dunbar Castle": "castle",
    "John Muir's Birthplace": "museum",
    "Belhaven Bay": "beach",
    "Musselburgh Links": "golf course",
    "Musselburgh Racecourse": "sports venue",
    "Prestongrange Museum": "museum",
    "Preston Mill": "historic building",
    "Hailes Castle": "castle",
    "Traprain Law": "viewpoint",
    "Nungate Bridge": "bridge",
    "Chesters Hill Fort": "prehistoric site",
    "Dalkeith Palace": "country house",
    "National Mining Museum Scotland": "museum",
    "Newbattle Abbey": "historic building",
    "Rosslyn Chapel": "church",
    "Rosslyn Castle": "castle",
    "Roslin Glen": "park",
    "Linlithgow Palace": "palace",
    "St Michael's Church, Linlithgow": "church",
    "Blackness Castle": "castle",
    "Forth Bridge": "bridge",
    "Queensferry Crossing": "bridge",
    "Forth Road Bridge": "bridge",
    "Inchcolm Abbey": "abbey",
    "South Queensferry Tolbooth": "historic building",
    "Cairnpapple Hill": "prehistoric site",
    "Torphichen Preceptory": "historic building",
    "Five Sisters Zoo": "wildlife park",
    "Jupiter Artland": "gallery",
}

STATION_HINTS: Dict[str, str] = {
    "North Berwick": "North Berwick",
    "Dunbar": "Dunbar",
    "Musselburgh": "Musselburgh",
    "East Linton": "East Linton",
    "Linlithgow": "Linlithgow",
    "South Queensferry": "Dalmeny",
    "Bathgate": "Bathgate",
    "Livingston": "Livingston North",
}

CITY_FALLBACK_SOURCE: Dict[str, str] = {
    "North Berwick": "https://www.scottishseabirdcentre.org/",
    "Dunbar": "https://www.johnmuirbirthplace.com/",
    "Musselburgh": "https://www.nts.org.uk/visit/places/newhailes",
    "East Linton": "https://www.nts.org.uk/visit/places/preston-mill",
    "Haddington": "https://www.johngraycentre.org/",
    "Tantallon": "https://www.historicenvironment.scot/visit/all/tantallon-castle/",
    "Dalkeith": "https://www.dalkeithcountrypark.co.uk/",
    "Penicuik": "https://en.wikipedia.org/wiki/Pentland_Hills",
    "Bonnyrigg": "https://www.rosslynchapel.com/visit/",
    "Linlithgow": "https://www.historicenvironment.scot/visit/all/linlithgow-palace/",
    "South Queensferry": "https://www.theforthbridges.org/",
    "Bathgate": "https://www.historicenvironment.scot/visit/all/cairnpapple-hill/",
    "Livingston": "https://www.almondvalley.co.uk/",
}

INCLUDE_KEYWORDS = [
    "castle", "palace", "abbey", "church", "chapel", "cathedral", "museum", "gallery", "park", "garden",
    "beach", "bay", "harbour", "harbor", "bridge", "golf", "law", "hill", "rock", "island", "loch",
    "reserve", "visitor", "centre", "center", "lighthouse", "monument", "theatre", "arts", "tower",
    "fort", "fortress", "house", "estate", "glen", "woods", "canal", "aqueduct", "zoo", "racecourse",
    "country park", "distillery", "marina", "pier", "cave", "reservoir", "peel", "links", "battery",
    "harbor", "historic", "priory", "doocot", "smiddy", "tolbooth", "cairn", "muir", "walkway"
]
EXCLUDE_KEYWORDS = [
    "town in", "village in", "hamlet in", "human settlement", "radio station", "company", "school",
    "football club", "rugby club", "constituency", "ward", "album", "person", "university", "airport",
    "hospital", "shopping centre", "retail park", "motorway", "road in", "parliamentary", "election",
    "liqueur", "railway station", "former railway station", "railway station served",
    "civic centre", "council area of scotland", "institute of theatre", "barracks"
]


def http_get(url: str, accept: Optional[str] = None, retries: int = 3, sleep_seconds: int = 70) -> str:
    headers = {"User-Agent": SCRIPT_UA}
    if accept:
        headers["Accept"] = accept
    req = Request(url, headers=headers)
    for attempt in range(retries):
        try:
            with urlopen(req, timeout=90) as resp:
                return resp.read().decode("utf-8", "ignore")
        except HTTPError as exc:
            if exc.code in {429, 500, 502, 503, 504} and attempt < retries - 1:
                time.sleep(sleep_seconds if exc.code == 429 else 20)
                continue
            raise
        except URLError:
            if attempt < retries - 1:
                time.sleep(5)
                continue
            raise


def sparql_candidates_for_city(city: CityMeta) -> List[Dict[str, Any]]:
    radius = max(city.radius_km * 1.9, 14.0)
    query = f'''
SELECT ?itemLabel ?article ?coord ?desc ?distance WHERE {{
  SERVICE wikibase:around {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point({city.lng} {city.lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "{radius}" .
    bd:serviceParam wikibase:distance ?distance .
  }}
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  OPTIONAL {{ ?item schema:description ?desc FILTER(LANG(?desc) = "en") }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
ORDER BY ?distance
LIMIT 260
'''.strip()
    url = SPARQL_ENDPOINT + "?" + urlencode({"format": "json", "query": query})
    raw = http_get(url, accept="application/sparql-results+json", retries=4, sleep_seconds=75)
    data = json.loads(raw)
    out: List[Dict[str, Any]] = []
    for row in data["results"]["bindings"]:
        label = row.get("itemLabel", {}).get("value")
        article = row.get("article", {}).get("value")
        coord = row.get("coord", {}).get("value")
        desc = row.get("desc", {}).get("value", "")
        if not label or not article or not coord:
            continue
        m = re.match(r"Point\(([-0-9.]+) ([-0-9.]+)\)", coord)
        if not m:
            continue
        lon = float(m.group(1))
        lat = float(m.group(2))
        out.append({
            "name": label,
            "article": article,
            "wiki_title": unquote(urlparse(article).path.split("/wiki/")[-1]),
            "lat": lat,
            "lng": lon,
            "desc": desc,
            "distance_hint": float(row.get("distance", {}).get("value", 0.0)),
        })
    return out


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def clean_text(text: str) -> str:
    text = re.sub(r"\[[0-9]+\]", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def trim_sentences(text: str, max_chars: int = 320) -> str:
    text = clean_text(text)
    parts = re.split(r"(?<=[.!?])\s+", text)
    out = []
    total = 0
    for part in parts:
        if not part:
            continue
        if total + len(part) + (1 if out else 0) > max_chars and out:
            break
        out.append(part)
        total += len(part) + (1 if out else 0)
        if len(out) >= 2:
            break
    return " ".join(out) if out else text[:max_chars].rstrip()


def infer_category(name: str, desc: str) -> str:
    if name in CATEGORY_OVERRIDES:
        return CATEGORY_OVERRIDES[name]
    t = f"{name} {desc}".lower()
    checks = [
        ("distillery", "distilleries"),
        ("zoo", "wildlife park"),
        ("racecourse", "sports venue"),
        ("golf", "golf course"),
        ("museum", "museum"),
        ("gallery", "gallery"),
        ("theatre", "theatre"),
        ("arts centre", "theatre"),
        ("visitor", "visitor centre"),
        ("abbey", "abbey"),
        ("cathedral", "cathedral"),
        ("church", "church"),
        ("chapel", "church"),
        ("priory", "church"),
        ("castle", "castle"),
        ("palace", "palace"),
        ("bridge", "bridge"),
        ("harbour", "harbour"),
        ("harbor", "harbour"),
        ("marina", "harbour"),
        ("lighthouse", "lighthouse"),
        ("beach", "beach"),
        ("bay", "beach"),
        ("garden", "garden"),
        ("country park", "park"),
        ("park", "park"),
        ("woods", "park"),
        ("glen", "park"),
        ("loch", "park"),
        ("reservoir", "park"),
        ("law", "viewpoint"),
        ("hill", "viewpoint"),
        ("rock", "landmark"),
        ("island", "island"),
        ("monument", "monument"),
        ("memorial", "monument"),
        ("aqueduct", "railway"),
        ("railway", "railway"),
        ("canal", "railway"),
        ("fort", "historic site"),
        ("tower", "historic building"),
        ("house", "country house"),
    ]
    for key, value in checks:
        if key in t:
            return value
    return "landmark"


def keep_candidate(name: str, desc: str) -> bool:
    t = f"{name} {desc}".lower()
    if any(x in t for x in EXCLUDE_KEYWORDS):
        return False
    if "disambiguation" in t:
        return False
    return any(x in t for x in INCLUDE_KEYWORDS)


def score_candidate(name: str, desc: str) -> int:
    t = f"{name} {desc}".lower()
    score = 0
    priority = [
        "castle", "palace", "abbey", "church", "chapel", "museum", "gallery", "bridge", "harbour", "beach",
        "park", "garden", "country house", "lighthouse", "golf", "theatre", "monument", "visitor", "distillery",
        "fort", "tower", "rock", "island", "law", "hill", "reservoir", "canal", "racecourse", "zoo"
    ]
    for word in priority:
        if word in t:
            score += 3
    if "historic" in t:
        score += 2
    if "scotland" in t or "scottish" in t:
        score += 1
    return score


def wikipedia_page_url(title: str) -> str:
    safe_chars = ":_()!'%,.-"
    return "https://en.wikipedia.org/wiki/" + quote(title, safe=safe_chars)


def fetch_wikipedia_info(url: str) -> Dict[str, Any]:
    try:
        text = http_get(url)
    except HTTPError as exc:
        if exc.code == 404:
            return {"lat": None, "lng": None, "lead": None}
        raise
    coord_match = re.search(r'"wgCoordinates"\s*:\s*\{[^}]*"lat":\s*([-0-9.]+),\s*"lon":\s*([-0-9.]+)', text)
    lat = lng = None
    if coord_match:
        lat = float(coord_match.group(1))
        lng = float(coord_match.group(2))
    segment_match = re.search(r'<div class="mw-content-ltr mw-parser-output"[^>]*>(.*?)<h2 id="', text, re.S)
    segment = segment_match.group(1) if segment_match else text
    paras = re.findall(r'<p[^>]*>(.*?)</p>', segment, re.S)
    lead = None
    for para in paras:
        para = re.sub(r'<style.*?</style>', '', para, flags=re.S)
        para = re.sub(r'<sup.*?</sup>', '', para, flags=re.S)
        clean = re.sub(r'<.*?>', '', para)
        clean = html.unescape(clean)
        clean = clean_text(clean)
        if clean and len(clean) > 80 and not clean.lower().startswith(("coordinates", "this article")):
            lead = trim_sentences(clean)
            break
    return {"lat": lat, "lng": lng, "lead": lead}


def build_generic_description(name: str, desc: str, city: str) -> str:
    desc = clean_text(desc)
    if not desc:
        return f"Notable visitor stop near {city}, useful for exploring the area's heritage and scenery."
    desc = desc[0].lower() + desc[1:] if len(desc) > 1 else desc.lower()
    base = f"{name} is a notable {desc} near {city}."
    tail_map = {
        "castle": "It makes a rewarding stop for travellers interested in Scottish history and strong coastal or countryside settings.",
        "church": "Travellers come for its architecture, atmosphere, and links to local history.",
        "museum": "It adds local context for visitors exploring the wider area.",
        "bridge": "Its setting and engineering interest make it more than just a crossing.",
        "beach": "It is a worthwhile stop for sea views, walks, and photography.",
        "park": "It works well for a slower scenic break between bigger heritage sights.",
        "viewpoint": "Expect wide views and a strong sense of the surrounding landscape."
    }
    category = infer_category(name, desc)
    tail = tail_map.get(category, "It fits well into a wider touring route around the Lothians.")
    return f"{base} {tail}"


def make_record(city: CityMeta, name: str, category: str, description: str, source_urls: List[str],
                field_source: str, lat: Optional[float], lng: Optional[float], address: Optional[str],
                hours: Optional[str] = None, hours_status: Optional[str] = None, station: Optional[str] = None) -> Dict[str, Any]:
    return {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(city.prefecture)}:{nk(city.city)}:{nk(name)}",
        "region": city.region,
        "prefecture": city.prefecture,
        "city": city.city,
        "country": "GB",
        "name": name,
        "category": category,
        "description": trim_sentences(description, 360),
        "tips": [],
        "hours": hours,
        "hours_status": hours_status or ("known" if hours else "unknown"),
        "station": station,
        "google_place_id": None,
        "lat": round(lat, 6) if lat is not None else None,
        "lng": round(lng, 6) if lng is not None else None,
        "address": address,
        "rating": None,
        "price_level": None,
        "image_url": None,
        "badges": [],
        "source_urls": source_urls,
        "field_sources": {
            "description": field_source,
            "lat": field_source,
            "lng": field_source,
            "address": field_source,
        },
        "photo": None,
        "extraction_model": "copilot-cli-knowledge",
        "extraction_status": "extracted",
        "validation_errors": [],
        "approved": False,
        "rejected_reason": None,
        "fetched_at": TIMESTAMP,
        "last_verified_at": TIMESTAMP,
    }


def city_station(city_name: str, category: str, distance_km: float) -> Optional[str]:
    if city_name in STATION_HINTS and distance_km <= 4.5 and category not in {"beach", "park", "viewpoint", "island", "landmark"}:
        return STATION_HINTS[city_name]
    return None


def build_manual_records(city: CityMeta, wiki_cache: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for spec in MANUAL_SPECS.get(city.city, []):
        lat = spec.get("lat")
        lng = spec.get("lng")
        source_urls: List[str] = []
        official_urls = spec.get("official_urls", [])
        field_source = official_urls[0] if official_urls else (
            wikipedia_page_url(spec["wiki_title"]) if spec.get("wiki_title") else ""
        )
        if spec.get("wiki_title"):
            wiki_url = wikipedia_page_url(spec["wiki_title"])
            source_urls.append(wiki_url)
            if wiki_url not in wiki_cache:
                wiki_cache[wiki_url] = fetch_wikipedia_info(wiki_url)
                time.sleep(0.08)
            wiki_info = wiki_cache[wiki_url]
            lat = lat if lat is not None else wiki_info.get("lat")
            lng = lng if lng is not None else wiki_info.get("lng")
            if not spec.get("description") and wiki_info.get("lead"):
                spec["description"] = wiki_info["lead"]
            field_source = wiki_url
        for url in official_urls:
            if url not in source_urls:
                source_urls.append(url)
        fallback_source = spec.get("fallback_source") or CITY_FALLBACK_SOURCE.get(city.city)
        if not source_urls and fallback_source:
            source_urls = [fallback_source]
        if not field_source and fallback_source:
            field_source = fallback_source
        if not source_urls and field_source:
            source_urls = [field_source]
        dist = haversine(city.lat, city.lng, lat or city.lat, lng or city.lng)
        out.append(make_record(
            city=city,
            name=spec["name"],
            category=spec.get("category") or infer_category(spec["name"], spec.get("description", "")),
            description=spec.get("description") or build_generic_description(spec["name"], "visitor attraction in Scotland", city.city),
            source_urls=source_urls,
            field_source=field_source,
            lat=lat,
            lng=lng,
            address=spec.get("address") or f"{spec['name']}, {city.city}, {city.prefecture}",
            hours=spec.get("hours"),
            hours_status=spec.get("hours_status"),
            station=spec.get("station") or city_station(city.city, spec.get("category", "landmark"), dist),
        ))
    return out


def build_auto_records(city: CityMeta, candidates: List[Dict[str, Any]], wiki_cache: Dict[str, Dict[str, Any]],
                       existing_names: set) -> List[Dict[str, Any]]:
    ranked: List[Tuple[float, int, Dict[str, Any]]] = []
    for cand in candidates:
        if cand["name"] in existing_names:
            continue
        distance_km = cand.get("distance_hint") or haversine(city.lat, city.lng, cand["lat"], cand["lng"])
        if distance_km > city.radius_km * 1.65:
            continue
        if not keep_candidate(cand["name"], cand.get("desc", "")):
            continue
        ranked.append((distance_km, -score_candidate(cand["name"], cand.get("desc", "")), cand))
    ranked.sort(key=lambda x: (x[0], x[1], x[2]["name"]))
    out: List[Dict[str, Any]] = []
    names = set(existing_names)
    for distance_km, _neg_score, cand in ranked:
        if len(out) + len(existing_names) >= city.target:
            break
        name = cand["name"]
        if name in names:
            continue
        wiki_url = cand["article"]
        if wiki_url not in wiki_cache:
            wiki_cache[wiki_url] = fetch_wikipedia_info(wiki_url)
            time.sleep(0.08)
        wiki_info = wiki_cache[wiki_url]
        description = wiki_info.get("lead") or build_generic_description(name, cand.get("desc", ""), city.city)
        lat = wiki_info.get("lat") or cand.get("lat")
        lng = wiki_info.get("lng") or cand.get("lng")
        source_urls = [wiki_url]
        for extra in OFFICIAL_BY_WIKI_TITLE.get(cand["wiki_title"], []):
            if extra not in source_urls:
                source_urls.append(extra)
        out.append(make_record(
            city=city,
            name=name,
            category=infer_category(name, cand.get("desc", "")),
            description=description,
            source_urls=source_urls,
            field_source=wiki_url,
            lat=lat,
            lng=lng,
            address=f"{name}, {city.city}, {city.prefecture}",
            station=city_station(city.city, infer_category(name, cand.get("desc", "")), distance_km),
        ))
        names.add(name)
    return out


def dedupe_records(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    out = []
    for rec in records:
        key = rec["name"].strip().lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(rec)
    return out


def validate_record(rec: Dict[str, Any]) -> None:
    required = ["description", "lat", "lng", "address"]
    for field in required:
        if field not in rec["field_sources"]:
            rec["validation_errors"].append(f"missing_field_source:{field}")
    if rec["lat"] is None or rec["lng"] is None:
        rec["validation_errors"].append("missing_coordinates")
    if rec["rejected_reason"] is not None and not isinstance(rec["rejected_reason"], str):
        rec["validation_errors"].append("invalid_rejected_reason")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    wiki_cache: Dict[str, Dict[str, Any]] = {}
    summaries = []

    for city in CITIES:
        filename = OUTPUT_DIR / f"{nk(city.city)}.json"
        if filename.exists():
            summaries.append(f"{city.city}: skipped existing file")
            continue

        manual_records = build_manual_records(city, wiki_cache)
        existing_names = {r["name"] for r in manual_records}
        candidates = sparql_candidates_for_city(city)
        auto_records = build_auto_records(city, candidates, wiki_cache, existing_names)
        records = dedupe_records(manual_records + auto_records)
        records = records[: city.target]
        for rec in records:
            validate_record(rec)
        payload = {"records": records}
        filename.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summaries.append(f"{city.city}: wrote {len(records)} records -> {filename.name}")

    for line in summaries:
        print(line)


if __name__ == "__main__":
    main()
