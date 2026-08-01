from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BATCH_ID = "scot-pilot-2026-07-25"
OUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
USER_AGENT = "Mozilla/5.0 CopilotCLI ScottishPlaces/1.0"
NOW = datetime.now(timezone.utc).isoformat(timespec="microseconds")


def nk(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "unknown"


def P(name, category, wiki=None, area=None, desc=None, station=None, hours=None, badges=None, lat=None, lng=None, address=None, source_urls=None, tips=None):
    return {
        "name": name,
        "category": category,
        "wiki": wiki,
        "area": area,
        "desc": desc,
        "station": station,
        "hours": hours,
        "badges": badges or [],
        "lat": lat,
        "lng": lng,
        "address": address,
        "source_urls": source_urls or [],
        "tips": tips or [],
    }


CITY_DATA = [
    {
        "region": "Angus & Dundee",
        "prefecture": "Angus",
        "city": "Arbroath",
        "output_file": "arbroath.json",
        "city_wiki": "Arbroath",
        "default_station": "Arbroath",
        "places": [
            P("Arbroath Abbey", "abbey", "Arbroath Abbey", area="High Street, Arbroath", badges=["historic-scotland"]),
            P("Arbroath Signal Tower Museum", "museum", "Signal Tower Museum", area="Ladyloan, Arbroath"),
            P("Arbroath Harbour", "harbour", "Arbroath Harbour", area="Harbour, Arbroath"),
            P("Hospitalfield House", "historic house", "Hospitalfield House", area="Westway, Arbroath"),
            P("St Vigeans Sculptured Stones Museum", "museum", "St Vigeans", area="St Vigeans, Arbroath"),
            P("Kerr's Miniature Railway", "heritage railway", "Kerr's Miniature Railway", area="West Links, Arbroath"),
            P("Arbroath Cliffs", "coastal walk", "Arbroath Cliffs", area="Seaton, Arbroath"),
            P("Seaton Cliffs Nature Reserve", "nature reserve", area="Seaton, Arbroath", desc="Clifftop reserve on the south side of Arbroath with dramatic red sandstone stacks, seabird viewpoints and part of the scenic coastal path toward Auchmithie."),
            P("West Links", "park", "West Links, Arbroath", area="West Links, Arbroath"),
            P("Victoria Park", "park", "Victoria Park, Arbroath", area="Arbroath"),
            P("Seaton Den", "nature reserve", area="Seaton, Arbroath", desc="Leafy den cut by the Brothock Water just inland from the coast, popular for short walks and access to the clifftop path."),
            P("Dickmont's Den", "nature reserve", "Dickmont's Den", area="Arbroath"),
            P("Whiting Ness", "viewpoint", area="Arbroath Cliffs", desc="One of the best-known headlands on the Arbroath coast, with sea views, crashing surf and access to the clifftop trail."),
            P("Auchmithie Harbour", "harbour", "Auchmithie", area="Auchmithie"),
            P("Lunan Bay", "beach", "Lunan Bay", area="Lunan Bay"),
            P("Ethie Haven", "harbour", "Ethie Haven", area="Ethie"),
            P("Arbirlot Falls", "waterfall", "Arbirlot", area="Arbirlot", desc="Short woodland walk to a picturesque waterfall on the Elliot Water, a popular inland detour from Arbroath."),
            P("Red Castle", "castle ruins", "Red Castle, Angus", area="Lunan Bay"),
        ],
    },
    {
        "region": "Angus & Dundee",
        "prefecture": "Angus",
        "city": "Montrose",
        "output_file": "montrose.json",
        "city_wiki": "Montrose, Angus",
        "default_station": "Montrose",
        "places": [
            P("Montrose Basin Visitor Centre", "nature reserve", "Montrose Basin", area="Montrose Basin"),
            P("Montrose Museum", "museum", "Montrose Museum", area="Panmure Place, Montrose"),
            P("William Lamb Memorial Studio", "museum", "William Lamb Memorial Studio", area="Market Place, Montrose"),
            P("Montrose Air Station Heritage Centre", "museum", "Montrose Air Station Heritage Centre", area="Waldron Road, Montrose"),
            P("House of Dun", "historic house", "House of Dun", area="House of Dun"),
            P("Montrose Beach", "beach", "Montrose beach", area="Montrose"),
            P("Montrose Links", "golf links", "Montrose Links", area="Montrose"),
            P("Scurdie Ness Lighthouse", "lighthouse", "Scurdie Ness Lighthouse", area="Ferryden"),
            P("Montrose Harbour", "harbour", area="Montrose Harbour", desc="Historic working harbour at the mouth of the South Esk, central to Montrose's maritime and export history."),
            P("Bamse Statue", "monument", "Bamse", area="Mid Links, Montrose"),
            P("Dunninald Castle and Gardens", "historic house", "Dunninald Castle", area="Dunninald"),
            P("Ferryden Harbour", "harbour", "Ferryden", area="Ferryden"),
            P("Langley Park Gardens", "garden", area="Montrose", desc="Public gardens close to the seafront with floral displays and easy access to Montrose beach and links."),
            P("Edzell Castle and Garden", "castle", "Edzell Castle", area="Edzell"),
            P("Brechin Cathedral", "cathedral", "Brechin Cathedral", area="Brechin"),
            P("North Water Viaduct", "historic bridge", "North Water Viaduct", area="North Water Bridge"),
            P("St Cyrus Beach", "beach", "St Cyrus National Nature Reserve", area="St Cyrus"),
            P("St Cyrus National Nature Reserve", "nature reserve", "St Cyrus National Nature Reserve", area="St Cyrus"),
        ],
    },
    {
        "region": "Angus & Dundee",
        "prefecture": "Angus",
        "city": "Forfar",
        "output_file": "forfar.json",
        "city_wiki": "Forfar",
        "default_station": None,
        "places": [
            P("Meffan Museum and Art Gallery", "museum", "Meffan Institute", area="West High Street, Forfar"),
            P("Forfar Loch Country Park", "park", "Forfar Loch Country Park", area="Forfar"),
            P("Balmashanner Hill", "viewpoint", "Balmashanner Hill", area="Forfar"),
            P("Restenneth Priory", "priory", "Restenneth Priory", area="Forfar"),
            P("Glamis Castle", "castle", "Glamis Castle", area="Glamis"),
            P("Angus Folk Museum", "museum", "Angus Folk Museum", area="Glamis"),
            P("Reid Park", "park", area="Forfar", desc="Victorian public park in the centre of Forfar with formal planting, play areas and space for a relaxed stroll."),
            P("Forfar Town and County Hall", "historic building", "Town and County Hall, Forfar", area="The Cross, Forfar"),
            P("Forfar Loch", "wildlife site", area="Forfar", desc="Large loch beside the town, known for waterside walks, birdlife and views back to the Angus countryside."),
            P("Webster Memorial Theatre", "historic building", "Webster Memorial Theatre", area="Forfar"),
            P("Pitmuies Gardens", "garden", "Pitmuies Gardens", area="Guthrie"),
            P("Caddam Wood", "woodland walk", area="Forfar", desc="Quiet woodland and path network on the edge of town, useful for a short nature walk."),
            P("Dunnichen Hill", "viewpoint", "Dunnichen", area="Dunnichen"),
            P("Guthrie Castle", "castle", "Guthrie Castle", area="Guthrie"),
            P("Murton Nature Reserve", "nature reserve", area="Murton, Forfar", desc="Local reserve with lochans, hides and family-friendly paths just outside Forfar."),
        ],
    },
    {
        "region": "Angus & Dundee",
        "prefecture": "Angus",
        "city": "Kirriemuir",
        "output_file": "kirriemuir.json",
        "city_wiki": "Kirriemuir",
        "default_station": None,
        "places": [
            P("J. M. Barrie's Birthplace", "museum", "J. M. Barrie's Birthplace", area="Kirriemuir"),
            P("Kirriemuir Camera Obscura", "viewpoint", "Camera Obscura, Kirriemuir", area="Kirriemuir Hill"),
            P("Gateway to the Glens Museum", "museum", area="Kirriemuir", desc="Local museum telling the story of Kirriemuir, the Angus glens and the people who shaped them."),
            P("Bon Scott Statue", "monument", "Bon Scott statue", area="Bellies Brae, Kirriemuir"),
            P("Airlie Monument", "monument", "Airlie Monument", area="Tulloch Hill"),
            P("Kirriemuir Hill", "viewpoint", area="Kirriemuir", desc="The hill above town gives wide views over Strathmore and houses the famous camera obscura."),
            P("Reekie Linn", "waterfall", "Reekie Linn", area="Glen Isla"),
            P("Glen Clova", "glen", "Glen Clova", area="Glen Clova"),
            P("Glen Isla", "glen", "Glen Isla", area="Glen Isla"),
            P("Lintrathen Loch", "reservoir", "Lintrathen Loch", area="Lintrathen"),
            P("Loch of Kinnordy", "nature reserve", "Loch of Kinnordy", area="Kirriemuir"),
            P("Cortachy Castle", "castle", "Cortachy Castle", area="Cortachy"),
            P("Airlie Castle ruins", "castle ruins", "Airlie Castle", area="Airlie"),
            P("Cat Law", "hill walk", "Cat Law", area="Kirriemuir"),
            P("Eassie Sculptured Stone", "prehistoric site", "Eassie Stone", area="Eassie"),
        ],
    },
    {
        "region": "Angus & Dundee",
        "prefecture": "Angus",
        "city": "Brechin",
        "output_file": "brechin.json",
        "city_wiki": "Brechin",
        "default_station": None,
        "places": [
            P("Brechin Cathedral", "cathedral", "Brechin Cathedral", area="Brechin"),
            P("Brechin Round Tower", "historic tower", "Brechin Round Tower", area="Brechin"),
            P("Brechin Town House Museum", "museum", "Brechin Town House Museum", area="Brechin"),
            P("Caledonian Railway", "heritage railway", "Caledonian Railway (Brechin)", area="Brechin"),
            P("Brechin Castle Centre", "historic estate", area="Brechin", desc="Visitor area on the Brechin Castle estate with gardens, riverside setting and heritage displays."),
            P("Pictavia", "museum", area="Brechin", desc="Visitor centre interpreting Pictish sculpture, symbols and early medieval life in Angus."),
            P("Edzell Castle and Garden", "castle", "Edzell Castle", area="Edzell"),
            P("White Caterthun", "hill fort", "White Caterthun", area="Stracathro"),
            P("Brown Caterthun", "hill fort", "Brown Caterthun", area="Stracathro"),
            P("House of Dun", "historic house", "House of Dun", area="House of Dun"),
            P("Aberlemno Sculptured Stones", "prehistoric site", "Aberlemno Sculptured Stones", area="Aberlemno"),
            P("North Esk Riverside Walk", "walking trail", area="Brechin", desc="Pleasant riverside path along the North Esk with views toward Brechin's cathedral and old bridge."),
            P("Kinnaird Castle", "castle", "Kinnaird Castle", area="Kinnaird"),
            P("Inglis Memorial Hall", "historic building", "Inglis Memorial Hall", area="Brechin"),
            P("Auld Brig of Brechin", "historic bridge", "Auld Brig, Brechin", area="Brechin"),
        ],
    },
    {
        "region": "Angus & Dundee",
        "prefecture": "Dundee City",
        "city": "Dundee",
        "output_file": "dundee.json",
        "city_wiki": "Dundee",
        "default_station": "Dundee",
        "places": [
            P("V&A Dundee", "museum", "V&A Dundee", area="1 Riverside Esplanade, Dundee", hours="10am-5pm daily"),
            P("RRS Discovery", "historic ship", "RRS Discovery", area="Discovery Point, Dundee"),
            P("Discovery Point", "museum", "Discovery Point", area="Riverside, Dundee"),
            P("The McManus: Dundee's Art Gallery and Museum", "museum", "The McManus: Dundee's Art Gallery and Museum", area="Albert Square, Dundee"),
            P("Verdant Works", "museum", "Verdant Works", area="West Henderson's Wynd, Dundee"),
            P("HM Frigate Unicorn", "historic ship", "HMS Unicorn (1824)", area="City Quay, Dundee"),
            P("Dundee Museum of Transport", "museum", area="Market Mews, Dundee", desc="Volunteer-run transport museum covering classic cars, maritime engineering, local railways and Dundee-built vehicles."),
            P("Dundee Contemporary Arts", "gallery", "Dundee Contemporary Arts", area="Nethergate, Dundee"),
            P("Dundee Rep Theatre", "theatre", "Dundee Repertory Theatre", area="Tay Square, Dundee"),
            P("Dundee Science Centre", "science museum", "Dundee Science Centre", area="Greenmarket, Dundee"),
            P("Mills Observatory", "observatory", "Mills Observatory", area="Balgay Park, Dundee"),
            P("Balgay Hill", "park", "Balgay Hill", area="Dundee"),
            P("Dundee Law", "viewpoint", "Dundee Law", area="Dundee"),
            P("Dudhope Castle", "castle", "Dudhope Castle", area="Dundee"),
            P("The Howff", "historic cemetery", "Howff", area="Meadowside, Dundee"),
            P("Old Steeple", "historic tower", "Old Steeple", area="Nethergate, Dundee"),
            P("Caird Hall", "historic building", "Caird Hall", area="City Square, Dundee"),
            P("Desperate Dan Statue", "monument", "Desperate Dan", area="City Square, Dundee"),
            P("Dundee Botanic Garden", "garden", "University of Dundee Botanic Garden", area="Riverside Drive, Dundee"),
            P("Camperdown Country Park", "park", "Camperdown Country Park", area="Dundee"),
            P("Camperdown Wildlife Centre", "wildlife park", area="Camperdown Country Park, Dundee", desc="Small wildlife attraction within Camperdown Country Park, popular with families and close to woodland walks."),
            P("Mains Castle", "castle", "Mains Castle", area="Caird Park, Dundee"),
            P("Claypotts Castle", "castle", "Claypotts Castle", area="West Ferry, Dundee"),
            P("Broughty Castle Museum", "castle", "Broughty Castle", area="Broughty Ferry, Dundee"),
            P("Barnhill Rock Garden", "garden", area="Broughty Ferry, Dundee", desc="Secluded former quarry garden with rockeries, ponds and mature planting near Broughty Ferry."),
            P("Broughty Ferry Beach", "beach", area="Broughty Ferry, Dundee", desc="Sandy estuary beach at the mouth of the Tay, popular for walks and views across to Fife."),
            P("Magdalen Green", "park", "Magdalen Green", area="West End, Dundee"),
            P("Dundee Waterfront", "waterfront", "Dundee Waterfront", area="Riverside, Dundee"),
            P("Cox's Stack", "industrial heritage", "Cox's Stack", area="Lochee, Dundee"),
            P("St Paul's Cathedral", "cathedral", "St Paul's Cathedral, Dundee", area="Nethergate, Dundee"),
        ],
    },
    {
        "region": "Angus & Dundee",
        "prefecture": "Dundee City",
        "city": "Broughty Ferry",
        "output_file": "broughty-ferry.json",
        "city_wiki": "Broughty Ferry",
        "default_station": "Broughty Ferry",
        "places": [
            P("Broughty Castle Museum", "castle", "Broughty Castle", area="Castle Approach, Broughty Ferry"),
            P("Broughty Ferry Beach", "beach", area="Broughty Ferry", desc="Broad sandy beach at the mouth of the Tay with views to Fife and easy access from the esplanade."),
            P("Barnhill Rock Garden", "garden", area="Broughty Ferry", desc="A peaceful rock garden and pond set in a former quarry, one of Broughty Ferry's best hidden green spaces."),
            P("Claypotts Castle", "castle", "Claypotts Castle", area="West Ferry"),
            P("Broughty Ferry Harbour", "harbour", area="Broughty Ferry", desc="Small harbour and marina area beside the castle, still central to the town's waterfront character."),
            P("Broughty Ferry Esplanade", "waterfront", area="Broughty Ferry", desc="Seafront promenade linking the castle, beach and harbour with long views over the Tay estuary."),
            P("Castle Green", "park", area="Broughty Ferry", desc="Open grassy space around Broughty Castle used for events, picnics and estuary views."),
            P("Dawson Park", "park", area="Broughty Ferry", desc="Large public park with ornamental gardens, sports facilities and one of the main green lungs of the Ferry."),
            P("Monifieth Beach", "beach", "Monifieth", area="Monifieth"),
            P("Reres Hill Local Nature Reserve", "nature reserve", area="Broughty Ferry", desc="Wooded urban reserve and hill path offering a short nature escape close to Broughty Ferry centre."),
            P("Broughty Ferry Lifeboat Station", "historic waterfront", area="Broughty Ferry", desc="The modern RNLI station reflects the town's long lifesaving and maritime traditions on the Tay estuary."),
            P("Orchar Park", "park", area="Broughty Ferry", desc="Neighbourhood park with mature trees and open lawns close to the heart of Broughty Ferry."),
            P("Broughty Ferry New Kirk", "historic church", "Broughty Ferry New Kirk", area="Broughty Ferry"),
            P("Barnhill Cemetery viewpoint", "viewpoint", area="Broughty Ferry", desc="Elevated spots around Barnhill give wide views over rooftops to the Tay and Fife coast."),
            P("Dundee Waterfront connections", "waterfront", area="Dundee waterfront", desc="Broughty Ferry makes an easy eastern gateway to Dundee's regenerated waterfront museums and riverside walks."),
        ],
    },
    {
        "region": "Outer Hebrides",
        "prefecture": "Na h-Eileanan Siar",
        "city": "Stornoway",
        "output_file": "stornoway.json",
        "city_wiki": "Stornoway",
        "default_station": "Stornoway Harbour",
        "places": [
            P("Lews Castle", "castle", "Lews Castle", area="Stornoway"),
            P("Museum nan Eilean", "museum", "Museum nan Eilean", area="Lews Castle, Stornoway"),
            P("An Lanntair", "arts centre", "An Lanntair", area="Stornoway Harbour"),
            P("Stornoway Harbour", "harbour", "Stornoway Harbour", area="Stornoway"),
            P("Lews Castle Grounds", "park", area="Stornoway", desc="Extensive woodland walks, lochans and viewpoints around Lews Castle overlooking Stornoway harbour."),
            P("Stornoway Town Hall", "historic building", "Stornoway Town Hall", area="Stornoway"),
            P("Point of Ness", "beach", area="Stornoway", desc="Sandy spit and open shore west of the harbour entrance, popular for sea views and sunsets."),
            P("Cuddy Point", "viewpoint", area="Stornoway", desc="Headland on the edge of Lews Castle grounds with broad views across the harbour and Minch."),
            P("Lewis Loom Centre", "textile heritage", area="Stornoway", desc="Interpretation space and workshop keeping Lewis and Harris weaving traditions visible to visitors."),
            P("Whale Bone Arch", "monument", area="Stornoway Harbour", desc="Distinctive arch beside the harbour made from whale jawbones, long a quirky Stornoway landmark."),
            P("Tiumpan Head Lighthouse", "lighthouse", "Tiumpan Head Lighthouse", area="Point, Lewis"),
            P("Tolsta Beach", "beach", area="North Tolsta", desc="Long sandy Atlantic-facing beach on the east side of Lewis, reached by a scenic drive from Stornoway."),
            P("Garry Beach", "beach", "Garry Beach", area="Tolsta"),
            P("Uig Sands", "beach", "Uig Sands", area="Uig, Lewis"),
            P("Reef Beach", "beach", area="Reef, Lewis", desc="Vast white shell-sand beach on the west side of Lewis with mountain backdrops and big Atlantic skies."),
            P("Mangersta Sea Stacks", "viewpoint", area="Mangersta, Lewis", desc="Remote west coast viewpoint known for sea stacks, surf and some of Lewis's most dramatic scenery."),
            P("Callanish Stones", "prehistoric site", "Callanish Stones", area="Calanais", badges=["unesco-like"]),
            P("Callanish II", "prehistoric site", "Callanish II", area="Calanais"),
            P("Dun Carloway Broch", "broch", "Dun Carloway", area="Carloway"),
            P("Arnol Blackhouse", "historic house", "Arnol Blackhouse", area="Arnol"),
            P("Gearrannan Blackhouse Village", "historic village", "Gearrannan", area="Carloway"),
            P("Shawbost Norse Mill and Kiln", "historic site", "Shawbost Norse Mill and Kiln", area="Shawbost"),
            P("Butt of Lewis Lighthouse", "lighthouse", "Butt of Lewis", area="Port of Ness"),
            P("Port of Ness", "harbour", "Port of Ness", area="Ness"),
            P("Dun Eistean", "historic site", "Dun Eistean", area="Ness"),
            P("Bosta Iron Age House", "archaeological site", "Bosta Iron Age House", area="Great Bernera"),
            P("The Braighe", "viewpoint", "The Braighe", area="Lewis"),
            P("Gallows Hill viewpoint", "viewpoint", area="Stornoway", desc="Open ground above town used for views back over Stornoway and its harbour."),
            P("St Columba's Church", "historic church", "St Columba's Church, Stornoway", area="Stornoway"),
            P("Ness Historical Society Museum", "museum", area="Ness", desc="Small local museum preserving crofting, fishing and island life at the north end of Lewis."),
        ],
    },
    {
        "region": "Outer Hebrides",
        "prefecture": "Na h-Eileanan Siar",
        "city": "Tarbert",
        "output_file": "tarbert-na-h-eileanan-siar.json",
        "city_wiki": "Tarbert, Harris",
        "default_station": "Tarbert Ferry Terminal",
        "places": [
            P("Tarbert Harbour", "harbour", "Tarbert, Harris", area="Tarbert, Harris"),
            P("Isle of Harris Distillery", "distillery", "Harris distillery", area="Tarbert, Harris"),
            P("Harris Tweed Hebrides Mill", "textile heritage", area="Shawbost / Tarbert", desc="Major Harris Tweed producer whose visitor-facing heritage helps explain the island's globally famous cloth."),
            P("Luskentyre Beach", "beach", "Luskentyre", area="Luskentyre"),
            P("Seilebost Beach", "beach", "Seilebost", area="Seilebost"),
            P("Horgabost Beach", "beach", area="Horgabost", desc="Broad shell-sand beach with turquoise water, often paired with a visit to neighbouring Seilebost and Luskentyre."),
            P("Scarista Beach", "beach", "Scarista Beach", area="Scarista"),
            P("Northton Saltings", "wildlife site", "Northton, Isle of Harris", area="Northton"),
            P("St Clement's Church", "church", "St Clement's Church, Rodel", area="Rodel"),
            P("Rodel Harbour", "harbour", area="Rodel", desc="Small harbour beside St Clement's Church, giving a strong sense of old maritime Harris."),
            P("Leverburgh Harbour", "harbour", "Leverburgh", area="Leverburgh"),
            P("Hushinish Beach", "beach", "Hushinish", area="Hushinish"),
            P("Toe Head", "viewpoint", "Toe Head", area="Harris"),
            P("Scalpay Bridge", "bridge", "Scalpay Bridge", area="Scalpay"),
            P("Eilean Glas Lighthouse", "lighthouse", "Eilean Glas Lighthouse", area="Scalpay"),
            P("Scalpay Harbour", "harbour", area="Scalpay", desc="Compact island harbour and village setting connected to Harris by the dramatic Scalpay Bridge."),
            P("Amhuinnsuidhe Castle", "castle", "Amhuinnsuidhe Castle", area="Amhuinnsuidhe"),
            P("Clisham viewpoint", "viewpoint", "Clisham", area="North Harris"),
            P("Ardvourlie Woodland", "woodland walk", area="Tarbert, Harris", desc="Short walking routes through planted woodland just outside Tarbert, unusual in the generally treeless Harris landscape."),
        ],
    },
    {
        "region": "Outer Hebrides",
        "prefecture": "Na h-Eileanan Siar",
        "city": "Lochmaddy",
        "output_file": "lochmaddy.json",
        "city_wiki": "Lochmaddy",
        "default_station": "Lochmaddy Ferry Terminal",
        "places": [
            P("Taigh Chearsabhagh Museum and Arts Centre", "museum", "Taigh Chearsabhagh", area="Lochmaddy"),
            P("Lochmaddy Harbour", "harbour", "Lochmaddy", area="Lochmaddy"),
            P("Uist Sculpture Trail", "art trail", "Uist Sculpture Trail", area="North Uist"),
            P("Balranald Nature Reserve", "nature reserve", "Balranald RSPB reserve", area="Balranald"),
            P("Berneray Beach", "beach", "Berneray", area="Berneray"),
            P("Trinity Temple, Carinish", "historic church", "Trinity Temple, Carinish", area="Carinish"),
            P("Pobull Fhinn", "stone circle", "Pobull Fhinn", area="North Uist"),
            P("Langass Woodland", "woodland walk", area="North Uist", desc="Sheltered woodland trail unusual for the Outer Hebrides, with loch views and wildlife."),
            P("Barpa Langass", "chambered cairn", "Barpa Langass", area="North Uist"),
            P("Baleshare Beach", "beach", "Baleshare", area="Baleshare"),
            P("Sollas Beach", "beach", area="Sollas", desc="Open machair-backed beach on the north coast of North Uist with sweeping Atlantic views."),
            P("Lochmaddy sea eagle viewpoint", "wildlife site", area="Lochmaddy", desc="Lochmaddy's indented sea lochs are one of the better places in North Uist to watch for white-tailed eagles."),
            P("Vallay Strand viewpoint", "viewpoint", area="Vallay", desc="Scenic viewpoint across tidal sands and lochans toward Vallay and the north Uist machair."),
            P("Scolpaig Tower", "folly", "Scolpaig Tower", area="North Uist"),
            P("Traigh Iar Beach", "beach", area="North Uist", desc="A classic west coast Uist beach with pale sand, machair flowers and wide-open Atlantic views."),
        ],
    },
    {
        "region": "Outer Hebrides",
        "prefecture": "Na h-Eileanan Siar",
        "city": "Benbecula",
        "output_file": "benbecula.json",
        "city_wiki": "Benbecula",
        "default_station": "Benbecula Airport",
        "places": [
            P("Balivanich", "village", "Balivanich", area="Balivanich"),
            P("Nunton House", "historic house", area="Nunton", desc="Historic house associated with the Jacobite era and one of the principal old residences on Benbecula."),
            P("Rueval", "viewpoint", "Rueval", area="Benbecula"),
            P("Culla Bay", "beach", area="Culla Bay, Benbecula", desc="Quiet sandy bay on the western side of Benbecula, known for sunsets and island views."),
            P("Borve Castle", "castle ruins", "Borve Castle", area="Borve"),
            P("Lionacleit viewpoint", "viewpoint", area="Lionacleit", desc="Central Benbecula viewpoint over lochs, machair and causeways linking the Uists."),
            P("Benbecula Machair", "wildlife site", area="Benbecula", desc="The island's machair supports flowers, birdlife and wide-open coastal walking."),
            P("South Ford Causeway", "causeway", "South Ford, Outer Hebrides", area="South Ford"),
            P("Griminish Point", "viewpoint", area="Griminish", desc="Shoreline viewpoint over the sea to North Uist with changing light and birdlife."),
            P("Aird Mhor Ferry Terminal", "harbour", "Aird Mhòr", area="Aird Mhor"),
            P("Benbecula Airport viewpoint", "viewpoint", "Benbecula Airport", area="Balivanich"),
            P("Cladh Hallan area", "archaeological site", "Cladh Hallan", area="South Uist"),
            P("Liniclate beach", "beach", area="Liniclate", desc="Open sandy shoreline close to the island's main settlement zone, good for a short coastal stop."),
            P("Kirkibost machair", "wildlife site", area="Kirkibost", desc="Machair and shore habitat on the island's quieter northern side."),
            P("North Ford causeway views", "viewpoint", area="North Ford", desc="Causeway views linking Benbecula with North Uist across broad sea lochs and tidal flats."),
        ],
    },
    {
        "region": "Orkney",
        "prefecture": "Orkney Islands",
        "city": "Kirkwall",
        "output_file": "kirkwall.json",
        "city_wiki": "Kirkwall",
        "default_station": "Kirkwall Travel Centre",
        "places": [
            P("St Magnus Cathedral", "cathedral", "St Magnus Cathedral", area="Kirkwall"),
            P("Bishop's Palace", "palace ruins", "Bishop's Palace, Kirkwall", area="Kirkwall"),
            P("Earl's Palace", "palace ruins", "Earl's Palace, Kirkwall", area="Kirkwall"),
            P("Orkney Museum", "museum", "Orkney Museum", area="Kirkwall"),
            P("Highland Park Distillery", "distillery", "Highland Park distillery", area="Kirkwall"),
            P("Scapa Distillery", "distillery", "Scapa distillery", area="Kirkwall"),
            P("The Peedie Sea", "urban nature reserve", "The Peedie Sea", area="Kirkwall"),
            P("Orkney Wireless Museum", "museum", "Orkney Wireless Museum", area="Kirkwall"),
            P("Tankerness House Gardens", "garden", area="Kirkwall", desc="Formal gardens beside the Orkney Museum offering a quiet pause in the middle of Kirkwall's historic core."),
            P("Kirkwall Harbour", "harbour", area="Kirkwall", desc="Busy harbour that remains one of Orkney's main transport gateways for ferries, yachts and cruise ships."),
            P("St Olaf's Kirk", "historic church", "St Olaf's Church, Kirkwall", area="Kirkwall"),
            P("Scapa Beach", "beach", area="Scapa, Kirkwall", desc="Sheltered sandy bay south of Kirkwall, popular for a coastal walk close to town."),
            P("Italian Chapel", "church", "Italian Chapel", area="Lamb Holm"),
            P("Churchill Barriers", "historic causeway", "Churchill Barriers", area="East Mainland"),
            P("Ring of Brodgar", "prehistoric site", "Ring of Brodgar", area="Stenness", badges=["unesco"]),
            P("Stones of Stenness", "prehistoric site", "Stones of Stenness", area="Stenness", badges=["unesco"]),
            P("Maeshowe", "chambered cairn", "Maeshowe", area="Stenness", badges=["unesco"]),
            P("Broch of Gurness", "broch", "Broch of Gurness", area="Evie"),
            P("Brough of Birsay", "prehistoric site", "Brough of Birsay", area="Birsay"),
            P("Cuween Hill Chambered Cairn", "chambered cairn", "Cuween Hill chambered cairn", area="Finstown"),
            P("Rennibister Earth House", "prehistoric site", "Rennibister Earth House", area="Firth"),
            P("Wideford Hill Chambered Cairn", "chambered cairn", "Wideford Hill chambered cairn", area="Kirkwall"),
            P("Earl's Bu", "historic site", "Earl's Bu", area="Orphir"),
            P("Scapa Flow viewpoint", "viewpoint", "Scapa Flow", area="Mainland, Orkney"),
            P("Tomb of the Eagles", "archaeological site", "Tomb of the Eagles", area="South Ronaldsay"),
            P("Orphir Round Church", "historic church", "Orphir Round Church", area="Orphir"),
            P("Deerness Distillery viewpoint", "viewpoint", area="Deerness", desc="Eastern cliffs and sea views make Deerness a memorable scenic detour from Kirkwall."),
            P("Kirkwall Town Centre", "historic district", area="Kirkwall", desc="Compact Norse-rooted centre of narrow lanes, sandstone buildings and independent shops around the cathedral."),
        ],
    },
    {
        "region": "Orkney",
        "prefecture": "Orkney Islands",
        "city": "Stromness",
        "output_file": "stromness.json",
        "city_wiki": "Stromness",
        "default_station": "Stromness Ferry Terminal",
        "places": [
            P("Stromness Museum", "museum", "Stromness Museum", area="Stromness"),
            P("Pier Arts Centre", "gallery", "Pier Arts Centre", area="Stromness"),
            P("Stromness Harbour", "harbour", "Stromness", area="Stromness"),
            P("Victoria Street", "historic street", area="Stromness", desc="Flagstone lane threading through Stromness's tightly packed old houses and waterfront buildings."),
            P("Hamnavoe", "harbour", "Hamnavoe", area="Stromness"),
            P("Login's Well", "historic site", "Login's Well", area="Stromness"),
            P("Ness Battery", "military heritage", "Ness Battery", area="Stromness"),
            P("Warebeth Beach", "beach", area="Stromness", desc="Small beach and shoreline walk immediately north of town."),
            P("Stromness Golf Club", "golf links", "Stromness Golf Club", area="Stromness"),
            P("Yesnaby Cliffs", "cliff walk", "Yesnaby", area="Sandwick"),
            P("Yesnaby Castle", "sea stack", "Yesnaby Castle sea stack", area="Sandwick"),
            P("Ness of Brodgar", "archaeological site", "Ness of Brodgar", area="Stenness"),
            P("Stones of Stenness", "prehistoric site", "Stones of Stenness", area="Stenness", badges=["unesco"]),
            P("Ring of Brodgar", "prehistoric site", "Ring of Brodgar", area="Stenness", badges=["unesco"]),
            P("Unstan Chambered Cairn", "chambered cairn", "Unstan Chambered Cairn", area="Stromness"),
            P("Hoy ferry terminal", "ferry terminal", area="Stromness", desc="Main departure point for the short crossing to Hoy and its dramatic cliffs and walks."),
            P("Scapa Flow viewpoint", "viewpoint", "Scapa Flow", area="Hoy Sound"),
            P("Stromness townscape", "historic district", area="Stromness", desc="One of Scotland's most atmospheric small port townscapes, packed with eighteenth- and nineteenth-century stone buildings."),
        ],
    },
    {
        "region": "Orkney",
        "prefecture": "Orkney Islands",
        "city": "Skara Brae",
        "output_file": "skara-brae.json",
        "city_wiki": "Skara Brae",
        "default_station": "Stromness Ferry Terminal",
        "places": [
            P("Skara Brae", "archaeological site", "Skara Brae", area="Bay of Skaill", badges=["unesco"]),
            P("Skaill House", "historic house", "Skaill House", area="Bay of Skaill"),
            P("Bay of Skaill", "beach", "Bay of Skaill", area="Skaill"),
            P("Ring of Brodgar", "prehistoric site", "Ring of Brodgar", area="Stenness", badges=["unesco"]),
            P("Stones of Stenness", "prehistoric site", "Stones of Stenness", area="Stenness", badges=["unesco"]),
            P("Maeshowe", "chambered cairn", "Maeshowe", area="Stenness", badges=["unesco"]),
            P("Watch Stone", "standing stone", "Watch Stone", area="Stenness"),
            P("Barnhouse Settlement", "archaeological site", "Barnhouse Settlement", area="Stenness"),
            P("Ness of Brodgar", "archaeological site", "Ness of Brodgar", area="Stenness"),
            P("Brodgar Bridge viewpoint", "viewpoint", area="Stenness", desc="Roadside stop looking across the narrow isthmus between the lochs and toward Ring of Brodgar."),
            P("Loch of Harray", "loch", "Loch of Harray", area="West Mainland"),
            P("Loch of Stenness", "loch", "Loch of Stenness", area="West Mainland"),
            P("Unstan Chambered Cairn", "chambered cairn", "Unstan Chambered Cairn", area="Stromness"),
            P("Cuween Hill Chambered Cairn", "chambered cairn", "Cuween Hill chambered cairn", area="Finstown"),
            P("Yesnaby Cliffs", "cliff walk", "Yesnaby", area="Sandwick"),
            P("Yesnaby Castle", "sea stack", "Yesnaby Castle sea stack", area="Sandwick"),
            P("Marwick Head", "cliff walk", "Marwick Head", area="Birsay"),
            P("Brough of Birsay", "prehistoric site", "Brough of Birsay", area="Birsay"),
            P("Earl's Palace, Birsay", "palace ruins", "Earl's Palace, Birsay", area="Birsay"),
            P("Broch of Gurness", "broch", "Broch of Gurness", area="Evie"),
            P("Corrigall Farm Museum", "museum", "Corrigall Farm Museum", area="Harray"),
            P("Brodgar peninsula viewpoints", "viewpoint", area="Stenness", desc="A series of lay-bys and short walks on the Brodgar isthmus give classic views across the Heart of Neolithic Orkney landscape."),
        ],
    },
    {
        "region": "Shetland",
        "prefecture": "Shetland Islands",
        "city": "Lerwick",
        "output_file": "lerwick.json",
        "city_wiki": "Lerwick",
        "default_station": "Lerwick Harbour",
        "places": [
            P("Shetland Museum and Archives", "museum", "Shetland Museum and Archives", area="Hay's Dock, Lerwick"),
            P("Lerwick Town Hall", "historic building", "Lerwick Town Hall", area="Lerwick"),
            P("Lerwick Harbour", "harbour", area="Lerwick", desc="The port at the heart of the town, central to Shetland's fishing, ferry and offshore history."),
            P("Fort Charlotte", "fort", "Fort Charlotte (Shetland)", area="Lerwick"),
            P("Clickimin Broch", "broch", "Broch of Clickimin", area="Lerwick"),
            P("Shetland Textile Museum", "museum", "Shetland Textile Museum", area="Lerwick"),
            P("Lerwick Tolbooth", "historic building", area="Lerwick", desc="Former courthouse and jail building reflecting the old burgh's civic history."),
            P("Commercial Street", "historic street", area="Lerwick", desc="Stone-built waterfront street lined with traditional buildings, shops and old warehouses."),
            P("The Lodberries", "historic waterfront", "Lodberrie", area="Lerwick"),
            P("Knab", "viewpoint", "The Knab", area="Lerwick"),
            P("Bain's Beach", "beach", area="Lerwick", desc="Town beach below the old harbour, useful for a quick seafront stop and local views."),
            P("Bressay Ferry Terminal", "ferry terminal", area="Lerwick", desc="Ferry point for quick crossings to Bressay, opening up walks and lighthouse views."),
            P("Noss National Nature Reserve", "nature reserve", "Noss National Nature Reserve", area="Bressay"),
            P("Bressay Lighthouse", "lighthouse", "Bressay Lighthouse", area="Bressay"),
            P("Mousa Broch", "broch", "Broch of Mousa", area="Mousa"),
            P("Jarlshof", "archaeological site", "Jarlshof", area="Sumburgh"),
            P("Sumburgh Head Lighthouse", "lighthouse", "Sumburgh Head Lighthouse", area="Sumburgh Head"),
            P("Old Scatness", "archaeological site", "Old Scatness", area="Sumburgh"),
            P("St Ninian's Isle", "beach", "St Ninian's Isle", area="South Mainland"),
            P("Mareel", "arts centre", "Mareel", area="Lerwick"),
            P("Clickimin Loch", "loch", "Clickimin Loch", area="Lerwick"),
            P("Up Helly Aa heritage", "festival heritage", "Up Helly Aa", area="Lerwick"),
            P("Hay's Dock", "historic waterfront", "Hay's Dock", area="Lerwick"),
            P("Gulberwick viewpoint", "viewpoint", area="Gulberwick", desc="Short drive south of Lerwick for broad views back across the harbour and islands."),
            P("Scalloway and west mainland link", "scenic drive", area="Shetland Mainland", desc="Lerwick is the natural base for day trips to Scalloway, west Mainland beaches and southern archaeological sites."),
        ],
    },
    {
        "region": "Shetland",
        "prefecture": "Shetland Islands",
        "city": "Scalloway",
        "output_file": "scalloway.json",
        "city_wiki": "Scalloway",
        "default_station": "Scalloway",
        "places": [
            P("Scalloway Castle", "castle", "Scalloway Castle", area="Scalloway"),
            P("Scalloway Museum", "museum", "Scalloway Museum", area="Scalloway"),
            P("Shetland Bus Memorial", "monument", "Shetland Bus", area="Scalloway"),
            P("Scalloway Waterfront", "waterfront", area="Scalloway", desc="Compact harbourfront with colourful boats, old stores and views across the voe."),
            P("Prince Olav Slipway", "military heritage", area="Scalloway", desc="Historic boatyard slip connected with the wartime Shetland Bus operations."),
            P("West Voe Beach", "beach", area="Scalloway", desc="Small beach and shoreline on the western side of Scalloway suitable for a quick coastal stop."),
            P("Trondra", "causeway", "Trondra", area="Trondra"),
            P("Burra Isle", "island scenery", "Burra Isle", area="Burra"),
            P("Tingwall Loch", "loch", "Tingwall Loch", area="Tingwall"),
            P("Tingwall Kirk", "historic church", "Tingwall Kirk", area="Tingwall"),
            P("Tingwall Airport viewpoint", "viewpoint", area="Tingwall", desc="Aviation viewpoint over the small island airfield used for inter-island flights."),
            P("Weisdale Mill", "gallery", "Weisdale Mill", area="Weisdale"),
            P("Bonhoga Gallery", "gallery", "Bonhoga Gallery", area="Weisdale"),
            P("Meal Beach", "beach", "Meal Beach", area="Burra"),
            P("Minn Beach", "beach", area="Burra", desc="Fine white-sand beach in the Scalloway hinterland, excellent for a scenic detour."),
            P("Papa Stour ferry point", "ferry terminal", area="West Burrafirth", desc="Departure point for trips toward Papa Stour and west Shetland sea scenery."),
        ],
    },
    {
        "region": "Shetland",
        "prefecture": "Shetland Islands",
        "city": "Unst",
        "output_file": "unst.json",
        "city_wiki": "Unst",
        "default_station": "Baltasound",
        "places": [
            P("Hermaness National Nature Reserve", "nature reserve", "Hermaness National Nature Reserve", area="Unst"),
            P("Muckle Flugga Lighthouse", "lighthouse", "Muckle Flugga", area="Unst"),
            P("Muness Castle", "castle", "Muness Castle", area="Unst"),
            P("Norwick Beach", "beach", area="Haroldswick", desc="One of Shetland's finest white-sand beaches, near the north end of Unst."),
            P("Unst Heritage Centre", "museum", "Unst Heritage Centre", area="Haroldswick"),
            P("Haroldswick", "historic village", "Haroldswick", area="Haroldswick"),
            P("Skidbladner Viking Longship", "heritage attraction", "Skidbladner", area="Haroldswick"),
            P("Keen of Hamar", "nature reserve", "Keen of Hamar", area="Unst"),
            P("Loch of Cliff", "loch", area="Unst", desc="Remote freshwater loch amid Unst's open landscape, good for quiet scenery and birdlife."),
            P("Burra Firth viewpoint", "viewpoint", area="Unst", desc="Sheltered inlet and dramatic coastal scenery on the western side of the island."),
            P("Bobby's Bus Shelter", "landmark", "Bobby's Bus Shelter", area="Baltasound"),
            P("Belmont House", "historic house", "Belmont House, Unst", area="Belmont"),
            P("Uyeasound", "harbour", "Uyeasound", area="Uyeasound"),
            P("Balta Sound", "harbour", "Balta Sound", area="Baltasound"),
            P("Out Stack viewpoint", "viewpoint", area="Hermaness", desc="Far-north viewpoint looking toward the UK's northernmost outlying rocks beyond Muckle Flugga."),
        ],
    },
    {
        "region": "Shetland",
        "prefecture": "Shetland Islands",
        "city": "Yell",
        "output_file": "yell.json",
        "city_wiki": "Yell, Shetland",
        "default_station": "Ulsta Ferry Terminal",
        "places": [
            P("Old Haa Museum", "museum", "Old Haa of Brough", area="Burravoe"),
            P("Windhouse", "historic ruins", "Windhouse", area="Yell"),
            P("Otterswick Beach", "beach", area="Yell", desc="Sheltered sandy beach on the east side of the island with quiet coastal walking."),
            P("West Sandwick Beach", "beach", area="West Sandwick", desc="Broad western beach facing the Atlantic, good for big skies and birdlife."),
            P("Yell Sound", "wildlife site", "Yell Sound", area="Yell Sound"),
            P("Basta Voe viewpoint", "viewpoint", area="Basta Voe", desc="Sea-loch viewpoint often used by visitors scanning for otters and occasional orcas."),
            P("Burravoe", "historic village", "Burravoe", area="Burravoe"),
            P("Mid Yell", "village", "Mid Yell", area="Mid Yell"),
            P("Cullivoe Harbour", "harbour", "Cullivoe", area="Cullivoe"),
            P("Lumbister", "nature reserve", "Lumbister", area="Yell"),
            P("Gloup Memorial", "monument", "Gloup Memorial", area="Gloup"),
            P("Sands of Breckon", "beach", area="Breckon", desc="Remote north Yell beach with excellent coastal scenery and a sense of isolation."),
            P("Whale Firth viewpoint", "viewpoint", area="Whale Firth", desc="Scenic inlet and roadside stop looking across one of Yell's deep northern voes."),
            P("Aywick cliffs", "cliff walk", area="Aywick", desc="Rocky coastal scenery and seabird viewpoints on Yell's quieter eastern side."),
            P("Ulsta Ferry Terminal views", "ferry terminal", area="Ulsta", desc="Arrival point for the mainland ferry with immediate views over Yell Sound and the island's interior."),
        ],
    },
]


SUMMARY_CACHE: dict[str, dict | None] = {}


def wiki_url(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"), safe="():,\'&")


def fetch_summary(title: str) -> dict | None:
    if title in SUMMARY_CACHE:
        return SUMMARY_CACHE[title]
    url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title, safe="():'&,!")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.load(resp)
            SUMMARY_CACHE[title] = data
            return data
        except urllib.error.HTTPError as exc:
            if exc.code in {403, 404}:
                SUMMARY_CACHE[title] = None
                return None
            if exc.code == 429 and attempt < 2:
                time.sleep(0.6 * (attempt + 1))
                continue
            SUMMARY_CACHE[title] = None
            return None
        except Exception:
            if attempt < 2:
                time.sleep(0.25 * (attempt + 1))
                continue
            SUMMARY_CACHE[title] = None
            return None
    SUMMARY_CACHE[title] = None
    return None


def clean_description(text: str | None) -> str | None:
    if not text:
        return None
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= 360:
        return text
    sentences = re.split(r"(?<=[.!?])\s+", text)
    out = ""
    for sentence in sentences:
        candidate = (out + " " + sentence).strip()
        if len(candidate) > 360 and out:
            break
        out = candidate
    return out or text[:357].rstrip() + "..."


def build_record(city_meta: dict, place: dict) -> dict:
    place_title = place.get("wiki")
    city_title = city_meta["city_wiki"]
    place_summary = fetch_summary(place_title) if place_title else None
    city_summary = fetch_summary(city_title)
    summary = place_summary or {}

    description = place.get("desc") or clean_description(summary.get("extract"))
    if not description and not place_title:
        description = clean_description((city_summary or {}).get("extract"))
    if not description:
        area = place.get("area") or city_meta["city"]
        description = f"{place['name']} is a {place['category']} stop in or near {area}, suitable for visitors exploring {city_meta['city']} and the surrounding area."

    if place_summary and place_summary.get("content_urls", {}).get("desktop", {}).get("page"):
        place_wiki_url = place_summary["content_urls"]["desktop"]["page"]
    elif place_title:
        place_wiki_url = wiki_url(place_title)
    else:
        place_wiki_url = None

    city_wiki_url = None
    if city_summary and city_summary.get("content_urls", {}).get("desktop", {}).get("page"):
        city_wiki_url = city_summary["content_urls"]["desktop"]["page"]
    else:
        city_wiki_url = wiki_url(city_title)

    source_urls = []
    if place_wiki_url:
        source_urls.append(place_wiki_url)
    elif city_wiki_url:
        source_urls.append(city_wiki_url)
    for extra in place.get("source_urls", []):
        if extra not in source_urls:
            source_urls.append(extra)
    if city_wiki_url and city_wiki_url not in source_urls:
        source_urls.append(city_wiki_url)

    coords = (place_summary or {}).get("coordinates") or {}
    lat = place.get("lat")
    lng = place.get("lng")
    if lat is None and "lat" in coords:
        lat = round(coords["lat"], 6)
    if lng is None and ("lon" in coords or "lng" in coords):
        lng = round(coords.get("lon", coords.get("lng")), 6)

    address = place.get("address")
    if not address:
        area = place.get("area") or city_meta["city"]
        address = f"{area}, Scotland"

    station = place.get("station") or city_meta.get("default_station")

    field_sources = {}
    description_source = place_wiki_url if place_summary else city_wiki_url if (not place_title and city_summary) else None
    if description_source:
        field_sources["description"] = description_source
    if place_wiki_url and lat is not None and place_summary and coords:
        field_sources["lat"] = place_wiki_url
        field_sources["lng"] = place_wiki_url
    if station:
        field_sources["station"] = city_wiki_url

    return {
        "batch_id": BATCH_ID,
        "dedupe_key": f"name:{nk(city_meta['prefecture'])}:{nk(city_meta['city'])}:{nk(place['name'])}",
        "region": city_meta["region"],
        "prefecture": city_meta["prefecture"],
        "city": city_meta["city"],
        "country": "GB",
        "name": place["name"],
        "category": place["category"],
        "description": description,
        "tips": place.get("tips", []),
        "hours": place.get("hours"),
        "hours_status": "known" if place.get("hours") else "unknown",
        "station": station,
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


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    skipped = []
    for city_meta in CITY_DATA:
        out_path = OUT_DIR / city_meta["output_file"]
        if out_path.exists():
            skipped.append((city_meta["city"], city_meta["output_file"]))
            continue
        print(f"BUILDING {city_meta['output_file']}...", flush=True)
        records = [build_record(city_meta, place) for place in city_meta["places"]]
        out_path.write_text(json.dumps({"records": records}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        written.append((city_meta["city"], city_meta["output_file"], len(records)))
        print(f"DONE {city_meta['output_file']}: {len(records)} records", flush=True)

    for city, filename, count in written:
        print(f"WROTE {filename}: {count} records for {city}")
    for city, filename in skipped:
        print(f"SKIPPED {filename}: already exists for {city}")
    print(f"TOTAL_WRITTEN={sum(count for _, _, count in written)}")
    print(f"FILES_WRITTEN={len(written)}")
    print(f"FILES_SKIPPED={len(skipped)}")


if __name__ == "__main__":
    main()
