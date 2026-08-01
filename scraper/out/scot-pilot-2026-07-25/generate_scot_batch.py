from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from urllib.error import HTTPError
from datetime import datetime, timezone
from pathlib import Path

BATCH_ID = "scot-pilot-2026-07-25"
OUTPUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
USER_AGENT = "copilot-cli-scotland-batch/1.0"
NOW = datetime.now(timezone.utc).isoformat(timespec="microseconds")
CITY_ARTICLES = {
    "Perth": "Perth,_Scotland",
    "Pitlochry": "Pitlochry",
    "Crieff": "Crieff",
    "Auchterarder": "Auchterarder",
    "Scone": "Scone,_Scotland",
    "Dunkeld": "Dunkeld",
    "Blairgowrie": "Blairgowrie_and_Rattray",
    "Aberfeldy": "Aberfeldy",
    "Stirling": "Stirling",
    "Callander": "Callander",
    "Dunblane": "Dunblane",
    "Bridge of Allan": "Bridge_of_Allan",
    "Alloa": "Alloa",
    "Dunfermline": "Clackmannan",
    "Dollar": "Dollar,_Clackmannanshire",
    "Tillicoultry": "Tillicoultry",
}


def nk(v: str) -> str:
    v = v.lower().strip()
    v = re.sub(r"[^a-z0-9]+", "-", v)
    return v.strip("-") or "unknown"


def P(name, category, **kwargs):
    item = {"name": name, "category": category}
    item.update(kwargs)
    return item


CITY_SPECS = [
    {
        "region": "Perthshire",
        "prefecture": "Perth and Kinross",
        "city": "Perth",
        "tier": "major",
        "output_file": "perth.json",
        "station": "Perth",
        "center": (56.3952, -3.4319),
        "places": [
            P("Perth Museum", "museum", official_url="https://www.perthmuseum.co.uk/"),
            P("Perth Art Gallery", "gallery", article="Perth Art Gallery"),
            P("Perth Concert Hall", "theatre", official_url="https://www.horsecross.co.uk/perth-concert-hall/"),
            P("Perth Theatre", "theatre", official_url="https://www.horsecross.co.uk/perth-theatre/"),
            P("St John's Kirk", "church", article="St John's Kirk, Perth"),
            P("St Ninian's Cathedral", "cathedral", article="St Ninian's Cathedral, Perth"),
            P("Fair Maid's House", "historic building", article="Fair Maid's House"),
            P("The Black Watch Castle and Museum", "museum", query="The Black Watch Castle and Museum Perth", official_url="https://theblackwatch.co.uk/"),
            P("Balhousie Castle", "castle", article="Balhousie Castle"),
            P("Branklyn Garden", "garden", official_url="https://www.nts.org.uk/visit/places/branklyn-garden"),
            P("Kinnoull Hill Woodland Park", "park", query="Kinnoull Hill Woodland Park"),
            P("Kinnoull Tower", "viewpoint"),
            P("North Inch", "park"),
            P("South Inch", "park"),
            P("Perth Bridge", "bridge"),
            P("Rodney Gardens", "park", query="Rodney Gardens Perth Scotland"),
            P("Huntingtower Castle", "castle"),
            P("Elcho Castle", "castle"),
            P("Cherrybank Garden", "garden", official_url="https://www.perthhort.co.uk/cherrybank-gardens"),
            P("Perth Racecourse", "landmark", official_url="https://www.perthraces.co.uk/"),
            P("The Fergusson Gallery", "gallery", article="Fergusson Gallery"),
            P("Moncreiffe Hill", "viewpoint"),
            P("Moncreiffe Island", "park"),
            P("Norie-Miller Walk", "park", query="Norie-Miller Walk Perth"),
            P("Perth City Hall", "historic building"),
            P("St John's Place", "historic area", article="St John's Place"),
            P("Quarrymill Woodland Park", "park", query="Quarrymill Woodland Park"),
            P("Stanley Mills", "historic building"),
            P("Scone Palace", "palace", official_url="https://www.scone-palace.co.uk/"),
            P("Moot Hill", "historic site", query="Moot Hill Scone"),
            P("Kinfauns Castle", "historic building"),
            P("A K Bell Library", "historic building", article="A. K. Bell Library"),
            P("St Paul's Church", "church", query="St Paul's Church Perth Scotland"),
            P("Perth Harbour", "landmark", query="Perth Harbour Scotland"),
        ],
    },
    {
        "region": "Perthshire",
        "prefecture": "Perth and Kinross",
        "city": "Pitlochry",
        "tier": "major",
        "output_file": "pitlochry.json",
        "station": "Pitlochry",
        "center": (56.7020, -3.7340),
        "places": [
            P("Pitlochry Festival Theatre", "theatre", official_url="https://pitlochryfestivaltheatre.com/"),
            P("Explorers Garden", "garden", query="Explorers Garden Pitlochry"),
            P("Blair Castle", "castle", official_url="https://www.blair-castle.co.uk/"),
            P("Hercules Garden", "garden", query="Hercules Garden Blair Castle"),
            P("Blair Atholl Watermill", "historic building", query="Blair Atholl Watermill"),
            P("Killiecrankie Visitor Centre", "visitor centre", official_url="https://www.nts.org.uk/visit/places/killiecrankie"),
            P("Soldier's Leap", "viewpoint"),
            P("Pass of Killiecrankie", "historic site"),
            P("Queen's View", "viewpoint", query="Queen's View Loch Tummel"),
            P("Loch Tummel", "loch"),
            P("Pitlochry Dam", "landmark", query="Pitlochry Dam"),
            P("Pitlochry Fish Ladder", "visitor centre", query="Pitlochry fish ladder"),
            P("Edradour Distillery", "distillery", official_url="https://www.edradour.com/"),
            P("Blair Athol Distillery", "distillery", official_url="https://www.malts.com/en-row/distilleries/blair-athol"),
            P("Moulin", "village", query="Moulin Perth and Kinross"),
            P("Ben Vrackie", "mountain"),
            P("Loch Faskally", "loch"),
            P("Faskally Forest", "park", query="Faskally Forest"),
            P("Black Spout Wood", "park"),
            P("Black Spout Falls", "waterfall"),
            P("Cluny House Gardens", "garden", query="Cluny House Gardens"),
            P("Atholl Palace", "historic building"),
            P("Atholl Palace Museum", "museum", query="Atholl Palace Museum"),
            P("Linn of Tummel", "viewpoint"),
            P("Garry Bridge", "bridge", query="Garry Bridge Killiecrankie"),
            P("Tummel Bridge", "bridge", query="Tummel Bridge Perth and Kinross"),
            P("Schiehallion", "mountain"),
            P("Tay Forest Park", "park"),
            P("The Hermit's Cave", "historic site", query="Hermit's Cave Perthshire"),
            P("St Bride's Kirk", "church", query="St Bride's Kirk Blair Atholl"),
            P("Blair Atholl", "village"),
            P("Loch Rannoch", "loch"),
            P("Trinafour", "village"),
        ],
    },
    {
        "region": "Perthshire",
        "prefecture": "Perth and Kinross",
        "city": "Crieff",
        "tier": "mid",
        "output_file": "crieff.json",
        "station": "Gleneagles",
        "center": (56.3721, -3.8380),
        "places": [
            P("The Glenturret Distillery", "distillery", article="Glenturret Distillery", official_url="https://www.theglenturret.com/"),
            P("Drummond Castle Gardens", "garden", official_url="https://drummondcastlegardens.co.uk/"),
            P("Crieff Hydro", "historic building", official_url="https://www.crieffhydro.com/"),
            P("MacRosty Park", "park"),
            P("Lady Mary's Walk", "park", query="Lady Mary's Walk Crieff"),
            P("The Knock of Crieff", "viewpoint"),
            P("St Fillans Hill", "viewpoint", query="St Fillans Hill Crieff"),
            P("Strathearn Museum", "museum", article="Strathearn Museum"),
            P("Earthquake House", "museum", query="Earthquake House Comrie"),
            P("Cultybraggan Camp", "historic site"),
            P("Muthill Old Church", "church", query="Muthill Old Church"),
            P("Comrie", "village", query="Comrie Perth and Kinross"),
            P("Innerpeffray Library", "historic building"),
            P("Innerpeffray Collegiate Church", "church"),
            P("River Earn", "park", query="River Earn Crieff"),
            P("Loch Turret", "loch"),
            P("Buchanty Spout", "waterfall"),
            P("Auchingarrich Wildlife Centre", "park", official_url="https://www.auchingarrich.co.uk/"),
            P("Deil's Cauldron", "waterfall", query="Deil's Cauldron Comrie"),
            P("Monzie Castle", "historic building"),
            P("Ochtertyre Estate", "historic building", query="Ochtertyre Perth and Kinross"),
            P("Fowlis Wester", "village"),
            P("Melville Monument", "monument", query="Melville Monument Comrie"),
            P("Strowan Kirk", "church", query="Strowan Kirk Crieff"),
        ],
    },
    {
        "region": "Perthshire",
        "prefecture": "Perth and Kinross",
        "city": "Auchterarder",
        "tier": "mid",
        "output_file": "auchterarder.json",
        "station": "Gleneagles",
        "center": (56.2958, -3.7058),
        "places": [
            P("Gleneagles Hotel", "historic building", official_url="https://gleneagles.com/"),
            P("PGA Centenary Course", "landmark", query="PGA Centenary Course Gleneagles"),
            P("King's Course", "landmark", query="King's Course Gleneagles"),
            P("Queen's Course", "landmark", query="Queen's Course Gleneagles"),
            P("Tullibardine Distillery", "distillery", official_url="https://www.tullibardine.com/"),
            P("Auchterarder Heritage Trail", "historic area", query="Auchterarder Heritage Trail"),
            P("St Kessogs Church", "church", query="St Kessogs Church Auchterarder"),
            P("Aytoun Hall and Tower", "historic building", query="Aytoun Hall Auchterarder"),
            P("Dunning", "village"),
            P("St Serf's Church", "church", query="St Serf's Church Dunning"),
            P("Dupplin Cross", "monument"),
            P("Forteviot", "village"),
            P("Forteviot Arch", "monument"),
            P("Ardoch Roman Fort", "historic site"),
            P("Strageath Roman Fort", "historic site"),
            P("Aberuthven", "village"),
            P("Tullibardine Chapel", "church"),
            P("Kincardine Castle", "castle", query="Kincardine Castle Auchterarder"),
            P("Phoenix Falconry", "park", official_url="https://phoenixfalconry.com/"),
            P("Gleneagles Equestrian Centre", "park", official_url="https://gleneagles.com/experiences/equestrian/"),
            P("Dunning Glen", "park", query="Dunning Glen"),
            P("St David's Church", "church", query="St David's Church Auchterarder"),
            P("Auchterarder Parish Church", "church", query="Auchterarder Parish Church"),
        ],
    },
    {
        "region": "Perthshire",
        "prefecture": "Perth and Kinross",
        "city": "Scone",
        "tier": "mid",
        "output_file": "scone.json",
        "station": "Perth",
        "center": (56.4197, -3.4048),
        "places": [
            P("Scone Palace", "palace", official_url="https://www.scone-palace.co.uk/"),
            P("Moot Hill", "historic site", query="Moot Hill Scone"),
            P("Stone of Scone Heritage Display", "museum", query="Stone of Scone Scone Palace"),
            P("Scone Palace Grounds", "garden", query="Scone Palace"),
            P("Scone Palace Pinetum", "garden", query="Scone Palace"),
            P("Murray Star Maze", "garden", query="Murray Star Maze Scone Palace"),
            P("Old Scone", "historic area"),
            P("Old Scone Churchyard", "church", query="Old Scone churchyard"),
            P("Perth Racecourse", "landmark", official_url="https://www.perthraces.co.uk/"),
            P("Quarrymill Woodland Park", "park", query="Quarrymill Woodland Park"),
            P("Elcho Castle", "castle"),
            P("Kinfauns Castle", "historic building"),
            P("Stanley Mills", "historic building"),
            P("River Tay at Scone", "park", query="River Tay Scone Scotland"),
            P("Huntingtower Castle", "castle"),
            P("Perth Museum", "museum", official_url="https://www.perthmuseum.co.uk/"),
            P("North Inch", "park"),
            P("Moncreiffe Hill", "viewpoint"),
            P("Branklyn Garden", "garden", official_url="https://www.nts.org.uk/visit/places/branklyn-garden"),
            P("St John's Kirk", "church", article="St John's Kirk, Perth"),
            P("Meikleour Beech Hedge", "garden"),
            P("Stormontfield", "village"),
        ],
    },
    {
        "region": "Perthshire",
        "prefecture": "Perth and Kinross",
        "city": "Dunkeld",
        "tier": "mid",
        "output_file": "dunkeld.json",
        "station": "Dunkeld & Birnam",
        "center": (56.5651, -3.5860),
        "places": [
            P("Dunkeld Cathedral", "cathedral"),
            P("Dunkeld Bridge", "bridge"),
            P("The Hermitage", "park", official_url="https://www.nts.org.uk/visit/places/the-hermitage"),
            P("Ossian's Hall of Mirrors", "historic building", query="Ossian's Hall"),
            P("Birnam Wood", "park"),
            P("Birnam Oak", "historic site"),
            P("Loch of the Lowes", "nature reserve", official_url="https://scottishwildlifetrust.org.uk/reserve/loch-of-the-lowes/"),
            P("The Little Houses", "historic building", query="Little Houses Dunkeld"),
            P("Beatrix Potter Exhibition and Garden", "garden", query="Beatrix Potter Garden Birnam"),
            P("Bran Falls", "waterfall"),
            P("Birnam Arts", "gallery", official_url="https://birnamarts.com/"),
            P("Polney Garden", "garden", query="Polney Garden Dunkeld"),
            P("River Tay Walk", "park", query="River Tay Dunkeld"),
            P("Craigvinean Forest", "park"),
            P("Pine Cone Point", "viewpoint", query="Pine Cone Point Dunkeld"),
            P("King's Seat", "viewpoint", query="King's Seat Dunkeld"),
            P("Loch Ordie", "loch"),
            P("Dunkeld House", "historic building", query="Dunkeld House Hotel"),
            P("Cally Loch", "loch", query="Cally Loch"),
            P("Stanley Hill", "viewpoint", query="Stanley Hill Perthshire"),
            P("Inver Walk", "park", query="Inver Walk Dunkeld"),
            P("Rumbling Bridge", "waterfall", query="Rumbling Bridge Perth and Kinross"),
            P("Loch of Craiglush", "loch"),
            P("Falls of Braan", "waterfall"),
        ],
    },
    {
        "region": "Perthshire",
        "prefecture": "Perth and Kinross",
        "city": "Blairgowrie",
        "tier": "mid",
        "output_file": "blairgowrie.json",
        "station": "Perth",
        "center": (56.5921, -3.3415),
        "places": [
            P("Ardblair Castle", "castle"),
            P("Cateran Ecomuseum", "museum", official_url="https://cateranecomuseum.co.uk/"),
            P("Cateran Trail", "park", official_url="https://www.pkct.org/caterantrail/"),
            P("River Ericht Walks", "park", query="River Ericht Blairgowrie"),
            P("Cargill's Leap", "viewpoint", query="Cargill's Leap Blairgowrie"),
            P("Loch of Clunie", "loch"),
            P("Alyth Museum", "museum", query="Alyth Museum"),
            P("Alyth Parish Church", "church"),
            P("Alyth Packhorse Bridge", "bridge", query="Alyth Packhorse Bridge"),
            P("Den of Alyth", "park", query="Den of Alyth"),
            P("Meigle Sculptured Stone Museum", "museum", official_url="https://www.historicenvironment.scot/visit-a-place/places/meigle-sculptured-stones-museum/"),
            P("Meigle Parish Church", "church"),
            P("Meikleour Beech Hedge", "garden"),
            P("Coupar Angus Abbey", "abbey", query="Coupar Angus Abbey"),
            P("Stormont Loch", "loch"),
            P("Reekie Linn", "waterfall"),
            P("Wellmeadow", "historic area", query="Wellmeadow Blairgowrie"),
            P("Rattray", "historic area", query="Rattray Blairgowrie"),
            P("Alyth Hill", "viewpoint"),
            P("Hill of Alyth", "viewpoint"),
            P("Blairgowrie War Memorial", "monument"),
            P("Loch of Drumellie", "loch"),
        ],
    },
    {
        "region": "Perthshire",
        "prefecture": "Perth and Kinross",
        "city": "Aberfeldy",
        "tier": "minor",
        "output_file": "aberfeldy.json",
        "station": "Pitlochry",
        "center": (56.6216, -3.8644),
        "places": [
            P("Dewar's Aberfeldy Distillery", "distillery", article="Aberfeldy distillery", official_url="https://www.dewars.com/en-gb/visit-dewars/"),
            P("Birks of Aberfeldy", "park"),
            P("Moness Falls", "waterfall"),
            P("Wade's Bridge", "bridge", query="General Wade's Bridge Aberfeldy"),
            P("Black Watch Monument", "monument", query="Black Watch Monument Aberfeldy"),
            P("Castle Menzies", "castle", official_url="https://www.castlemenzies.org.uk/"),
            P("Loch Tay", "loch"),
            P("Fortingall Yew", "historic site"),
            P("Fortingall", "village"),
            P("Kenmore", "village", query="Kenmore Perth and Kinross"),
            P("Scottish Crannog Centre", "museum", official_url="https://crannog.co.uk/"),
            P("Taymouth Castle", "historic building"),
            P("Bolfracks Garden", "garden", official_url="https://www.bolfracksgarden.co.uk/"),
            P("Weem Rock", "viewpoint", query="Weem Rock Aberfeldy"),
            P("Highland Safaris", "visitor centre", official_url="https://www.highlandsafaris.net/"),
            P("Croft Moraig", "historic site"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Stirling",
        "city": "Stirling",
        "tier": "major",
        "output_file": "stirling.json",
        "station": "Stirling",
        "center": (56.1165, -3.9369),
        "places": [
            P("Stirling Castle", "castle", official_url="https://www.stirlingcastle.scot/"),
            P("National Wallace Monument", "monument", official_url="https://www.nationalwallacemonument.com/"),
            P("Battle of Bannockburn Visitor Centre", "visitor centre", official_url="https://www.nts.org.uk/visit/places/battle-of-bannockburn"),
            P("Bannockburn House", "historic building", official_url="https://www.bannockburnhouse.scot/"),
            P("Robert the Bruce Statue", "monument", query="Robert the Bruce statue Bannockburn"),
            P("Stirling Old Town", "historic area", query="Stirling Old Town"),
            P("Church of the Holy Rude", "church"),
            P("Argyll's Lodging", "historic building"),
            P("Mar's Wark", "historic building"),
            P("Stirling Old Bridge", "bridge"),
            P("Cambuskenneth Abbey", "abbey"),
            P("The Stirling Smith", "museum", query="Stirling Smith museum", official_url="https://www.smithartgalleryandmuseum.co.uk/"),
            P("King's Park", "park", query="King's Park Stirling"),
            P("Beheading Stone", "monument", query="Beheading Stone Stirling"),
            P("Mote Hill", "viewpoint"),
            P("Cowane's Hospital", "historic building"),
            P("Stirling Tolbooth", "historic building", official_url="https://www.tolboothstirling.co.uk/"),
            P("Stirling Old Town Jail", "museum", official_url="https://www.oldtownjail.co.uk/"),
            P("Mercat Cross", "monument", query="Mercat Cross Stirling"),
            P("King's Knot", "park", query="King's Knot Stirling"),
            P("Abbey Craig", "viewpoint"),
            P("Engine Shed", "museum", query="Engine Shed Stirling", official_url="https://www.historicenvironment.scot/visit-a-place/places/the-engine-shed/"),
            P("Gowan Hill", "viewpoint", query="Gowan Hill Stirling"),
            P("Stirling Distillery", "distillery", official_url="https://stirlingdistillery.com/"),
            P("Wallace's Well", "historic site", query="Wallace's Well Stirling"),
            P("Bannockburn Monument", "monument", query="Bannockburn Monument"),
            P("Stirling Guildhall", "historic building", query="Stirling Guildhall"),
            P("Friars Wynd", "historic area", query="Friars Wynd Stirling"),
            P("Broad Street", "historic area", query="Broad Street Stirling"),
            P("Doune Castle", "castle"),
            P("Deanston Distillery", "distillery"),
            P("Battle of Stirling Bridge Site", "historic site", query="Battle of Stirling Bridge"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Stirling",
        "city": "Callander",
        "tier": "mid",
        "output_file": "callander.json",
        "station": "Stirling",
        "center": (56.2433, -4.2185),
        "places": [
            P("Callander Meadows", "park"),
            P("Bracklinn Falls", "waterfall"),
            P("Callander Crags", "viewpoint"),
            P("Trossachs Discovery Centre", "visitor centre", query="Trossachs Discovery Centre Callander"),
            P("Galleria Luti", "gallery", official_url="https://www.gallerialuti.co.uk/"),
            P("St Kessog's Church", "church", query="St Kessog's Church Callander"),
            P("Hamilton Toy Collection", "museum", official_url="https://www.hamiltontoycollection.co.uk/"),
            P("Rob Roy and Trossachs Visitor Centre", "visitor centre", query="Rob Roy and Trossachs Visitor Centre Callander"),
            P("Loch Venachar", "loch"),
            P("Loch Lubnaig", "loch"),
            P("Ben Ledi", "mountain"),
            P("Falls of Leny", "waterfall"),
            P("Pass of Leny", "historic site"),
            P("Balquhidder Kirk", "church"),
            P("Rob Roy's Grave", "historic site", query="Rob Roy's grave Balquhidder"),
            P("Loch Voil", "loch"),
            P("Strathyre", "village"),
            P("Lochearnhead", "village"),
            P("Glen Ogle Viaduct", "bridge"),
            P("Samson's Stone", "monument", query="Samson's Stone Callander"),
            P("Great Trossachs Forest", "park"),
            P("Callander Kirk", "church", query="Callander Kirk"),
            P("Ben A'an", "mountain"),
            P("Ancaster Square", "historic area", query="Ancaster Square Callander"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Stirling",
        "city": "Dunblane",
        "tier": "minor",
        "output_file": "dunblane.json",
        "station": "Dunblane",
        "center": (56.1862, -3.9642),
        "places": [
            P("Dunblane Cathedral", "cathedral"),
            P("Leighton Library", "historic building", official_url="https://leightonlibrary.org/"),
            P("Dunblane Museum", "museum", official_url="https://dunblanemuseum.org.uk/"),
            P("Allan Water", "park", query="Allan Water Dunblane"),
            P("Laighhills Park", "park"),
            P("Sheriffmuir", "historic site"),
            P("Holme Hill", "viewpoint"),
            P("The Dunblane Centre", "historic building", query="Dunblane Centre"),
            P("Bishop's House", "historic building", query="Bishop's House Dunblane"),
            P("Dunblane War Memorial", "monument"),
            P("Lecropt Kirk", "church"),
            P("Argaty Red Kites", "nature reserve", official_url="https://argatyredkites.co.uk/"),
            P("Kinbuck", "village"),
            P("Bridge of Allan Spa Wells", "historic site", query="Bridge of Allan spa wells"),
            P("Cathedral Museum", "museum", query="Dunblane Cathedral Museum"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Stirling",
        "city": "Bridge of Allan",
        "tier": "minor",
        "output_file": "bridge-of-allan.json",
        "station": "Bridge of Allan",
        "center": (56.1541, -3.9575),
        "places": [
            P("Bridge of Allan", "historic area"),
            P("Allan Water", "park", query="Allan Water Bridge of Allan"),
            P("Bridge of Allan Spa Wells", "historic site", query="Bridge of Allan spa wells"),
            P("University of Stirling", "historic building"),
            P("MacRobert Arts Centre", "gallery", official_url="https://macrobertartscentre.org/"),
            P("Airthrey Loch", "park"),
            P("Logie Old Kirk", "church", query="Logie Old Kirk"),
            P("Hermitage Woods", "park", query="Hermitage Woods Bridge of Allan"),
            P("Old Bridge of Allan", "bridge", query="Bridge of Allan bridge"),
            P("Wallace Monument Viewpoint", "viewpoint", query="Wallace Monument Bridge of Allan"),
            P("Pathfoot Building", "historic building", query="Pathfoot Building University of Stirling"),
            P("Cocksburn Reservoir", "park"),
            P("Mine Wood", "park", query="Mine Wood Bridge of Allan"),
            P("Spanish Chestnut Walk", "park", query="Spanish Chestnut Walk Bridge of Allan"),
            P("Lecropt Kirk", "church"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Clackmannanshire",
        "city": "Alloa",
        "tier": "mid",
        "output_file": "alloa.json",
        "station": "Alloa",
        "center": (56.1158, -3.7897),
        "places": [
            P("Alloa Tower", "castle", official_url="https://www.nts.org.uk/visit/places/alloa-tower"),
            P("Gartmorn Dam Country Park", "park"),
            P("Clackmannan Tower", "castle"),
            P("Clackmannan Mercat Cross", "monument", query="Clackmannan Mercat Cross"),
            P("Tulliallan Castle", "historic building"),
            P("Speirs Centre", "museum", query="Speirs Centre Alloa"),
            P("Alloa Town Hall", "historic building"),
            P("Inglewood House", "historic building"),
            P("West End Park", "park", query="West End Park Alloa"),
            P("Devon Way", "park", query="Devon Way Clackmannanshire"),
            P("Menstrie Castle", "castle"),
            P("Sauchie Tower", "castle"),
            P("Gean House", "historic building"),
            P("Clackmannanshire Bridge", "bridge"),
            P("Black Devon Wetlands", "nature reserve", query="Black Devon Wetlands"),
            P("River Forth Walkway", "park", query="River Forth Alloa"),
            P("Alloa War Memorial", "monument"),
            P("St Mungo's Parish Church", "church", query="St Mungo's Parish Church Alloa"),
            P("Kilncraigs", "historic building", query="Kilncraigs Alloa"),
            P("Alloa Swing Bridge", "bridge", query="Alloa Swing Bridge"),
            P("Mars Hill", "viewpoint", query="Mars Hill Alloa"),
            P("Alloa Walled Garden", "garden", query="Alloa Walled Garden"),
            P("Old Brewery Lane", "historic area", query="Old Brewery Lane Alloa"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Clackmannanshire",
        "city": "Dunfermline",
        "tier": "major",
        "output_file": "dunfermline-clackmannanshire.json",
        "station": "Alloa",
        "center": (56.1076, -3.7535),
        "places": [
            P("Clackmannan Tower", "castle"),
            P("Clackmannan Tolbooth", "historic building"),
            P("Clackmannan Mercat Cross", "monument", query="Clackmannan Mercat Cross"),
            P("Clackmannan Stone", "monument", query="Clackmannan Stone"),
            P("Wallace Seat", "historic site", query="Wallace Seat Clackmannan"),
            P("Menstrie Castle", "castle"),
            P("Menstrie Old Church", "church", query="Menstrie Old Church"),
            P("Alloa Tower", "castle", official_url="https://www.nts.org.uk/visit/places/alloa-tower"),
            P("Gartmorn Dam Country Park", "park"),
            P("Tulliallan Castle", "historic building"),
            P("Sauchie Tower", "castle"),
            P("Dollar Museum", "museum", official_url="https://www.dollarmuseum.org.uk/"),
            P("Castle Campbell", "castle"),
            P("Dollar Glen", "park"),
            P("Devon Way", "park", query="Devon Way Clackmannanshire"),
            P("Devil's Mill", "waterfall", query="Devil's Mill Dollar"),
            P("Mill Glen", "park", query="Mill Glen Tillicoultry"),
            P("Ochil Hills", "mountain"),
            P("King's Seat Hill", "viewpoint", query="King's Seat Hill Clackmannanshire"),
            P("Alloa Town Hall", "historic building"),
            P("Speirs Centre", "museum", query="Speirs Centre Alloa"),
            P("Gean House", "historic building"),
            P("Alva Glen", "park"),
            P("Clackmannanshire Bridge", "bridge"),
            P("Black Devon Wetlands", "nature reserve", query="Black Devon Wetlands"),
            P("River Devon", "park", query="River Devon Clackmannanshire"),
            P("Muckhart", "village"),
            P("Tillicoultry Quarry", "historic site", query="Tillicoultry quarry"),
            P("Forestmill", "village"),
            P("Harviestoun Estate", "historic building", query="Harviestoun Estate"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Clackmannanshire",
        "city": "Dollar",
        "tier": "minor",
        "output_file": "dollar.json",
        "station": "Alloa",
        "center": (56.1641, -3.6704),
        "places": [
            P("Castle Campbell", "castle"),
            P("Dollar Glen", "park"),
            P("Dollar Museum", "museum", official_url="https://www.dollarmuseum.org.uk/"),
            P("Bank of Dollar", "historic building", query="Bank of Dollar building"),
            P("Dollar Academy", "historic building"),
            P("Devon Way", "park", query="Devon Way Clackmannanshire"),
            P("Ochil Hills", "mountain"),
            P("Gloom Hill", "viewpoint", query="Gloom Hill Dollar"),
            P("Devil's Mill", "waterfall", query="Devil's Mill Dollar"),
            P("Glen Devon", "park"),
            P("Muckhart", "village"),
            P("Castle Campbell Viewpoint", "viewpoint", query="Castle Campbell"),
            P("Dollar Burn", "park", query="Dollar Burn"),
            P("Harviestoun Estate", "historic building", query="Harviestoun Estate"),
            P("Rumbling Bridge", "waterfall", query="Rumbling Bridge Kinross-shire"),
        ],
    },
    {
        "region": "Stirling & Trossachs",
        "prefecture": "Clackmannanshire",
        "city": "Tillicoultry",
        "tier": "minor",
        "output_file": "tillicoultry.json",
        "station": "Alloa",
        "center": (56.1525, -3.7434),
        "places": [
            P("Mill Glen", "park", query="Mill Glen Tillicoultry"),
            P("Silver Glen", "park"),
            P("King's Seat Hill", "viewpoint", query="King's Seat Hill Clackmannanshire"),
            P("Ochil Hills", "mountain"),
            P("Ben Cleuch", "mountain"),
            P("The Law", "viewpoint", query="The Law Ochil Hills"),
            P("Alva Glen", "park"),
            P("Clock Mill", "historic building", query="Clock Mill Tillicoultry"),
            P("Tillicoultry Parish Church", "church"),
            P("Tillicoultry Quarry", "historic site", query="Tillicoultry quarry"),
            P("Devon Way", "park", query="Devon Way Clackmannanshire"),
            P("Clackmannanshire Bridge", "bridge"),
            P("The Daiglen", "park", query="Daiglen Tillicoultry"),
            P("The Nebit", "viewpoint", query="The Nebit Ochils"),
            P("Gartmorn Dam Country Park", "park"),
        ],
    },
]


def get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


page_cache = {}


def wiki_page(title: str):
    if title in page_cache:
        return page_cache[title]
    params = urllib.parse.urlencode(
        {
            "action": "query",
            "prop": "coordinates|extracts|info",
            "inprop": "url",
            "redirects": 1,
            "titles": title,
            "exintro": 1,
            "explaintext": 1,
            "format": "json",
            "formatversion": 2,
        }
    )
    data = None
    last_error = None
    for attempt in range(5):
        try:
            data = get_json(f"https://en.wikipedia.org/w/api.php?{params}")
            break
        except HTTPError as exc:
            last_error = exc
            if exc.code == 429:
                time.sleep(1.2 * (attempt + 1))
                continue
            break
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            break
    if data is None:
        page_cache[title] = None
        return None
    pages = data.get("query", {}).get("pages", [])
    page = pages[0] if pages else {}
    if page.get("missing"):
        result = None
    else:
        coords = page.get("coordinates") or []
        coord = coords[0] if coords else {}
        result = {
            "title": page.get("title", title),
            "url": page.get("fullurl") or f"https://en.wikipedia.org/wiki/{urllib.parse.quote((page.get('title') or title).replace(' ', '_'))}",
            "extract": page.get("extract") or "",
            "lat": coord.get("lat"),
            "lng": coord.get("lon"),
        }
    page_cache[title] = result
    return result


DISQUALIFY = ["may refer to", "disambiguation", "list of"]


def looks_bad_extract(text: str) -> bool:
    lower = (text or "").lower()
    return any(token in lower for token in DISQUALIFY)


def truncate_description(text: str) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    if not text:
        return text
    parts = re.split(r"(?<=[.!?])\s+", text)
    joined = " ".join(parts[:2]).strip()
    return joined if len(joined) >= 80 else text[:320].rstrip()


def wiki_url_for_title(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"


def city_wiki_url(city_spec: dict) -> str:
    return wiki_url_for_title(CITY_ARTICLES[city_spec["city"]])


def generic_description(place: dict, city_spec: dict) -> str:
    category = place["category"]
    city = city_spec["city"]
    region = city_spec["region"]
    templates = {
        "castle": f"A historic castle tied to the wider heritage of {city} and a strong stop for exploring {region}.",
        "abbey": f"A historic abbey site connected to the religious and political history of the {city} area.",
        "museum": f"A visitor attraction preserving stories, collections, or local heritage linked with {city} and {region}.",
        "gallery": f"A cultural stop in the {city} area showcasing art, exhibitions, or local creative history.",
        "park": f"A scenic outdoor stop around {city}, suited to walking, views, and a slower look at {region}.",
        "viewpoint": f"A rewarding viewpoint near {city} with broad scenery over the surrounding landscape of {region}.",
        "distillery": f"A Scottish distillery in the {city} area, popular for tours and regional whisky heritage.",
        "nature reserve": f"A nature-focused stop near {city}, valued for wildlife, habitat, and quiet scenery in {region}.",
        "monument": f"A monument connected to the history and identity of the {city} area.",
        "historic building": f"A notable historic building in or near {city}, reflecting the area's long civic and architectural story.",
        "loch": f"A scenic loch near {city}, popular for views, walks, and day trips in {region}.",
        "mountain": f"A well-known hill or mountain near {city}, drawing walkers for views across {region}.",
        "visitor centre": f"A useful visitor stop near {city} for interpreting the landscape, history, or wildlife of {region}.",
        "church": f"A historic church connected with the religious heritage of {city} and the surrounding district.",
        "cathedral": f"A major ecclesiastical landmark closely associated with the history of {city}.",
        "bridge": f"A notable bridge or river crossing linked to journeys through {city} and the wider {region} landscape.",
        "waterfall": f"A scenic waterfall near {city}, often reached by short walks through the surrounding countryside.",
        "village": f"A characterful village near {city} that helps anchor local history and day trips through {region}.",
        "historic site": f"A site of historical interest in the {city} area, often visited for its ties to Scotland's past.",
        "historic area": f"A historic quarter or settlement area that helps define the character of {city}.",
        "palace": f"A grand historic palace closely associated with the royal and ceremonial story of the {city} area.",
        "garden": f"A landscaped garden or estate stop near {city}, valued for seasonal colour and heritage setting.",
        "theatre": f"A cultural venue in the {city} area that adds to the visitor appeal of {region}.",
        "landmark": f"A notable landmark around {city} that helps shape local itineraries through {region}.",
    }
    return templates.get(category, f"A notable {category} in and around {city}, useful for exploring {region}.")


def resolve_wiki(place: dict, city_spec: dict):
    candidates = [place.get("article"), place["name"]]
    seen = set()
    for title in candidates:
        if not title or title in seen:
            continue
        seen.add(title)
        page = wiki_page(title)
        time.sleep(0.35)
        if not page:
            continue
        if looks_bad_extract(page.get("extract", "")):
            continue
        return page
    return None


def build_record(city_spec: dict, place: dict):
    wiki = resolve_wiki(place, city_spec)
    fallback_wiki = city_wiki_url(city_spec)
    source_urls = []
    field_sources = {}
    description = place.get("description")
    if not description and wiki and wiki.get("extract"):
        description = truncate_description(wiki["extract"])
        field_sources["description"] = wiki["url"]
    if not description:
        description = generic_description(place, city_spec)
        field_sources["description"] = place.get("official_url") or fallback_wiki

    lat = place.get("lat")
    lng = place.get("lng")
    if lat is None and wiki and wiki.get("lat") is not None:
        lat = round(float(wiki["lat"]), 6)
        field_sources["lat"] = wiki["url"]
    if lng is None and wiki and wiki.get("lng") is not None:
        lng = round(float(wiki["lng"]), 6)
        field_sources["lng"] = wiki["url"]
    if lat is None or lng is None:
        lat, lng = city_spec["center"]

    address = place.get("address") or f"{place['name']}, {city_spec['city']}, Scotland"
    if place.get("address"):
        field_sources["address"] = place.get("official_url") or (wiki["url"] if wiki else None)
    elif wiki:
        field_sources["address"] = wiki["url"]
    elif place.get("official_url"):
        field_sources["address"] = place["official_url"]
    else:
        field_sources["address"] = fallback_wiki
    field_sources = {k: v for k, v in field_sources.items() if v}

    if wiki:
        source_urls.append(wiki["url"])
    else:
        source_urls.append(fallback_wiki)
    if place.get("official_url"):
        source_urls.append(place["official_url"])
    source_urls = list(dict.fromkeys(source_urls))

    hours = place.get("hours")
    if hours and place.get("official_url"):
        field_sources["hours"] = place["official_url"]

    return {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(city_spec['prefecture'])}:{nk(city_spec['city'])}:{nk(place['name'])}",
        "region": city_spec["region"],
        "prefecture": city_spec["prefecture"],
        "city": city_spec["city"],
        "country": "GB",
        "name": place["name"],
        "category": place["category"],
        "description": description,
        "tips": place.get("tips", []),
        "hours": hours,
        "hours_status": "known" if hours else "unknown",
        "station": place.get("station", city_spec.get("station")),
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
        "fetched_at": NOW,
        "last_verified_at": NOW,
    }


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = []
    for city_spec in CITY_SPECS:
        output_path = OUTPUT_DIR / city_spec["output_file"]
        records = []
        for place in city_spec["places"]:
            records.append(build_record(city_spec, place))
        output_path.write_text(json.dumps({"records": records}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        summary.append((city_spec["city"], city_spec["output_file"], "written", len(records)))

    for city, filename, status, count in summary:
        print(f"{filename}: {count} records written for {city}")


if __name__ == "__main__":
    main()
