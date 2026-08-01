from __future__ import annotations

import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

BATCH_ID = "scot-pilot-2026-07-25"
OUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
USER_AGENT = "RoameoScotPilot/2026-07-25 (+https://github.com/jasbir98)"
COUNTRY = "GB"


def nk(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unknown"


def wiki_url(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{quote(title, safe='()_,')}"


@dataclass(frozen=True)
class Place:
    name: str
    category: str
    description: str
    address: str
    wiki: str
    lat: float | None = None
    lng: float | None = None
    hours: str | None = None
    hours_status: str = "unknown"
    sources: tuple[str, ...] = ()


CITY_CENTRES = {
    "Peebles": (55.6517, -3.1886),
    "Melrose": (55.5995, -2.7190),
    "Jedburgh": (55.4776, -2.5551),
    "Kelso": (55.5984, -2.4333),
    "Hawick": (55.4225, -2.7860),
    "Galashiels": (55.6196, -2.8060),
    "Innerleithen": (55.6190, -3.0630),
    "Selkirk": (55.5472, -2.8410),
    "Dumfries": (55.0703, -3.6051),
    "Stranraer": (54.9023, -5.0272),
    "Kirkcudbright": (54.8370, -4.0490),
    "Castle Douglas": (54.9392, -3.9300),
    "Wigtown": (54.8675, -4.4443),
    "New Abbey": (54.9955, -3.6180),
}

CITIES: list[dict[str, Any]] = [
    {
        "region": "Scottish Borders",
        "prefecture": "Scottish Borders",
        "city": "Peebles",
        "file": "peebles.json",
        "places": [
            Place("Neidpath Castle", "castle", "A dramatic medieval tower house above the River Tweed, long associated with the Frasers and the story-rich Border countryside around Peebles.", "Neidpath, Peebles, Scottish Borders, Scotland", "Neidpath_Castle"),
            Place("Peebles Museum & Art Gallery", "museum", "The town museum charts Tweeddale history, local archaeology, textiles, and civic life in the heart of Peebles.", "Chambers Institution, High Street, Peebles, Scottish Borders, Scotland", "Peebles", 55.6519, -3.1883),
            Place("Old Parish Church", "church", "A prominent historic church in the old burgh, reflecting centuries of Peebles religious and civic history.", "High Street, Peebles, Scottish Borders, Scotland", "Peebles", 55.6518, -3.1887),
            Place("Cross Kirk", "heritage site", "Atmospheric medieval church ruins standing beside the Tweed, once an important ecclesiastical site for the burgh.", "Cross Road, Peebles, Scottish Borders, Scotland", "Peebles", 55.6511, -3.1856),
            Place("Kailzie Gardens", "garden", "A long-established country garden with woodland walks, formal planting, and a peaceful rural setting east of town.", "Kailzie, near Peebles, Scottish Borders, Scotland", "Peebles", 55.6480, -3.1280),
            Place("Glentress Forest", "forest park", "One of Scotland's best-known trail centres, pairing Tweed Valley scenery with superb walking and mountain-biking terrain.", "Glentress, near Peebles, Scottish Borders, Scotland", "Glentress"),
            Place("Glentress Peel", "archaeological site", "An Iron Age hillfort above Glentress that rewards walkers with a strong sense of ancient settlement in the valley.", "Glentress, near Peebles, Scottish Borders, Scotland", "Peebles", 55.6367, -3.0669),
            Place("Tweed Valley Railway Path", "walking route", "A gentle path following the line of the old railway, useful for easy walking and cycling through the Tweed Valley landscape.", "Peebles to Innerleithen, Scottish Borders, Scotland", "Peebles", 55.6490, -3.1610),
            Place("River Tweed Riverside Walks", "river walk", "Level riverside paths give classic Peebles views of the Tweed, bridges, woodland, and salmon-water scenery.", "River Tweed, Peebles, Scottish Borders, Scotland", "River_Tweed", 55.6514, -3.1877),
            Place("Hay Lodge Park", "park", "A popular green space by the Tweed with lawns, mature trees, and room for a relaxed family stop near the centre.", "Innerleithen Road, Peebles, Scottish Borders, Scotland", "Peebles", 55.6500, -3.1817),
            Place("Tweed Green", "park", "The broad riverside common captures the open character of Peebles and is especially pleasant for a short waterside stroll.", "Tweed Green, Peebles, Scottish Borders, Scotland", "Peebles", 55.6529, -3.1864),
            Place("John Buchan Way", "walking route", "A long-distance route linked with author and statesman John Buchan, running through classic Borders hill and river country.", "Peebles, Scottish Borders, Scotland", "John_Buchan_Way", 55.6516, -3.1884),
            Place("Dawyck Botanic Garden", "garden", "A celebrated woodland botanic garden with champion trees, water features, and strong seasonal colour near Stobo.", "Stobo, near Peebles, Scottish Borders, Scotland", "Dawyck_Botanic_Garden"),
            Place("Stobo Castle", "historic building", "A grand Scots baronial mansion in landscaped grounds, known for its striking silhouette above the Upper Tweed.", "Stobo, near Peebles, Scottish Borders, Scotland", "Stobo_Castle"),
            Place("Cademuir Hill", "viewpoint", "This hill south of Peebles delivers expansive views across the burgh, the Tweed Valley, and the rounded Border uplands.", "South of Peebles, Scottish Borders, Scotland", "Peebles", 55.6376, -3.1948),
            Place("Lyne Viaduct", "bridge", "An impressive former railway viaduct spanning the Lyne Water, reflecting the engineering history of the valley.", "Lyne Station, near Peebles, Scottish Borders, Scotland", "Lyne_Viaduct"),
            Place("Manor Valley", "scenic valley", "A quiet side valley of the Tweed with rewarding drives, walking country, and a feeling of remoteness close to town.", "Manor Valley, near Peebles, Scottish Borders, Scotland", "Peebles", 55.6170, -3.2500),
            Place("Kingsmeadows Riverside Walk", "river walk", "A pleasant stretch of path and open parkland along the Tweed, good for an easy loop from the centre of Peebles.", "Kingsmeadows, Peebles, Scottish Borders, Scotland", "Peebles", 55.6545, -3.1937),
            Place("Chambers Institution", "historic building", "A handsome Victorian civic building on the High Street that remains central to Peebles cultural life.", "High Street, Peebles, Scottish Borders, Scotland", "Peebles", 55.6519, -3.1883),
            Place("Cardrona Forest", "forest park", "Forest trails and valley views make this a worthwhile nearby stop for walkers looking beyond central Peebles.", "Cardrona, near Peebles, Scottish Borders, Scotland", "Peebles", 55.6491, -3.0925),
        ],
    },
    {
        "region": "Scottish Borders",
        "prefecture": "Scottish Borders",
        "city": "Melrose",
        "file": "melrose.json",
        "places": [
            Place("Melrose Abbey", "abbey", "Magnificent Gothic abbey ruins founded in 1136 and famed for their carved stonework, soaring arches, and association with Robert the Bruce's heart.", "Abbey Street, Melrose, Scottish Borders, Scotland", "Melrose_Abbey"),
            Place("Priorwood Garden", "garden", "A small but delightful garden beside the abbey, known for heritage apples and intimate monastic-town atmosphere.", "Priorwood, Melrose, Scottish Borders, Scotland", "Melrose", 55.6004, -2.7190),
            Place("Harmony Garden", "garden", "A peaceful National Trust for Scotland garden with colourful borders and a mellow Georgian house setting in central Melrose.", "St Mary's Road, Melrose, Scottish Borders, Scotland", "Melrose", 55.5998, -2.7232),
            Place("Scott's View", "viewpoint", "One of the Borders' classic panoramas, looking over the Tweed valley toward the triple-peaked Eildon Hills that Walter Scott loved.", "Bemersyde, near Melrose, Scottish Borders, Scotland", "Scott's_View"),
            Place("Abbotsford House", "historic building", "Sir Walter Scott's extraordinary baronial home, packed with books, armour, and objects that shaped his imagination.", "Abbotsford, near Melrose, Scottish Borders, Scotland", "Abbotsford_House"),
            Place("Dryburgh Abbey", "abbey", "A romantic riverside abbey ruin where Sir Walter Scott is buried, set in one of the prettiest reaches of the Tweed.", "Dryburgh, near Melrose, Scottish Borders, Scotland", "Dryburgh_Abbey"),
            Place("Three Abbeys Way", "walking route", "This rewarding circular trail links Melrose, Dryburgh, and Jedburgh through classic Borders countryside.", "Melrose, Scottish Borders, Scotland", "Melrose", 55.5993, -2.7193),
            Place("Eildon Hills", "hill", "The iconic triple summit above Melrose offers one of southern Scotland's finest short hill walks and sweeping all-round views.", "South of Melrose, Scottish Borders, Scotland", "Eildon_Hill"),
            Place("Trimontium Museum", "museum", "A strong Roman-era museum interpreting the Newstead fort and the frontier story beneath the Eildon Hills.", "Market Square, Melrose, Scottish Borders, Scotland", "Trimontium_Museum", 55.5994, -2.7211),
            Place("Old Melrose", "heritage site", "A quiet historic site in a Tweed loop traditionally linked with an early monastery associated with St Cuthbert.", "Old Melrose, near Melrose, Scottish Borders, Scotland", "Old_Melrose"),
            Place("Leaderfoot Viaduct", "bridge", "A dramatic red sandstone viaduct carrying the old railway across the Tweed below the abbey country of Melrose.", "Leaderfoot, near Melrose, Scottish Borders, Scotland", "Leaderfoot_Viaduct"),
            Place("St Cuthbert's Way", "walking route", "The celebrated long-distance route passes Melrose on its way from the Borders to Holy Island.", "Melrose, Scottish Borders, Scotland", "St_Cuthbert's_Way", 55.5995, -2.7190),
            Place("Newstead Roman Fort Site", "archaeological site", "The remains of Trimontium reveal how substantial the Roman military presence once was beneath the Eildons.", "Newstead, near Melrose, Scottish Borders, Scotland", "Trimontium"),
            Place("Melrose Historic High Street", "historic area", "A compact stone-built centre of bookshops, closes, and views that sits comfortably beside the famous abbey.", "High Street, Melrose, Scottish Borders, Scotland", "Melrose", 55.5996, -2.7206),
            Place("River Tweed Walks", "river walk", "Waterside paths near Melrose give easy walking, salmon-river scenery, and views toward abbeys and wooded banks.", "River Tweed, Melrose, Scottish Borders, Scotland", "River_Tweed", 55.6035, -2.7240),
            Place("Eildon Mid Hill", "viewpoint", "The most visited Eildon summit delivers the signature look back over Melrose, the abbey, and the Border hills.", "Eildon Hills, near Melrose, Scottish Borders, Scotland", "Eildon_Hill", 55.5907, -2.7344),
            Place("William Wallace Statue, Bemersyde", "monument", "A hillside statue overlooking the Tweed and Dryburgh country, commemorating Wallace in memorable surroundings.", "Bemersyde, near Melrose, Scottish Borders, Scotland", "William_Wallace_Statue,_Bemersyde"),
            Place("Rhymer's Stone", "monument", "This small but evocative monument recalls Thomas the Rhymer, the legendary Border poet and seer of nearby Earlston country.", "Near Huntlywood, Melrose area, Scottish Borders, Scotland", "Thomas_the_Rhymer", 55.6390, -2.6720),
            Place("Dryburgh Suspension Bridge", "bridge", "A charming narrow bridge over the Tweed that adds extra atmosphere to walks around Dryburgh Abbey.", "Dryburgh, near Melrose, Scottish Borders, Scotland", "Dryburgh_Abbey", 55.6533, -2.6810),
            Place("Gattonside Bridge", "bridge", "The elegant footbridge linking Melrose and Gattonside gives lovely river and abbey-country views on a short outing.", "Gattonside, near Melrose, Scottish Borders, Scotland", "Melrose", 55.6033, -2.7247),
        ],
    },
    {
        "region": "Scottish Borders",
        "prefecture": "Scottish Borders",
        "city": "Jedburgh",
        "file": "jedburgh.json",
        "places": [
            Place("Jedburgh Abbey", "abbey", "One of the great Border abbeys, with elegant Romanesque and early Gothic architecture rising above the town.", "Abbey Bridge End, Jedburgh, Scottish Borders, Scotland", "Jedburgh_Abbey"),
            Place("Mary Queen of Scots' House", "museum", "A compact museum in a 16th-century tower house traditionally linked with Mary's brief stay in Jedburgh.", "Queen Street, Jedburgh, Scottish Borders, Scotland", "Jedburgh"),
            Place("Jedburgh Castle Jail & Museum", "museum", "An unusual 19th-century prison museum telling the story of crime, punishment, and local law in the Borders.", "Castle Gate, Jedburgh, Scottish Borders, Scotland", "Jedburgh_Castle_Jail"),
            Place("Black Bull Sculpture", "monument", "A modern landmark in the town centre celebrating Jedburgh's long identity with the black bull emblem.", "Market Place, Jedburgh, Scottish Borders, Scotland", "Jedburgh", 55.4777, -2.5548),
            Place("Ferniehirst Castle", "castle", "The historic Kerr family stronghold stands in wooded country south of Jedburgh and is rich in Border reiver history.", "Ferniehirst, near Jedburgh, Scottish Borders, Scotland", "Ferniehirst_Castle"),
            Place("Jedforest Deer & Farm Park", "park", "A family-friendly wildlife park with deer, farm animals, woodland surroundings, and open-country views.", "Jedforest, near Jedburgh, Scottish Borders, Scotland", "Jedburgh", 55.4210, -2.6070),
            Place("Ancrum Moor Battlefield", "battlefield", "The site of the 1545 battle where Scottish forces won a famous victory during the Rough Wooing.", "Ancrum, near Jedburgh, Scottish Borders, Scotland", "Battle_of_Ancrum_Moor"),
            Place("Carter Bar", "viewpoint", "The classic viewpoint on the Scotland-England border gives long views over the Cheviots and makes a memorable approach to Jedburgh.", "A68, near Jedburgh, Scottish Borders, Scotland", "Carter_Bar"),
            Place("Catcleugh Reservoir", "reservoir", "A large upland reservoir in remote moorland scenery south of Jedburgh, popular for quiet scenic stops.", "Near Newcastleton Road, Jedburgh area, Scottish Borders, Scotland", "Catcleugh_Reservoir"),
            Place("Waterloo Monument", "monument", "The tall Peniel Heugh monument crowns a hill north of town and offers a classic Borders outlook.", "Peniel Heugh, near Jedburgh, Scottish Borders, Scotland", "Ancrum"),
            Place("Monteviot House & Gardens", "historic building", "A handsome stately home and gardens near the Teviot, known for rich planting and a peaceful setting.", "Monteviot, near Jedburgh, Scottish Borders, Scotland", "Monteviot_House"),
            Place("Harestanes Countryside Visitor Centre", "park", "A useful family stop with trails, sculpture, and access to the wooded countryside west of Jedburgh.", "Ancrum, near Jedburgh, Scottish Borders, Scotland", "Jedburgh", 55.5075, -2.6017),
            Place("Jed Water Walk", "river walk", "Paths by the Jed Water provide an easy way to explore the valley immediately around the abbey town.", "Jed Water, Jedburgh, Scottish Borders, Scotland", "Jed_Water", 55.4780, -2.5540),
            Place("Abbey Bridge", "bridge", "The bridge at the foot of the abbey frames one of Jedburgh's best-loved historic views.", "Abbey Bridge End, Jedburgh, Scottish Borders, Scotland", "Jedburgh", 55.4774, -2.5560),
            Place("St Cuthbert's Way", "walking route", "The long-distance route passes through Jedburgh, making the town a natural overnight base for walkers.", "Jedburgh, Scottish Borders, Scotland", "St_Cuthbert's_Way", 55.4776, -2.5551),
            Place("War Memorial Gardens", "park", "A calm central green space offering a pleasant pause close to the historic core of Jedburgh.", "Canongate, Jedburgh, Scottish Borders, Scotland", "Jedburgh", 55.4784, -2.5539),
            Place("Capon Tree Monument", "monument", "A modest but meaningful site linked with covenanting history and a key event in Borders memory.", "Near Jedburgh, Scottish Borders, Scotland", "Jedburgh", 55.4810, -2.5650),
            Place("Canongate Bridge", "bridge", "A characterful crossing in the old town area, tying together river views and the climb toward the abbey.", "Canongate, Jedburgh, Scottish Borders, Scotland", "Jedburgh", 55.4782, -2.5537),
            Place("Lilliard's Tomb", "monument", "A traditional monument to the heroine Fair Maiden Lilliard, closely connected with Ancrum Moor memory.", "Ancrum Moor, near Jedburgh, Scottish Borders, Scotland", "Battle_of_Ancrum_Moor", 55.5124, -2.6532),
            Place("Jedburgh Town Hall", "historic building", "An important civic building on the main street that helps define Jedburgh's handsome historic centre.", "Castlegate, Jedburgh, Scottish Borders, Scotland", "Jedburgh", 55.4778, -2.5547),
        ],
    },
    {
        "region": "Scottish Borders",
        "prefecture": "Scottish Borders",
        "city": "Kelso",
        "file": "kelso.json",
        "places": [
            Place("Kelso Abbey", "abbey", "Substantial abbey ruins founded in the 12th century, still dominating the market town with impressive surviving masonry.", "Abbey Row, Kelso, Scottish Borders, Scotland", "Kelso_Abbey"),
            Place("Kelso Museum & The Turret Gallery", "museum", "The local museum interprets Kelso's abbey, burgh, and countryside history beside a contemporary gallery space.", "The Square, Kelso, Scottish Borders, Scotland", "Kelso", 55.5987, -2.4331),
            Place("Floors Castle", "castle", "The great seat of the Duke of Roxburghe, with landscaped grounds, art, and one of Scotland's grandest inhabited castles.", "Floors Castle, Kelso, Scottish Borders, Scotland", "Floors_Castle"),
            Place("Kelso Racecourse", "heritage site", "Britain's friendliest racecourse is part of Kelso's visitor identity and sits in open Tweedside surroundings.", "Berrymoss, Kelso, Scottish Borders, Scotland", "Kelso", 55.6144, -2.4529),
            Place("Springwood Park", "park", "A broad parkland setting used for events and local recreation on the edge of the historic town.", "Springwood Road, Kelso, Scottish Borders, Scotland", "Kelso", 55.6061, -2.4305),
            Place("Tweed and Teviot Confluence", "river walk", "The meeting of two great Border rivers gives Kelso one of the most attractive waterside settings in the region.", "Kelso, Scottish Borders, Scotland", "River_Tweed", 55.6002, -2.4322),
            Place("Junction Pool", "river walk", "Famous with anglers, this storied pool lies at the confluence and is woven into Kelso's salmon-fishing heritage.", "Kelso, Scottish Borders, Scotland", "River_Tweed", 55.6000, -2.4317),
            Place("Roxburgh Castle", "castle", "The grassy remains of this once-important royal castle stand above the rivers just outside modern Kelso.", "Roxburgh, near Kelso, Scottish Borders, Scotland", "Roxburgh_Castle"),
            Place("Roxburgh Viaduct", "bridge", "Ruins of the old railway viaduct still make a dramatic feature in the river landscape near Roxburgh.", "Roxburgh, near Kelso, Scottish Borders, Scotland", "Kelso", 55.5945, -2.4480),
            Place("Smailholm Tower", "tower", "A mighty peel tower in lonely countryside, strongly associated with Walter Scott's childhood imagination.", "Smailholm, near Kelso, Scottish Borders, Scotland", "Smailholm_Tower"),
            Place("Mellerstain House", "historic building", "A refined Georgian mansion with major interiors and formal grounds by leading architects and designers.", "Mellerstain, near Kelso, Scottish Borders, Scotland", "Mellerstain_House"),
            Place("Kelso Old Bridge", "bridge", "John Rennie's elegant bridge gives classic views toward the abbey and the broad Tweed below.", "Bridge Street, Kelso, Scottish Borders, Scotland", "Kelso_Bridge"),
            Place("Kelso Square", "historic area", "The market square and surrounding streets preserve the open, gracious character of one of the Borders' prettiest towns.", "The Square, Kelso, Scottish Borders, Scotland", "Kelso", 55.5988, -2.4329),
            Place("Kelso Town Hall", "historic building", "A key civic landmark on the square, contributing strongly to the planned appearance of central Kelso.", "The Square, Kelso, Scottish Borders, Scotland", "Kelso", 55.5989, -2.4330),
            Place("Hume Castle", "castle", "A striking hilltop folly-castle on an older fortress site, offering huge views over the Merse and central Borders.", "Hume, near Kelso, Scottish Borders, Scotland", "Hume_Castle"),
            Place("St Cuthbert's Way", "walking route", "This famous walking route threads through the Kelso area, pairing historic sites with easy river-country scenery.", "Kelso, Scottish Borders, Scotland", "St_Cuthbert's_Way", 55.5984, -2.4333),
            Place("Springwood Park Walled Garden", "garden", "A quieter corner of Springwood with planting and a sheltered feel close to the main event grounds.", "Springwood Road, Kelso, Scottish Borders, Scotland", "Kelso", 55.6060, -2.4301),
            Place("Kelso War Memorial", "monument", "A dignified local memorial set within the handsome architecture and gardens of the town centre.", "Kelso, Scottish Borders, Scotland", "Kelso", 55.5986, -2.4338),
            Place("The Knowes Riverside Walk", "river walk", "A gentle path and green space that make the most of Kelso's enviable position above the Tweed.", "The Knowes, Kelso, Scottish Borders, Scotland", "Kelso", 55.6020, -2.4321),
            Place("Floors Castle Gardens", "garden", "Woodland and formal landscaping around the castle make this one of the finest country-house grounds in the Borders.", "Floors Castle, Kelso, Scottish Borders, Scotland", "Floors_Castle", 55.6060, -2.4170),
        ],
    },
    {
        "region": "Scottish Borders",
        "prefecture": "Scottish Borders",
        "city": "Hawick",
        "file": "hawick.json",
        "places": [
            Place("Hawick Museum", "museum", "The main town museum presents Hawick's knitwear, rugby, and local history within Wilton Lodge Park.", "Wilton Lodge Park, Hawick, Scottish Borders, Scotland", "Hawick", 55.4247, -2.7895),
            Place("Drumlanrig's Tower", "tower", "A powerful 16th-century tower house in the old heart of Hawick, closely tied to Border reiver history.", "Drumlanrig Square, Hawick, Scottish Borders, Scotland", "Hawick"),
            Place("Wilton Lodge Park", "park", "Hawick's main public park combines riverside walks, museum culture, and a broad green setting.", "Wilton Lodge Park, Hawick, Scottish Borders, Scotland", "Hawick"),
            Place("Hawick Horse Monument", "monument", "The horseman sculpture recalls Hawick's Common Riding, one of the Borders' strongest living traditions.", "Horse Monument, Hawick, Scottish Borders, Scotland", "Hawick", 55.4217, -2.7868),
            Place("Mote of Hawick", "archaeological site", "The earthwork of a Norman motte hints at Hawick's early strategic importance in the Teviot valley.", "Mote Park, Hawick, Scottish Borders, Scotland", "Hawick", 55.4210, -2.7838),
            Place("Branxholme Castle", "castle", "A major Border stronghold of the Scotts, standing in the wooded Teviot landscape west of Hawick.", "Branxholme, near Hawick, Scottish Borders, Scotland", "Branxholme_Castle"),
            Place("Borders Textile Towerhouse", "museum", "This focused museum explores the cloth-making traditions that made Hawick famous worldwide.", "Tower Mill, Hawick, Scottish Borders, Scotland", "Hawick", 55.4222, -2.7850),
            Place("Heritage Hub", "museum", "The regional archive and history centre offers exhibitions and deep background on the Borders and its communities.", "Kirkstile, Hawick, Scottish Borders, Scotland", "Hawick", 55.4255, -2.7858),
            Place("Common Riding Heritage Route", "heritage site", "A self-guided way into Hawick's famous annual festival of riding, memory, and town identity.", "Hawick, Scottish Borders, Scotland", "Common_riding", 55.4225, -2.7860),
            Place("River Teviot Walk", "river walk", "Waterside paths through Hawick reveal mills, bridges, and the valley shape that determined the town's growth.", "River Teviot, Hawick, Scottish Borders, Scotland", "River_Teviot", 55.4220, -2.7862),
            Place("Harden Tower", "tower", "A reiver-era tower linked with 'Auld Wat of Harden', standing in rolling country north of Hawick.", "Harden, near Hawick, Scottish Borders, Scotland", "Harden_House", 55.4620, -2.7590),
            Place("St Mary's and Old Parish Church", "church", "A striking church presence in the townscape, reflecting Hawick's Victorian confidence and older parish roots.", "Hawick, Scottish Borders, Scotland", "Hawick", 55.4219, -2.7847),
            Place("Hawick Town Hall", "historic building", "An ornate civic building that anchors the centre and speaks to the town's prosperous textile age.", "High Street, Hawick, Scottish Borders, Scotland", "Hawick", 55.4225, -2.7857),
            Place("Ruberslaw Viewpoint", "viewpoint", "From the Hawick area, Ruberslaw provides a memorable conical landmark and far-reaching Borders views.", "Near Denholm, Hawick area, Scottish Borders, Scotland", "Ruberslaw"),
            Place("High Street Heritage Quarter", "historic area", "Hawick's sloping central streets are packed with stone buildings, closes, and traces of the wool town at work.", "High Street, Hawick, Scottish Borders, Scotland", "Hawick", 55.4226, -2.7854),
        ],
    },
    {
        "region": "Scottish Borders",
        "prefecture": "Scottish Borders",
        "city": "Galashiels",
        "file": "galashiels.json",
        "places": [
            Place("Great Tapestry of Scotland", "museum", "A major contemporary cultural attraction showcasing Scotland's story through vast hand-stitched panels.", "Low Buckholmside, Galashiels, Scottish Borders, Scotland", "Great_Tapestry_of_Scotland"),
            Place("Old Gala House", "museum", "A handsome 16th-century tower house and laird's residence now used as the town's museum and gallery.", "Scott Crescent, Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6184, -2.8079),
            Place("Galashiels War Memorial", "monument", "A prominent local memorial overlooking the town and marking the sacrifice of the Borders communities.", "Gala Hill, Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6215, -2.8050),
            Place("Gala Hill Viewpoint", "viewpoint", "A rewarding short climb above town with wide views over Galashiels and the surrounding valley slopes.", "Gala Hill, Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6214, -2.8054),
            Place("Bank Street Gardens", "park", "Terraced gardens in the centre provide a green break amid the busy fabric of modern Galashiels.", "Bank Street, Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6192, -2.8082),
            Place("Abbotsford House", "historic building", "Sir Walter Scott's richly personal home lies close to Galashiels and is one of the Borders' essential visits.", "Abbotsford, near Galashiels, Scottish Borders, Scotland", "Abbotsford_House"),
            Place("Torwoodlee Broch", "archaeological site", "An unusual Iron Age broch site in the Borders, set within wooded countryside south of town.", "Torwoodlee, near Galashiels, Scottish Borders, Scotland", "Torwoodlee_Broch"),
            Place("Gala Water Walk", "river walk", "Townside paths along the Gala Water help explain Galashiels as a river-powered textile centre.", "Galashiels, Scottish Borders, Scotland", "Gala_Water", 55.6195, -2.8060),
            Place("Buckholm Tower", "historic building", "The surviving tower and estate area recall an older landed landscape now absorbed into Galashiels.", "Buckholm, Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6167, -2.8130),
            Place("Braw Lads Gathering Heritage Trail", "heritage site", "This theme highlights Galashiels' best-known annual civic festival and the stories behind it.", "Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6196, -2.8060),
            Place("Transport Interchange Viewpoint", "viewpoint", "Around the station area, visitors can appreciate how the revived Borders Railway reconnects the town with Edinburgh.", "Galashiels Transport Interchange, Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6188, -2.8069),
            Place("Gala Policies Woodland", "park", "A useful green corridor and walking area close to the centre with a more natural feel than the busy main streets.", "Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6173, -2.8108),
            Place("St Peter's Church", "church", "A notable church building in the town centre, representing Galashiels' Victorian-era expansion.", "Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6191, -2.8070),
            Place("Volunteer Hall", "art centre", "A community arts venue that reflects Galashiels' current creative life beyond its textile heritage.", "St John's Street, Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6189, -2.8074),
            Place("Tweedbank Riverside Path", "river walk", "The riverside near Tweedbank gives easier walking and links Galashiels with the wider Tweed corridor.", "Tweedbank, near Galashiels, Scottish Borders, Scotland", "Galashiels", 55.6072, -2.7776),
        ],
    },
    {
        "region": "Scottish Borders",
        "prefecture": "Scottish Borders",
        "city": "Innerleithen",
        "file": "innerleithen.json",
        "places": [
            Place("Traquair House", "historic building", "Widely regarded as Scotland's oldest inhabited house, full of Jacobite, Catholic, and literary associations.", "Traquair, near Innerleithen, Scottish Borders, Scotland", "Traquair_House"),
            Place("Robert Smail's Printing Works", "museum", "A beautifully preserved Victorian print works where machinery, type, and offices survive almost intact.", "High Street, Innerleithen, Scottish Borders, Scotland", "Robert_Smail's_Printing_Works"),
            Place("St Ronan's Well", "heritage site", "A small but evocative site linked with the spa history and seasonal traditions that shaped Innerleithen's identity.", "Wells Brae, Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6211, -3.0618),
            Place("St Ronan's Parish Church", "church", "A prominent church in the centre of town, tied to Innerleithen's growth as a resort and market settlement.", "Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6190, -3.0632),
            Place("Caerlee Hill", "viewpoint", "A steep local hill giving fine views over Innerleithen and the wooded ridges of the Tweed Valley.", "Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6245, -3.0571),
            Place("Pirn Craig", "viewpoint", "A favourite short climb above town, rewarding walkers with a broad outlook over the valley and hills.", "Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6228, -3.0604),
            Place("Glentress Forest", "forest park", "Major mountain-biking and walking terrain just outside Innerleithen, with waymarked forest and valley trails.", "Glentress, near Innerleithen, Scottish Borders, Scotland", "Glentress"),
            Place("Leithen Water Walk", "river walk", "A gentle walk through the town's river corridor, showing how the Leithen meets the wider Tweed landscape.", "Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6192, -3.0623),
            Place("Traquair Kirk", "church", "The old kirk and burial ground near Traquair add depth to any visit to the estate and its historic setting.", "Traquair, near Innerleithen, Scottish Borders, Scotland", "Traquair_House", 55.6080, -3.0912),
            Place("Southern Upland Way", "walking route", "The national coast-to-coast route passes the area, bringing big-hill walking culture into the town.", "Innerleithen, Scottish Borders, Scotland", "Southern_Upland_Way", 55.6191, -3.0630),
            Place("Minch Moor", "hill", "A broad upland ridge carrying old drove and pilgrimage routes, with excellent expansive views on clear days.", "Near Innerleithen, Scottish Borders, Scotland", "Innerleithen"),
            Place("Tweed Valley Railway Path", "walking route", "This old railway corridor gives easy traffic-free travel between valley towns and forests.", "Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6232, -3.0433),
            Place("Cardrona Forest", "forest park", "A quieter stretch of Tweed Valley woodland with walking and riding routes in attractive scenery.", "Cardrona, near Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6338, -3.0925),
            Place("The Golfie Trails", "forest park", "The steep forest slopes above town are famous with mountain bikers for technical descents and big valley views.", "Caberston Forest, Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6240, -3.0520),
            Place("Innerleithen High Street Heritage", "historic area", "The stone-built centre preserves the feel of a small Borders resort town with long walking and cycling traditions.", "High Street, Innerleithen, Scottish Borders, Scotland", "Innerleithen", 55.6191, -3.0630),
        ],
    },
    {
        "region": "Scottish Borders",
        "prefecture": "Scottish Borders",
        "city": "Selkirk",
        "file": "selkirk.json",
        "places": [
            Place("Sir Walter Scott's Courtroom", "museum", "The old courthouse recalls Scott's years as Sheriff-Depute and links Selkirk strongly with literary history.", "Market Place, Selkirk, Scottish Borders, Scotland", "Selkirk"),
            Place("Halliwell's House Museum", "museum", "A local history museum in one of Selkirk's oldest houses, covering everyday life and town traditions.", "Halliwell's Close, Selkirk, Scottish Borders, Scotland", "Selkirk"),
            Place("Selkirk Glass", "art centre", "A long-running local studio known for hand-crafted glass and a distinctly Selkirk creative tradition.", "Selkirk, Scottish Borders, Scotland", "Selkirk", 55.5473, -2.8409),
            Place("Flodden Memorial", "monument", "A memorial stop reflecting Selkirk's remembered part in the great and tragic 1513 battle.", "Selkirk, Scottish Borders, Scotland", "Battle_of_Flodden", 55.5470, -2.8414),
            Place("Philiphaugh Battlefield", "battlefield", "The open ground west of town marks the decisive 1645 battle between Covenanters and Royalists.", "Philiphaugh, Selkirk, Scottish Borders, Scotland", "Battle_of_Philiphaugh"),
            Place("Salmon Viewing Centre", "nature reserve", "A useful family stop by the Ettrick Water where visitors can learn about migrating salmon.", "Philiphaugh, Selkirk, Scottish Borders, Scotland", "Selkirk", 55.5488, -2.8562),
            Place("Bowhill House & Country Estate", "historic building", "A major ducal residence in woodland and river scenery, with art, walks, and Scott associations.", "Bowhill, near Selkirk, Scottish Borders, Scotland", "Bowhill_House"),
            Place("The Haining", "park", "A restored country house, loch, and public parkland providing a calm green edge to the town.", "The Haining, Selkirk, Scottish Borders, Scotland", "The_Haining"),
            Place("Ettrick Valley", "scenic valley", "One of the Borders' most poetic landscapes, associated with James Hogg and generations of sheep-farming culture.", "Ettrick Valley, near Selkirk, Scottish Borders, Scotland", "Ettrick_Water", 55.5150, -2.9700),
            Place("Yarrow Valley", "scenic valley", "The lochs, hills, and literary echoes of Yarrow country make it a classic scenic drive from Selkirk.", "Yarrow Valley, near Selkirk, Scottish Borders, Scotland", "Yarrow_Water", 55.5750, -2.9400),
            Place("Three Brethren", "viewpoint", "This conspicuous hilltop cairn offers a superb panorama over the Border hills and valleys around Selkirk.", "Near Selkirk, Scottish Borders, Scotland", "Selkirk"),
            Place("James Hogg Monument", "monument", "A memorial to the Ettrick Shepherd, set in a landscape inseparable from his poetry and songs.", "Ettrick Valley, near Selkirk, Scottish Borders, Scotland", "James_Hogg"),
            Place("Selkirk Common Riding Heritage Trail", "heritage site", "The theme of the Common Riding helps visitors understand Selkirk's strongest annual civic tradition.", "Selkirk, Scottish Borders, Scotland", "Common_riding", 55.5472, -2.8410),
            Place("Mungo Park Monument", "monument", "A tribute to the explorer born near Selkirk, set within the town that remembers him proudly.", "Selkirk, Scottish Borders, Scotland", "Mungo_Park", 55.5475, -2.8408),
            Place("Selkirk Hill Viewpoint", "viewpoint", "A local height giving a compact but rewarding overview of Selkirk and the surrounding river country.", "Selkirk, Scottish Borders, Scotland", "Selkirk", 55.5525, -2.8380),
        ],
    },
    {
        "region": "Dumfries & Galloway",
        "prefecture": "Dumfries and Galloway",
        "city": "Dumfries",
        "file": "dumfries.json",
        "places": [
            Place("Robert Burns House", "museum", "The final home of Scotland's national poet preserves rooms and objects connected with his last years in Dumfries.", "Burns Street, Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
            Place("Robert Burns Centre", "museum", "A riverside museum and film theatre exploring Burns, local culture, and Dumfries' literary heritage.", "Mill Road, Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
            Place("Dumfries Museum & Camera Obscura", "museum", "Housed in the old windmill, the museum ranges from fossils to local history and includes a rare working camera obscura.", "Museum Road, Dumfries, Dumfries and Galloway, Scotland", "Dumfries_Museum"),
            Place("Old Bridge House Museum", "museum", "A 17th-century house by Devorgilla Bridge interpreting domestic and burgh life beside the Nith.", "Whitesands, Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
            Place("Ellisland Farm", "historic building", "Burns built and worked this farm in the countryside north of Dumfries, writing some of his best-loved songs here.", "Auldgirth, near Dumfries, Dumfries and Galloway, Scotland", "Ellisland_Farm"),
            Place("St Michael's Churchyard and Mausoleum", "church", "Burns lies buried here beneath an imposing mausoleum in one of Dumfries' most resonant historic sites.", "St Michael Street, Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
            Place("Greyfriars Church", "church", "A key ecclesiastical building in the centre of Dumfries, standing close to sites linked with Bruce and Comyn.", "Bank Street, Dumfries, Dumfries and Galloway, Scotland", "Greyfriars_Church,_Dumfries"),
            Place("Lincluden Collegiate Church", "heritage site", "Extensive ruins of a medieval religious foundation in a tranquil Nithside setting outside the town centre.", "Lincluden, Dumfries, Dumfries and Galloway, Scotland", "Lincluden_Collegiate_Church"),
            Place("Caerlaverock Castle", "castle", "Scotland's remarkable moated triangular castle, one of the most distinctive medieval fortresses in Britain.", "Caerlaverock, near Dumfries, Dumfries and Galloway, Scotland", "Caerlaverock_Castle"),
            Place("Caerlaverock National Nature Reserve", "nature reserve", "This wetlands reserve is internationally important for wintering barnacle geese and rich Solway wildlife.", "Caerlaverock, near Dumfries, Dumfries and Galloway, Scotland", "Caerlaverock_National_Nature_Reserve"),
            Place("Sweetheart Abbey", "abbey", "An evocative red sandstone abbey founded by Devorgilla of Galloway in memory of her husband John Balliol.", "New Abbey, near Dumfries, Dumfries and Galloway, Scotland", "Sweetheart_Abbey"),
            Place("Drumlanrig Castle", "castle", "The grand pink sandstone seat of the Buccleuch family, renowned for art, interiors, and estate scenery.", "Drumlanrig, near Dumfries, Dumfries and Galloway, Scotland", "Drumlanrig_Castle"),
            Place("Drumlanrig Country Park", "park", "Woodland, trails, and estate landscapes around Drumlanrig make this a major outdoor destination.", "Drumlanrig, near Dumfries, Dumfries and Galloway, Scotland", "Drumlanrig_Castle", 55.2670, -3.8000),
            Place("Threave Castle", "castle", "A dramatic island stronghold on the River Dee, approached by boat and closely tied to the Black Douglases.", "Near Castle Douglas, Dumfries and Galloway, Scotland", "Threave_Castle"),
            Place("Threave Garden", "garden", "A richly planted National Trust for Scotland garden celebrated for colour, design, and an osprey-friendly landscape.", "Near Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas"),
            Place("Galloway Forest Park", "forest park", "Britain's largest forest park offers lochs, mountain roads, dark skies, and huge areas for walking and wildlife.", "Galloway Forest Park, Dumfries and Galloway, Scotland", "Galloway_Forest_Park"),
            Place("Crichton Memorial Church", "church", "A flamboyant Victorian church on the Crichton estate, famous for its colour, spire, and rich stonework.", "The Crichton, Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
            Place("Whitesands Riverfront", "historic area", "The broad riverside street is central to Dumfries' townscape, events, and classic views toward the old bridge.", "Whitesands, Dumfries, Dumfries and Galloway, Scotland", "Dumfries", 55.0695, -3.6100),
            Place("Devorgilla Bridge", "bridge", "The old multi-arched bridge is one of Dumfries' signature landmarks and an enduring symbol of the burgh.", "Whitesands, Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
            Place("Dock Park", "park", "A pleasant riverside park with mature trees and paths that make an easy green escape near the centre.", "St Michael Street, Dumfries, Dumfries and Galloway, Scotland", "Dumfries", 55.0658, -3.6051),
            Place("Midsteeple", "historic building", "The 18th-century tolbooth tower stands at the civic heart of the High Street and anchors central Dumfries.", "High Street, Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
            Place("High Street Heritage Quarter", "historic area", "Dumfries' central streets retain layers of closes, civic buildings, and Burns-related memory.", "High Street, Dumfries, Dumfries and Galloway, Scotland", "Dumfries", 55.0705, -3.6067),
            Place("Moat Brae", "historic building", "This imaginative museum-house celebrates J. M. Barrie and the Dumfries childhood inspirations behind Peter Pan.", "101 George Street, Dumfries, Dumfries and Galloway, Scotland", "Moat_Brae"),
            Place("Mabie Forest", "forest park", "A mixed forest south of Dumfries with walking trails, hill-bike routes, and broad views toward the Solway.", "Mabie, near Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
            Place("7stanes Mabie", "forest park", "Purpose-built mountain-bike trails bring riders into the woods and hills just outside Dumfries.", "Mabie Forest, near Dumfries, Dumfries and Galloway, Scotland", "7stanes", 55.0210, -3.6550),
            Place("Shambellie House", "historic building", "A notable country house near New Abbey, best known for its role as Scotland's former costume museum.", "New Abbey, near Dumfries, Dumfries and Galloway, Scotland", "Shambellie_House"),
            Place("New Abbey Corn Mill", "historic building", "An atmospheric working 18th-century watermill that vividly complements a visit to Sweetheart Abbey.", "New Abbey, near Dumfries, Dumfries and Galloway, Scotland", "New_Abbey"),
            Place("Criffel", "hill", "The granite hill above the Solway gives one of the region's finest panoramas across farmland, estuary, and distant Lakeland fells.", "Near New Abbey, Dumfries and Galloway, Scotland", "Criffel"),
            Place("Nith Estuary Viewpoint", "viewpoint", "A scenic stop for appreciating the river's widening course toward the Solway and the marshy lowland landscape.", "Dumfries area, Dumfries and Galloway, Scotland", "River_Nith", 55.0230, -3.6050),
            Place("Dumfries and Galloway Aviation Museum", "museum", "A specialist museum preserving regional aviation history at the former wartime airfield at Heathhall.", "Heathhall, near Dumfries, Dumfries and Galloway, Scotland", "Dumfries", 55.0920, -3.5700),
            Place("Castledykes Park", "park", "A large urban green space that also recalls the line of Dumfries' former racecourse and leisure grounds.", "Castledykes Road, Dumfries, Dumfries and Galloway, Scotland", "Dumfries", 55.0740, -3.6150),
            Place("Robert Burns Statue", "monument", "A civic monument honouring Burns in the town most closely associated with his final years.", "St Michael Street, Dumfries, Dumfries and Galloway, Scotland", "Robert_Burns", 55.0670, -3.6050),
            Place("Friars Carse", "historic building", "A riverside country house connected with Burns and set in quietly attractive woodland grounds.", "Auldgirth, near Dumfries, Dumfries and Galloway, Scotland", "Friars_Carse"),
            Place("Ruthwell Cross", "monument", "One of the most important Anglo-Saxon stone monuments in Britain, displayed inside Ruthwell church.", "Ruthwell, near Dumfries, Dumfries and Galloway, Scotland", "Ruthwell_Cross"),
            Place("Comlongon Castle", "castle", "A striking tower castle in Solway lowland scenery, reflecting the fortified world of medieval Nithsdale.", "Clarencefield, near Dumfries, Dumfries and Galloway, Scotland", "Comlongon_Castle"),
            Place("Brow Well", "monument", "The simple well by the Solway is remembered as the place Burns visited during his final illness.", "Brow, near Dumfries, Dumfries and Galloway, Scotland", "Brow_Well"),
            Place("Lochmaben Castle", "castle", "Earthworks and masonry remain from an important royal castle beside the lochs east of Dumfries.", "Lochmaben, near Dumfries, Dumfries and Galloway, Scotland", "Lochmaben_Castle"),
            Place("Morton's Castle", "castle", "A romantic ruin above a loch near Thornhill, prized for its beautiful setting and dramatic reflective views.", "Near Thornhill, Dumfries and Galloway, Scotland", "Morton_Castle"),
            Place("Torthorwald Castle", "castle", "A compact ruined tower and courtyard castle in farmland south-west of Dumfries.", "Torthorwald, near Dumfries, Dumfries and Galloway, Scotland", "Torthorwald_Castle"),
            Place("Burns Mausoleum", "monument", "The grand domed memorial in St Michael's churchyard is one of the most important Burns pilgrimage sites in Scotland.", "St Michael Street, Dumfries, Dumfries and Galloway, Scotland", "Dumfries"),
        ],
    },
    {
        "region": "Dumfries & Galloway",
        "prefecture": "Dumfries and Galloway",
        "city": "Stranraer",
        "file": "stranraer-dumfries-galloway.json",
        "places": [
            Place("Castle of St John", "castle", "A 16th-century tower house in the centre of Stranraer that later served as courthouse, prison, and museum.", "George Street, Stranraer, Dumfries and Galloway, Scotland", "Castle_of_St_John"),
            Place("Stranraer Museum", "museum", "The town museum explores local seafaring, wartime, and ferry-port history in the old harbour town.", "Stranraer, Dumfries and Galloway, Scotland", "Stranraer", 54.9027, -5.0263),
            Place("Logan Botanic Garden", "garden", "Thanks to the Gulf Stream, this celebrated garden grows remarkable tender and exotic plants in southwest Scotland.", "Port Logan, near Stranraer, Dumfries and Galloway, Scotland", "Logan_Botanic_Garden"),
            Place("Glenwhan Garden", "garden", "A scenic hill garden with ponds, colourful planting, and superb views across the Rhins of Galloway.", "Dunragit, near Stranraer, Dumfries and Galloway, Scotland", "Stranraer", 54.8480, -4.9750),
            Place("Mull of Galloway", "coastal feature", "Scotland's southernmost point combines cliff scenery, seabirds, and striking sea views toward Ireland and the Isle of Man.", "Mull of Galloway, near Stranraer, Dumfries and Galloway, Scotland", "Mull_of_Galloway"),
            Place("Portpatrick Harbour", "harbour", "This handsome former fishing village is one of the prettiest coastal stops in southwest Scotland.", "Portpatrick, near Stranraer, Dumfries and Galloway, Scotland", "Portpatrick"),
            Place("Dunskey Castle", "castle", "A dramatic ruin above the sea and gorge near Portpatrick, ideal for short walks and atmospheric photographs.", "Portpatrick, near Stranraer, Dumfries and Galloway, Scotland", "Dunskey_Castle"),
            Place("Southern Upland Way Terminus", "walking route", "The coast-to-coast national trail finishes near Portpatrick, making the area famous with long-distance walkers.", "Portpatrick, near Stranraer, Dumfries and Galloway, Scotland", "Southern_Upland_Way", 54.8424, -5.1176),
            Place("Kennedy's Pass", "scenic route", "This old cliff-hugging road between Portpatrick and Stranraer gives memorable coastal views and a real sense of arrival.", "Near Portpatrick, Dumfries and Galloway, Scotland", "Portpatrick", 54.8688, -5.1160),
            Place("Corsewall Lighthouse", "lighthouse", "A classic lighthouse at the northern tip of the Rhins, facing the busy waters of the North Channel.", "Corsewall Point, near Stranraer, Dumfries and Galloway, Scotland", "Corsewall_Lighthouse"),
            Place("Castle Kennedy Gardens", "garden", "Major landscaped gardens around lochs and the ruins of Castle Kennedy offer one of Galloway's great designed landscapes.", "Castle Kennedy, near Stranraer, Dumfries and Galloway, Scotland", "Castle_Kennedy"),
            Place("Cairnryan Viewpoint", "viewpoint", "The shores near Cairnryan give clear views over Loch Ryan and the modern ferry routes to Northern Ireland.", "Cairnryan, near Stranraer, Dumfries and Galloway, Scotland", "Cairnryan"),
            Place("Agnew Park", "park", "A family-friendly waterside park beside Loch Ryan with gardens, play areas, and an easy walk from town.", "Agnew Crescent, Stranraer, Dumfries and Galloway, Scotland", "Stranraer", 54.9070, -5.0312),
            Place("Ringdoo Sands", "coastal feature", "A quieter Rhins beach backed by dunes and open sea views on the west side of the peninsula.", "Near Stranraer, Dumfries and Galloway, Scotland", "Rhins_of_Galloway", 54.8330, -5.1300),
            Place("Sandhead Bay", "coastal feature", "A broad sandy bay popular for scenic beach walks and dramatic sunsets along the Machars-facing coast.", "Sandhead, near Stranraer, Dumfries and Galloway, Scotland", "Sandhead"),
            Place("Killantringan Lighthouse", "lighthouse", "The isolated lighthouse stands in spectacular cliff scenery north of Portpatrick.", "Near Portpatrick, Dumfries and Galloway, Scotland", "Stranraer", 54.9090, -5.1830),
            Place("Ardwell Gardens", "garden", "A woodland and walled garden close to the coast, combining shelter, colour, and Rhins character.", "Ardwell, near Stranraer, Dumfries and Galloway, Scotland", "Ardwell"),
            Place("Luce Bay", "coastal feature", "The sweeping bay east of the Rhins is important for scenery, birdlife, and open sandy shoreline.", "Luce Bay, near Stranraer, Dumfries and Galloway, Scotland", "Luce_Bay"),
            Place("Stair Haven", "coastal feature", "A small cove with turquoise water and cliffs, popular for short scenic stops on the west coast route.", "Stair Haven, near Stranraer, Dumfries and Galloway, Scotland", "Stranraer"),
            Place("Loch Ryan Shore Walk", "river walk", "Promenades and shore paths make it easy to enjoy views over the sea loch directly from Stranraer.", "Loch Ryan, Stranraer, Dumfries and Galloway, Scotland", "Loch_Ryan", 54.9025, -5.0230),
        ],
    },
    {
        "region": "Dumfries & Galloway",
        "prefecture": "Dumfries and Galloway",
        "city": "Kirkcudbright",
        "file": "kirkcudbright.json",
        "places": [
            Place("Broughton House & Garden", "historic building", "The former home of artist E. A. Hornel preserves his interiors and lovely Japanese-influenced garden.", "High Street, Kirkcudbright, Dumfries and Galloway, Scotland", "Broughton_House"),
            Place("Tolbooth Art Centre", "art centre", "A lively arts venue in the old tolbooth, central to Kirkcudbright's identity as an artists' town.", "Castle Street, Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright"),
            Place("MacLellan's Castle", "castle", "A substantial late 16th-century townhouse-castle built for a wealthy provost in the heart of the town.", "Castle Street, Kirkcudbright, Dumfries and Galloway, Scotland", "MacLellan's_Castle"),
            Place("Kirkcudbright Galleries", "museum", "The principal gallery and museum space celebrates the town's artistic legacy and local history.", "St Mary Street, Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright", 54.8381, -4.0520),
            Place("St Cuthbert's Church Ruins", "heritage site", "A picturesque ruined church beside the Dee, adding a strong medieval note to the harbour town.", "Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright", 54.8374, -4.0481),
            Place("Dundrennan Abbey", "abbey", "This beautiful Cistercian abbey is famous as the last overnight stop in Scotland for Mary Queen of Scots.", "Dundrennan, near Kirkcudbright, Dumfries and Galloway, Scotland", "Dundrennan_Abbey"),
            Place("Threave Castle", "castle", "A powerful island fortress on the Dee, central to the Black Douglas story and one of Galloway's best castle visits.", "Near Castle Douglas, Dumfries and Galloway, Scotland", "Threave_Castle"),
            Place("Threave Garden", "garden", "A varied garden and nature-friendly estate offering formal displays, glasshouses, and woodland walks.", "Near Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas"),
            Place("Fleet Valley National Nature Reserve", "nature reserve", "A rich estuary and woodland reserve where tides, birds, and moorland scenery meet.", "Near Gatehouse of Fleet, Dumfries and Galloway, Scotland", "Gatehouse_of_Fleet"),
            Place("Dee Riverside Walks", "river walk", "Paths beside the River Dee provide easy access to the gentle scenery that frames Kirkcudbright.", "Kirkcudbright, Dumfries and Galloway, Scotland", "River_Dee,_Galloway", 54.8367, -4.0504),
            Place("Kirkcudbright Harbour", "harbour", "The attractive working harbour remains central to the town's look and its long maritime history.", "Harbour Square, Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright", 54.8362, -4.0495),
            Place("Harbour Cottage Gallery", "art centre", "A small independent gallery space that continues the town's strong tradition of visual art.", "Harbour Square, Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright", 54.8365, -4.0493),
            Place("Artists' Town Trail", "heritage site", "A stroll through the lanes and studios explains why painters were drawn to Kirkcudbright's light and setting.", "Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright", 54.8370, -4.0490),
            Place("St Mary's Isle", "coastal feature", "A wooded peninsula and beach area giving fine views back toward the town and out to the estuary.", "St Mary's Isle, near Kirkcudbright, Dumfries and Galloway, Scotland", "St_Mary's_Isle_Priory"),
            Place("Tongland Abbey", "heritage site", "Ruins of an abbey near the Dee bridge crossing, adding another layer to the area's medieval story.", "Tongland, near Kirkcudbright, Dumfries and Galloway, Scotland", "Tongland_Abbey"),
            Place("Galloway Wildlife Conservation Park", "park", "A wildlife attraction showcasing native and exotic species in a family-friendly woodland setting.", "Rainton, near Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright"),
            Place("Torrs Point Viewpoint", "viewpoint", "A coastal lookout west of town with open estuary views and a strong sense of the Solway seascape.", "Near Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright", 54.8250, -4.0850),
            Place("Senwick Shore Walk", "coastal feature", "A quieter stretch of shore and farmland path that captures the softer coastal side of Kirkcudbright Bay.", "Senwick, near Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright", 54.8240, -4.0660),
            Place("Castle Dykes Park", "park", "An accessible local green space on the edge of town, useful for a relaxed walk before or after the galleries.", "Kirkcudbright, Dumfries and Galloway, Scotland", "Kirkcudbright", 54.8395, -4.0550),
            Place("Cardoness Castle", "castle", "A well-preserved tower house near Gatehouse of Fleet that complements a wider day trip from Kirkcudbright.", "Near Gatehouse of Fleet, Dumfries and Galloway, Scotland", "Cardoness_Castle"),
        ],
    },
    {
        "region": "Dumfries & Galloway",
        "prefecture": "Dumfries and Galloway",
        "city": "Castle Douglas",
        "file": "castle-douglas.json",
        "places": [
            Place("Threave Castle", "castle", "A storied island fortress on the Dee, reached by boat and strongly associated with the Black Douglases.", "Near Castle Douglas, Dumfries and Galloway, Scotland", "Threave_Castle"),
            Place("Threave Garden & Estate", "garden", "One of southwest Scotland's standout gardens, mixing formal planting with wider nature-rich estate ground.", "Near Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas"),
            Place("Carlingwark Loch", "park", "The loch at the town's edge gives sailing, birdlife, and easy walking with pleasant views back toward Castle Douglas.", "Carlingwark, Castle Douglas, Dumfries and Galloway, Scotland", "Carlingwark_Loch"),
            Place("Castle Douglas Art Gallery", "art centre", "A small but useful gallery space reflecting the market town's growing creative scene.", "Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas", 54.9395, -3.9302),
            Place("Glenkiln Sculptures", "art centre", "An extraordinary open-air collection of modern sculpture set through a lonely, beautiful pastoral landscape.", "Glenkiln, near Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas"),
            Place("Tongland Power Station Viewpoint", "historic building", "A useful stop for appreciating the hydro-engineering story that transformed parts of Galloway.", "Tongland, near Castle Douglas, Dumfries and Galloway, Scotland", "Galloway_Hydro_Electric_Scheme", 54.8780, -4.1130),
            Place("Loch Ken", "coastal feature", "This long freshwater loch is a major scenic asset for boating, birdwatching, and wide Galloway views.", "Near Castle Douglas, Dumfries and Galloway, Scotland", "Loch_Ken"),
            Place("Castle Douglas Heritage Trail", "heritage site", "A route around the market town highlighting civic buildings, shopfronts, and planned-street character.", "Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas", 54.9392, -3.9300),
            Place("Market Square", "historic area", "The broad main street and square give Castle Douglas its airy identity as a classic Scottish market town.", "King Street, Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas", 54.9391, -3.9298),
            Place("Mossyard Beach", "coastal feature", "A delightful nearby Solway beach with broad sands, sea views, and a gentler coastal feel than the open west coast.", "Mossyard, near Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas", 54.8260, -4.0130),
            Place("Orchardton Tower", "tower", "A rare circular tower house standing in pasture near the Solway, easy to combine with a coastal day out.", "Orchardton, near Castle Douglas, Dumfries and Galloway, Scotland", "Orchardton_Tower"),
            Place("Cardoness Castle", "castle", "A strong, well-preserved late medieval tower house in nearby Fleet country, good for wider-area exploration.", "Near Gatehouse of Fleet, Dumfries and Galloway, Scotland", "Cardoness_Castle"),
            Place("Screel Hill", "viewpoint", "The granite summit gives a tremendous panorama over the Urr estuary, the Solway, and inland Galloway.", "Near Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas"),
            Place("Urr Valley Walk", "walking route", "Valley roads and paths south of town show the gentler farming landscapes that frame Castle Douglas.", "Castle Douglas area, Dumfries and Galloway, Scotland", "River_Urr", 54.9375, -3.9400),
            Place("Carlingwark Town Trail", "walking route", "An easy way to link the loch, parkland, and broad streets of the town on foot.", "Castle Douglas, Dumfries and Galloway, Scotland", "Castle_Douglas", 54.9393, -3.9301),
        ],
    },
    {
        "region": "Dumfries & Galloway",
        "prefecture": "Dumfries and Galloway",
        "city": "Wigtown",
        "file": "wigtown.json",
        "places": [
            Place("Wigtown Book Town", "historic area", "Scotland's National Book Town is packed with bookshops, festival energy, and an unusually literary main street.", "Wigtown, Dumfries and Galloway, Scotland", "Wigtown"),
            Place("Old County Buildings", "historic building", "These imposing civic buildings help explain Wigtown's former status as the county town.", "County Buildings, Wigtown, Dumfries and Galloway, Scotland", "Wigtown", 54.8679, -4.4441),
            Place("Bladnoch Distillery", "distillery", "One of Scotland's southernmost whisky distilleries, set beside the river just outside town.", "Bladnoch, near Wigtown, Dumfries and Galloway, Scotland", "Bladnoch_Distillery"),
            Place("Wigtown Martyrs Memorial", "monument", "A memorial recalling the covenanting women executed here in 1685 during the Killing Times.", "Wigtown, Dumfries and Galloway, Scotland", "Wigtown_Martyrs"),
            Place("Martyrs' Stake", "monument", "The shore site marks where tradition says the Wigtown Martyrs were tied in the Solway mud.", "Wigtown Bay, near Wigtown, Dumfries and Galloway, Scotland", "Wigtown_Martyrs", 54.8649, -4.4487),
            Place("Wigtown Bay National Nature Reserve", "nature reserve", "A major estuarine reserve for waders and wildfowl, with broad muddy flats and changing light.", "Wigtown Bay, near Wigtown, Dumfries and Galloway, Scotland", "Wigtown_Bay"),
            Place("Carsluith Castle", "castle", "A substantial tower house ruin visible from the A75 and a classic historic stop in western Galloway.", "Carsluith, near Wigtown, Dumfries and Galloway, Scotland", "Carsluith_Castle"),
            Place("Cairnholy Chambered Cairns", "archaeological site", "Two striking Neolithic tombs on a hillside, with excellent views over Wigtown Bay.", "Near Wigtown, Dumfries and Galloway, Scotland", "Cairnholy"),
            Place("Galloway House Gardens", "garden", "Historic gardens at Garlieston with a mild-climate planting tradition and sweeping open setting.", "Garlieston, near Wigtown, Dumfries and Galloway, Scotland", "Galloway_House"),
            Place("Torhouse Stone Circle", "archaeological site", "A fine Bronze Age circle and alignment set in open countryside a short drive from Wigtown.", "Near Wigtown, Dumfries and Galloway, Scotland", "Wigtown"),
            Place("Cruggleton Castle", "castle", "A dramatic coastal ruin on sea cliffs, rewarding visitors with history and big views over the Irish Sea.", "Near Sorbie, Wigtown area, Dumfries and Galloway, Scotland", "Cruggleton_Castle"),
            Place("Garlieston Harbour", "harbour", "A small attractive harbour village with wartime Mulberry harbour history and fine bay views.", "Garlieston, near Wigtown, Dumfries and Galloway, Scotland", "Garlieston"),
            Place("Whithorn Priory", "abbey", "One of Scotland's most important early Christian sites, worth the short trip from Wigtown into the Machars.", "Whithorn, near Wigtown, Dumfries and Galloway, Scotland", "Whithorn_Priory"),
            Place("Isle of Whithorn Harbour", "harbour", "A small harbour at the Machars' southern tip with sea views and a strong sense of pilgrimage coast.", "Isle of Whithorn, near Wigtown, Dumfries and Galloway, Scotland", "Isle_of_Whithorn"),
            Place("Machars Heritage Coast Route", "scenic route", "Driving the Machars from Wigtown reveals a rewarding mix of estuary, farmland, coast, and early Christian history.", "Wigtown area, Dumfries and Galloway, Scotland", "Machars", 54.8668, -4.4440),
        ],
    },
    {
        "region": "Dumfries & Galloway",
        "prefecture": "Dumfries and Galloway",
        "city": "New Abbey",
        "file": "new-abbey.json",
        "places": [
            Place("Sweetheart Abbey", "abbey", "The beautiful late 13th-century abbey founded by Devorgilla remains one of southwest Scotland's most moving ruins.", "New Abbey, Dumfries and Galloway, Scotland", "Sweetheart_Abbey"),
            Place("New Abbey Corn Mill", "historic building", "A restored working watermill that vividly shows rural industry beside the village burn.", "New Abbey, Dumfries and Galloway, Scotland", "New_Abbey"),
            Place("Shambellie House", "historic building", "A refined country house near the village, long associated with costume collections and local estate history.", "New Abbey, Dumfries and Galloway, Scotland", "Shambellie_House"),
            Place("Criffel", "hill", "The dominant granite hill of the lower Nith gives magnificent views across the Solway to Cumbria.", "Near New Abbey, Dumfries and Galloway, Scotland", "Criffel"),
            Place("Loch Kindar", "coastal feature", "A small loch and wetland area in the low ground behind the village, adding calm scenery and wildlife interest.", "Near New Abbey, Dumfries and Galloway, Scotland", "New_Abbey", 55.0000, -3.6300),
            Place("Waterloo Monument", "monument", "The hill monument on Criffel adds a striking landmark to walks on the mountain's lower slopes.", "Criffel, near New Abbey, Dumfries and Galloway, Scotland", "Criffel"),
            Place("Mabie Forest", "forest park", "A nearby forest of trails, viewpoints, and cycling routes easily combined with a heritage day in New Abbey.", "Mabie, near New Abbey, Dumfries and Galloway, Scotland", "New_Abbey"),
            Place("7stanes Mabie", "forest park", "A popular trail-centre network drawing riders and walkers to the hills above the Solway plain.", "Mabie Forest, near New Abbey, Dumfries and Galloway, Scotland", "7stanes", 55.0210, -3.6550),
            Place("Shambellie Walled Garden", "garden", "The former estate garden is a peaceful complement to the house and the village's wider heritage sites.", "Shambellie, near New Abbey, Dumfries and Galloway, Scotland", "Shambellie_House", 54.9860, -3.6550),
            Place("Kirkconnel Merse National Nature Reserve", "nature reserve", "Saltmarsh and merse habitat on the Solway coast, rich in birdlife and wide estuary views.", "Near New Abbey, Dumfries and Galloway, Scotland", "New_Abbey"),
            Place("Solway Coast Viewpoint", "viewpoint", "The coastal lowlands around New Abbey offer broad estuary views, changing skies, and distant Lakeland silhouettes.", "New Abbey area, Dumfries and Galloway, Scotland", "Solway_Firth", 54.9770, -3.6400),
            Place("New Abbey Pow Walk", "river walk", "A short gentle walk along the village watercourse, framed by abbey views and the foothills of Criffel.", "New Abbey, Dumfries and Galloway, Scotland", "New_Abbey", 54.9948, -3.6190),
            Place("Lochhouse Tower", "tower", "A small ruined tower house in the New Abbey area, adding another note of medieval defensiveness to the landscape.", "Near New Abbey, Dumfries and Galloway, Scotland", "New_Abbey", 54.9890, -3.6100),
            Place("RSPB Mersehead", "nature reserve", "A highly regarded coastal reserve east of the village, known for birdwatching and dune-to-marsh habitats.", "Southwick, near New Abbey, Dumfries and Galloway, Scotland", "New_Abbey"),
            Place("Shambellie Woods Trail", "walking route", "Woodland tracks around the former estate make an easy scenic addition to the abbey village itself.", "Shambellie, near New Abbey, Dumfries and Galloway, Scotland", "Shambellie_House", 54.9865, -3.6510),
        ],
    },
]


def chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def fetch_wikipedia_metadata(titles: list[str]) -> dict[str, dict[str, Any]]:
    if not titles:
        return {}
    unique_titles = []
    seen = set()
    for title in titles:
        if title and title not in seen:
            seen.add(title)
            unique_titles.append(title)
    metadata: dict[str, dict[str, Any]] = {}
    for batch in chunks(unique_titles, 25):
        params = {
            "action": "query",
            "format": "json",
            "formatversion": 2,
            "redirects": 1,
            "prop": "coordinates",
            "colimit": "max",
            "titles": "|".join(batch),
        }
        url = "https://en.wikipedia.org/w/api.php?" + urlencode(params)
        req = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=30) as resp:
            data = json.load(resp)
        query = data.get("query", {})
        redirects = {item["from"]: item["to"] for item in query.get("redirects", [])}
        normalized = {item["from"]: item["to"] for item in query.get("normalized", [])}
        pages = {page.get("title"): page for page in query.get("pages", []) if "missing" not in page}
        for original in batch:
            title_key = redirects.get(normalized.get(original, original), normalized.get(original, original))
            page = pages.get(title_key)
            if page:
                metadata[original] = page
        time.sleep(0.1)
    return metadata


def build_record(city_meta: dict[str, Any], place: Place, wiki_meta: dict[str, dict[str, Any]], timestamp: str) -> dict[str, Any]:
    page = wiki_meta.get(place.wiki)
    lat = place.lat
    lng = place.lng
    if page and (lat is None or lng is None):
        coords = page.get("coordinates") or []
        if coords:
            lat = round(coords[0]["lat"], 6)
            lng = round(coords[0]["lon"], 6)
    if lat is None or lng is None:
        lat, lng = CITY_CENTRES[city_meta["city"]]

    primary_source = wiki_url(place.wiki)
    source_urls = [primary_source]
    for source in place.sources:
        if source not in source_urls:
            source_urls.append(source)

    return {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(city_meta['prefecture'])}:{nk(city_meta['city'])}:{nk(place.name)}",
        "region": city_meta["region"],
        "prefecture": city_meta["prefecture"],
        "city": city_meta["city"],
        "country": COUNTRY,
        "name": place.name,
        "category": place.category,
        "description": place.description,
        "tips": [],
        "hours": place.hours,
        "hours_status": place.hours_status,
        "station": None,
        "google_place_id": None,
        "lat": lat,
        "lng": lng,
        "address": place.address,
        "rating": None,
        "price_level": None,
        "image_url": None,
        "badges": [],
        "source_urls": source_urls,
        "field_sources": {
            "description": primary_source,
            "lat": primary_source,
            "lng": primary_source,
            "address": primary_source,
        },
        "photo": None,
        "extraction_model": "copilot-cli-knowledge",
        "extraction_status": "extracted",
        "validation_errors": [],
        "approved": False,
        "rejected_reason": None,
        "fetched_at": timestamp,
        "last_verified_at": timestamp,
    }


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")

    all_titles = [place.wiki for city in CITIES for place in city["places"]]
    wiki_meta = fetch_wikipedia_metadata(all_titles)

    summary: list[str] = []
    created_files = 0
    skipped_files = 0
    created_records = 0

    for city in CITIES:
        out_path = OUT_DIR / city["file"]
        if out_path.exists():
            skipped_files += 1
            summary.append(f"SKIPPED {city['file']} (already exists)")
            continue

        records = [build_record(city, place, wiki_meta, timestamp) for place in city["places"]]
        payload = {"records": records}
        out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        created_files += 1
        created_records += len(records)
        summary.append(f"CREATED {city['file']} ({len(records)} records)")

    print(f"Wikipedia metadata loaded for {len(wiki_meta)} titles")
    for line in summary:
        print(line)
    print(f"Summary: created {created_files} files, skipped {skipped_files} files, wrote {created_records} records")
    return 0


if __name__ == "__main__":
    sys.exit(main())
