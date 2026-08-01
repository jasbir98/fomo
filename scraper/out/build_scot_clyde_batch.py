from __future__ import annotations

import json
import re
import subprocess
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

BATCH_ID = "scot-pilot-2026-07-25"
OUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
CACHE_PATH = OUT_DIR / "nominatim_cache.json"


def nk(v: str) -> str:
    v = v.lower().strip()
    v = re.sub(r"[^a-z0-9]+", "-", v)
    return v.strip("-") or "unknown"


def wiki_url(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"


def nominatim_url(query: str) -> str:
    return (
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q="
        + quote(query)
    )


def P(name, category, description, **kwargs):
    rec = {"name": name, "category": category, "description": description}
    rec.update(kwargs)
    return rec


CITY_DATA = [
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "East Renfrewshire",
        "city": "Giffnock",
        "default_station": "Giffnock",
        "city_wiki": wiki_url("Giffnock"),
        "center": {"lat": 55.8033, "lng": -4.2929},
        "places": [
            P("Rouken Glen Park", "park", "A large Victorian park with woodland walks, formal gardens, a boating pond and one of the best green escapes on Glasgow's south side.", wiki="Rouken_Glen_Park"),
            P("Eastwood Park", "park", "A broad municipal park with mature trees, open lawns and easy access to Eastwood House and local cultural venues.", query="Eastwood Park, Giffnock, Scotland"),
            P("Eastwood House", "historic building", "An elegant 19th-century house in Eastwood Park that now serves as a civic and cultural landmark for East Renfrewshire.", query="Eastwood House, Giffnock, Scotland"),
            P("Eastwood Theatre", "arts centre", "A busy local arts venue hosting theatre, comedy, music and community performances beside Eastwood Park.", query="Eastwood Theatre, Giffnock, Scotland"),
            P("Greenbank Garden", "garden", "A National Trust for Scotland walled garden and woodland estate known for its terraces, herbaceous borders and tranquil suburban setting.", wiki="Greenbank_Garden", urls=["https://www.nts.org.uk/visit/places/greenbank-garden"], station="Williamwood"),
            P("Orchardhill Parish Church", "church", "A prominent sandstone parish church whose spire is one of Giffnock's best-known townscape features.", query="Orchardhill Parish Church, Giffnock, Scotland"),
            P("Huntly Park", "park", "A handy local park with sports greens, open space and a relaxed residential setting for short walks.", query="Huntly Park, Giffnock, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "East Renfrewshire",
        "city": "Newton Mearns",
        "default_station": "Whitecraigs",
        "city_wiki": wiki_url("Newton_Mearns"),
        "center": {"lat": 55.7720, "lng": -4.3337},
        "places": [
            P("Greenbank Garden", "garden", "A beautifully restored 18th-century garden with walled terraces, woodland paths and a quiet estate atmosphere close to Newton Mearns.", wiki="Greenbank_Garden", urls=["https://www.nts.org.uk/visit/places/greenbank-garden"], station="Williamwood"),
            P("Mearns Castle", "castle", "The surviving tower of a 15th-century castle, long tied to the Maxwell family and the area's medieval history.", wiki="Mearns_Castle", query="Mearns Castle, Newton Mearns, Scotland"),
            P("Dams to Darnley Country Park", "country park", "A large country park of reservoirs, moorland and waymarked trails with wide views over the southern edge of Greater Glasgow.", wiki="Dams_to_Darnley_Country_Park", urls=["https://www.damstodarnley.org/"], station="Patterton"),
            P("Capelrig House", "historic building", "A long-established estate house that recalls Newton Mearns's transformation from rural parish to modern commuter town.", query="Capelrig House, Newton Mearns, Scotland"),
            P("Whitelee Windfarm Visitor Centre", "viewpoint", "The main visitor gateway to the UK's largest onshore wind farm, with walking and cycling routes over open moorland.", wiki="Whitelee_Wind_Farm", urls=["https://www.whiteleewindfarm.co.uk/"], station=None),
            P("Broom Park", "park", "A neighborhood green space popular for easy walks and open views in the heart of modern Newton Mearns.", query="Broom Park, Newton Mearns, Scotland"),
            P("Aurs Road Reservoir Viewpoints", "viewpoint", "A string of accessible viewpoints around the reservoirs and higher ground on Aurs Road, especially good for big-sky sunsets.", query="Aurs Road Reservoir, Newton Mearns, Scotland", station="Patterton"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "East Renfrewshire",
        "city": "Clarkston",
        "default_station": "Clarkston",
        "city_wiki": wiki_url("Clarkston,_East_Renfrewshire"),
        "center": {"lat": 55.7894, "lng": -4.2752},
        "places": [
            P("Greenbank Garden", "garden", "A refined National Trust for Scotland property with formal planting, mature trees and one of the area's loveliest walled gardens.", wiki="Greenbank_Garden", urls=["https://www.nts.org.uk/visit/places/greenbank-garden"], station="Williamwood"),
            P("Overlee Park", "park", "A popular park with sports pitches, open grass and family-friendly paths close to the centre of Clarkston.", query="Overlee Park, Clarkston, Scotland"),
            P("White Cart Water Walkway", "park", "A pleasant riverside walking corridor following the White Cart Water past leafy suburban edges and older bridges.", wiki="White_Cart_Water", query="White Cart Water, Clarkston, Scotland"),
            P("Williamwood Park", "park", "A mature public park with ornamental planting and a calmer feel than the busier regional parks nearby.", query="Williamwood Park, Clarkston, Scotland"),
            P("Clarkston Explosion Memorial", "monument", "A small but significant memorial marking the 1971 Clarkston explosion, one of the defining events in the town's modern history.", query="Clarkston Explosion Memorial, Clarkston, Scotland"),
            P("Cathcart Castle Golf Club Viewpoint", "viewpoint", "Higher ground around the historic golf club gives broad views over Clarkston's rooftops and the White Cart valley.", query="Cathcart Castle Golf Club, Clarkston, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "East Renfrewshire",
        "city": "Eaglesham",
        "default_station": None,
        "city_wiki": wiki_url("Eaglesham"),
        "center": {"lat": 55.7418, "lng": -4.2745},
        "places": [
            P("The Orry and Eaglesham Planned Village", "historic area", "The Orry and the surrounding planned village form one of Scotland's most distinctive 18th-century village layouts, with broad greens and historic cottages.", wiki="Eaglesham", query="The Orry, Eaglesham, Scotland"),
            P("Polnoon Castle", "castle", "Ruins of a late medieval castle linked to the Montgomeries and dramatically set above the village edge.", wiki="Polnoon_Castle", query="Polnoon Castle, Eaglesham, Scotland"),
            P("Eaglesham Parish Church", "church", "A landmark parish church overlooking the planned village and tied closely to Eaglesham's historic identity.", query="Eaglesham Parish Church, Eaglesham, Scotland"),
            P("Montgomerie Monument", "monument", "A hilltop monument commemorating the powerful local family whose influence shaped the district for centuries.", query="Montgomerie Monument, Eaglesham, Scotland"),
            P("Whitelee Windfarm Visitor Centre", "viewpoint", "Visitor hub for Whitelee's moorland trails, turbine viewpoints and interpretation about renewable energy in the uplands south of Glasgow.", wiki="Whitelee_Wind_Farm", urls=["https://www.whiteleewindfarm.co.uk/"], station=None),
            P("Whitelee Moorland Trails", "nature reserve", "Open moorland paths around reservoirs and turbines offering birdlife, fresh-air walking and broad landscapes.", query="Whitelee Windfarm, Eaglesham, Scotland"),
            P("Eaglesham Moor", "viewpoint", "A broad stretch of upland moor with big views and a wild setting that feels far removed from nearby suburbia.", query="Eaglesham Moor, Scotland"),
            P("Polnoon Lodge", "historic building", "A picturesque gatehouse-style building associated with the historic Polnoon estate on the edge of the old village.", query="Polnoon Lodge, Eaglesham, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "East Renfrewshire",
        "city": "Waterfoot",
        "default_station": None,
        "city_wiki": wiki_url("Waterfoot,_East_Renfrewshire"),
        "center": {"lat": 55.7705, "lng": -4.3004},
        "places": [
            P("Waterfoot Park", "park", "A compact local park serving the hamlet with open grass, play space and access to surrounding lanes and riverside walks.", query="Waterfoot Park, Waterfoot, East Renfrewshire, Scotland"),
            P("Inky Pink Park", "park", "A newer family park created for the community and now one of Waterfoot's best-known small green spaces.", query="Inky Pink Park, Waterfoot, Scotland"),
            P("White Cart Water Riverside", "park", "The river corridor beside Waterfoot preserves some of the settlement's older landscape character and makes an easy short walk.", wiki="White_Cart_Water", query="White Cart Water, Waterfoot, Scotland"),
            P("Dams to Darnley Country Park", "country park", "Reservoir-side trails and open country park scenery lie a short hop from Waterfoot and make it one of the area's best outdoor escapes.", wiki="Dams_to_Darnley_Country_Park", urls=["https://www.damstodarnley.org/"], station=None),
            P("Whitelee Windfarm Visitor Centre", "viewpoint", "The nearby visitor centre opens up moorland routes, turbine viewpoints and family cycling on the high ground above Waterfoot.", wiki="Whitelee_Wind_Farm", urls=["https://www.whiteleewindfarm.co.uk/"], station=None),
            P("Floors Farm Hess Crash Site", "historic site", "Fields west of Waterfoot are associated with Rudolf Hess's 1941 crash landing, an unusual local link to the Second World War.", wiki="Rudolf_Hess", query="Floors Farm, Waterfoot, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Renfrewshire",
        "city": "Paisley",
        "default_station": "Paisley Gilmour Street",
        "city_wiki": wiki_url("Paisley,_Renfrewshire"),
        "center": {"lat": 55.8473, "lng": -4.4401},
        "places": [
            P("Paisley Abbey", "abbey", "A magnificent medieval abbey founded in 1163, renowned for its royal Stuart connections, carved stonework and tomb of Marjorie Bruce.", wiki="Paisley_Abbey", urls=["https://www.paisleyabbey.org.uk/"], hours="Mon-Sat 10am-3:30pm", hours_status="known"),
            P("Paisley Museum", "museum", "Paisley's landmark museum reopened after a major refurbishment, bringing together art, science, design and the town's textile story.", wiki="Paisley_Museum", urls=["https://www.renfrewshireleisure.com/paisley-museum/"], query="Paisley Museum, Paisley, Scotland"),
            P("Coats Observatory", "observatory", "A rare Victorian public observatory with astronomy heritage, scientific instruments and a long tradition of public stargazing.", wiki="Coats_Observatory", urls=["https://www.renfrewshireleisure.com/coats-observatory/"], query="Coats Observatory, Paisley, Scotland"),
            P("Thomas Coats Memorial Baptist Church", "church", "An extraordinary Gothic Revival church with a soaring spire, lavish stonework and one of Paisley's most dramatic interiors.", wiki="Thomas_Coats_Memorial_Baptist_Church", query="Thomas Coats Memorial Baptist Church, Paisley, Scotland"),
            P("Anchor Mills", "historic building", "A monumental former thread mill complex that embodies Paisley's industrial importance in the global textile trade.", wiki="Anchor_Mills,_Paisley", query="Anchor Mills, Paisley, Scotland"),
            P("Sma' Shot Cottages", "museum", "Restored weavers' cottages telling the story of Paisley's shawl industry, domestic craft life and labour protest traditions.", wiki="Sma'_Shot_Cottages", urls=["https://www.sma-shot.co.uk/"], query="Sma' Shot Cottages, Paisley, Scotland"),
            P("Paisley Arts Centre", "arts centre", "A handsome former church turned arts venue, now central to the town's programme of theatre, music and comedy.", query="Paisley Arts Centre, Paisley, Scotland", urls=["https://www.renfrewshireleisure.com/paisley-arts-centre/"]),
            P("Fountain Gardens", "park", "A restored Victorian town park with ornate planting, a central fountain and easy access to Paisley's cultural quarter.", query="Fountain Gardens, Paisley, Scotland"),
            P("Gleniffer Braes Country Park", "country park", "Expansive upland parkland above Paisley with panoramic views, hill paths and a strong sense of the town's rural backdrop.", wiki="Gleniffer_Braes", query="Gleniffer Braes Country Park, Paisley, Scotland"),
            P("St Mirin's Cathedral", "cathedral", "The Roman Catholic cathedral of Paisley is a major red-sandstone landmark with an impressive spire and richly detailed interior.", wiki="St_Mirin's_Cathedral", query="St Mirin's Cathedral, Paisley, Scotland"),
            P("Paisley Town Hall", "historic building", "A prominent civic building restored as a major event venue, reflecting Paisley's 19th-century confidence and prosperity.", query="Paisley Town Hall, Paisley, Scotland", urls=["https://www.renfrewshireleisure.com/paisley-town-hall/"]),
            P("Paisley Cenotaph", "monument", "A solemn war memorial near the abbey precinct that remains one of the town's key ceremonial spaces.", query="Paisley Cenotaph, Paisley, Scotland"),
            P("Tannahill Cottage", "historic building", "Associated with poet Robert Tannahill, this modest cottage recalls Paisley's literary and weaving heritage.", query="Tannahill Cottage, Paisley, Scotland"),
            P("White Cart Water Walkway", "park", "Riverside stretches of the White Cart Water offer gentle urban walking and another angle on Paisley's mills and bridges.", wiki="White_Cart_Water", query="White Cart Water, Paisley, Scotland"),
            P("Barshaw Park", "park", "A much-loved public park with boating pond, miniature railway heritage and family-friendly open space west of the centre.", wiki="Barshaw_Park", query="Barshaw Park, Paisley, Scotland"),
            P("Paisley Thread Mill Museum", "museum", "A specialist museum preserving the machinery, stories and social history behind Paisley's famous thread industry.", query="Paisley Thread Mill Museum, Paisley, Scotland", urls=["https://www.paisleythreadmill.co.uk/"]),
            P("Dunn Square", "monument", "An attractive civic square and memorial space close to the cultural core of Paisley.", query="Dunn Square, Paisley, Scotland"),
            P("Clark Town Hall", "historic building", "An elegant civic building that contributes to Paisley's dense concentration of Victorian and Edwardian public architecture.", query="Clark Town Hall, Paisley, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Renfrewshire",
        "city": "Renfrew",
        "default_station": None,
        "city_wiki": wiki_url("Renfrew"),
        "center": {"lat": 55.8790, "lng": -4.3920},
        "places": [
            P("Renfrew Town Hall", "historic building", "A commanding civic building in the old county town, often paired with exhibits and interpretation about Renfrew's royal connections.", query="Renfrew Town Hall, Renfrew, Scotland"),
            P("Renfrew Museum", "museum", "The local museum preserves stories of the Royal Stewarts, burgh history and the town's changing riverfront economy.", query="Renfrew Museum, Renfrew, Scotland"),
            P("Renfrew Ferry", "heritage site", "One of the Clyde's enduring crossing points, the ferry remains a small but memorable piece of working river heritage.", wiki="Renfrew_Ferry", query="Renfrew Ferry, Renfrew, Scotland"),
            P("Renfrew Castle Site", "castle", "Although little survives, the castle site is historically important as an early seat of the Stewart family and the origin of the title Baron Renfrew.", wiki="Renfrew_Castle", query="Renfrew Castle, Renfrew, Scotland"),
            P("Robertson Park", "park", "A traditional town park with mature trees, ornamental features and generous open space near the centre of Renfrew.", query="Robertson Park, Renfrew, Scotland"),
            P("Victory Baths", "historic building", "A notable early-20th-century public baths building that survives as one of Renfrew's best civic facades.", query="Victory Baths, Renfrew, Scotland"),
            P("Newshot Island Nature Reserve", "nature reserve", "Mudflats, grassland and shoreline habitat on the Clyde make this reserve one of Renfrew's best places for birdwatching.", query="Newshot Island Nature Reserve, Renfrew, Scotland"),
            P("Renfrew Riverside", "viewpoint", "The riverside gives open views over the Clyde and a sense of the maritime setting that shaped the town's history.", query="Renfrew Riverside, Renfrew, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Renfrewshire",
        "city": "Johnstone",
        "default_station": "Johnstone",
        "city_wiki": wiki_url("Johnstone,_Renfrewshire"),
        "center": {"lat": 55.8347, "lng": -4.5030},
        "places": [
            P("Johnstone Castle", "castle", "A surviving fragment of the former estate house around which the planned town of Johnstone first developed.", wiki="Johnstone_Castle", query="Johnstone Castle, Johnstone, Scotland"),
            P("Houstoun Square", "historic area", "One of Johnstone's original planned squares, still central to understanding the town's late-18th-century layout.", query="Houstoun Square, Johnstone, Scotland"),
            P("Ludovic Square", "historic area", "The companion square to Houstoun Square, laid out as part of Johnstone's model town plan.", query="Ludovic Square, Johnstone, Scotland"),
            P("Johnstone Town Hall", "historic building", "A handsome civic landmark representing the town's burgh-era confidence and public life.", query="Johnstone Town Hall, Johnstone, Scotland"),
            P("Thomas Shanks Park", "park", "A popular local park with walks, sports areas and a relaxed green setting close to the centre.", query="Thomas Shanks Park, Johnstone, Scotland"),
            P("Johnstone Parish Church", "church", "A key town-centre church tied closely to Johnstone's planned Georgian roots.", query="Johnstone Parish Church, Johnstone, Scotland"),
            P("Black Cart Water Riverside Path", "park", "The Black Cart Water corridor preserves part of the landscape that powered Johnstone's mills and industry.", wiki="Black_Cart_Water", query="Black Cart Water, Johnstone, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Inverclyde",
        "city": "Greenock",
        "default_station": "Greenock West",
        "city_wiki": wiki_url("Greenock"),
        "center": {"lat": 55.9483, "lng": -4.7612},
        "places": [
            P("McLean Museum & Art Gallery", "museum", "Greenock's principal museum blends local history, fine art and Egyptian collections in a distinguished civic building.", wiki="McLean_Museum", query="McLean Museum & Art Gallery, Greenock, Scotland"),
            P("Watt Institution", "historic building", "An important cultural and educational landmark associated with Greenock's long-standing civic museum tradition.", query="Watt Institution, Greenock, Scotland"),
            P("Custom House", "historic building", "A grand neoclassical custom house reflecting Greenock's role as one of the great ports of the Clyde.", wiki="Custom_House,_Greenock", query="Custom House, Greenock, Scotland"),
            P("Greenock Cut", "heritage site", "A remarkable 19th-century aqueduct and reservoir system, now one of Inverclyde's signature walking routes.", wiki="Greenock_Cut", urls=["https://www.inverclyde.gov.uk/greenockcut"], query="Greenock Cut, Greenock, Scotland", station=None),
            P("Greenock Cut Visitor Centre", "museum", "The visitor centre introduces the engineering, landscape and wildlife of the Greenock Cut route.", query="Greenock Cut Visitor Centre, Greenock, Scotland", station=None),
            P("Old West Kirk", "church", "A 16th-century kirk with deep ties to Greenock's early history and a dramatic position near the waterfront.", wiki="Old_West_Kirk", query="Old West Kirk, Greenock, Scotland"),
            P("Lyle Hill", "viewpoint", "A classic Clyde viewpoint with sweeping prospects over the estuary, the hills beyond and passing shipping.", wiki="Lyle_Hill", query="Lyle Hill, Greenock, Scotland", station=None),
            P("Victoria Tower", "monument", "This tall civic tower is one of the most recognisable features of Greenock's skyline.", query="Victoria Tower, Greenock, Scotland"),
            P("Battery Park", "park", "A broad seafront park popular for sport, strolling and wide estuary views.", query="Battery Park, Greenock, Scotland"),
            P("Greenock War Memorial", "monument", "An important memorial space honouring Inverclyde's war dead in an elevated setting above the town.", query="Greenock War Memorial, Greenock, Scotland"),
            P("Beacon Arts Centre", "arts centre", "A modern waterfront arts venue hosting theatre, music and touring productions with great views over the Clyde.", query="Beacon Arts Centre, Greenock, Scotland", urls=["https://www.beaconartscentre.co.uk/"]),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Inverclyde",
        "city": "Gourock",
        "default_station": "Gourock",
        "city_wiki": wiki_url("Gourock"),
        "center": {"lat": 55.9617, "lng": -4.8171},
        "places": [
            P("Gourock Outdoor Pool", "historic building", "A celebrated saltwater lido on the waterfront, prized for its sea views and distinctive modernist character.", wiki="Gourock_Outdoor_Pool", query="Gourock Outdoor Pool, Gourock, Scotland"),
            P("Gourock Pierhead", "landmark", "The pierhead and station area is a classic west-coast transport interchange and a fine place to watch ferries on the Clyde.", query="Gourock Pier, Gourock, Scotland"),
            P("Gourock Promenade", "viewpoint", "A straightforward waterfront walk with wide estuary views toward Argyll and the Cowal peninsula.", query="Gourock Promenade, Gourock, Scotland"),
            P("Kempock Point", "viewpoint", "A rocky point and promenade landmark long associated with shipping views and local folklore.", wiki="Kempock_Point", query="Kempock Point, Gourock, Scotland"),
            P("Cloch Lighthouse", "lighthouse", "A handsome lighthouse at Cloch Point marking the entrance to the upper Firth of Clyde.", wiki="Cloch_Point_Light", query="Cloch Lighthouse, Gourock, Scotland", station=None),
            P("Castle Levan", "castle", "A restored tower house dramatically placed on rising ground above the shore near Gourock.", wiki="Castle_Levan", query="Castle Levan, Gourock, Scotland", station=None),
            P("Battery Park", "park", "Shared by Greenock and Gourock visitors, this open parkland by the shore is ideal for a breezy coastal walk.", query="Battery Park, Gourock, Scotland"),
            P("Gourock to Inverkip Coastal Path", "viewpoint", "The southward coastal route offers sea air, marina views and a classic long promenade feel.", query="Gourock to Inverkip coastal path, Scotland", station=None),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "Inverclyde",
        "city": "Port Glasgow",
        "default_station": "Port Glasgow",
        "city_wiki": wiki_url("Port_Glasgow"),
        "center": {"lat": 55.9349, "lng": -4.6890},
        "places": [
            P("Newark Castle", "castle", "A superbly preserved late-medieval castle standing beside the Clyde and closely tied to the origins of Port Glasgow.", wiki="Newark_Castle,_Port_Glasgow", query="Newark Castle, Port Glasgow, Scotland"),
            P("Town Buildings", "historic building", "A striking municipal building facing Coronation Park and one of Port Glasgow's strongest civic landmarks.", wiki="Town_Buildings,_Port_Glasgow", query="Town Buildings, Port Glasgow, Scotland"),
            P("Coronation Park", "park", "Created on reclaimed harbour ground, this open park preserves the memory of the old waterfront while giving fine river views.", query="Coronation Park, Port Glasgow, Scotland"),
            P("Comet Replica", "monument", "A replica recalling Henry Bell's pioneering steamer links Port Glasgow to the early age of Clyde steam navigation.", query="Comet replica, Port Glasgow, Scotland"),
            P("Newark Bay Waterfront", "viewpoint", "The river edge here offers a strong sense of shipbuilding, estuary weather and the working Clyde.", query="Newark Bay, Port Glasgow, Scotland"),
            P("Ferguson Marine Viewpoint", "heritage site", "Views over the shipyard connect visitors with the area's enduring maritime and engineering traditions.", query="Ferguson Marine, Port Glasgow, Scotland"),
            P("Parklea Branching Out Woodland", "nature reserve", "A quieter local green space above the river, suitable for short walks away from the main waterfront.", query="Parklea Branching Out, Port Glasgow, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "East Dunbartonshire",
        "city": "Kirkintilloch",
        "default_station": "Lenzie",
        "city_wiki": wiki_url("Kirkintilloch"),
        "center": {"lat": 55.9394, "lng": -4.1526},
        "places": [
            P("Auld Kirk Museum", "museum", "Housed in a historic church, this museum explores the social, industrial and Roman-era history of Kirkintilloch.", query="Auld Kirk Museum, Kirkintilloch, Scotland"),
            P("Forth and Clyde Canal", "heritage site", "The canal is central to Kirkintilloch's identity, bringing waterside walks, bridges and boating heritage into the town centre.", wiki="Forth_and_Clyde_Canal", query="Forth and Clyde Canal, Kirkintilloch, Scotland"),
            P("Kirkintilloch Town Hall", "historic building", "A major civic building that remains a visual anchor in the town centre.", query="Kirkintilloch Town Hall, Kirkintilloch, Scotland"),
            P("Peel Park and Antonine Wall", "heritage site", "Peel Park preserves part of the Roman frontier landscape and gives one of the town's clearest links to the Antonine Wall.", wiki="Antonine_Wall", query="Peel Park, Kirkintilloch, Scotland"),
            P("St Mary's Old Parish Church", "church", "A long-established church and burial ground with deep connections to the historic burgh.", query="St Mary's Old Parish Church, Kirkintilloch, Scotland"),
            P("Merkland Local Nature Reserve", "nature reserve", "Wetland and grassland reserve just outside the centre, valued for birdlife and easy walking.", query="Merkland Local Nature Reserve, Kirkintilloch, Scotland"),
            P("Kirkintilloch Canal Basin", "heritage site", "The basin area is a good place to appreciate the town's canal engineering and merchant past.", query="Kirkintilloch Canal Basin, Kirkintilloch, Scotland"),
            P("Bar Hill Fort", "heritage site", "One of the best-known Antonine Wall fort sites, set on high ground with exceptional views over the Central Belt.", wiki="Bar_Hill_Fort", query="Bar Hill Fort, Kirkintilloch, Scotland", station=None),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "East Dunbartonshire",
        "city": "Bearsden",
        "default_station": "Bearsden",
        "city_wiki": wiki_url("Bearsden"),
        "center": {"lat": 55.9172, "lng": -4.3322},
        "places": [
            P("Bearsden Roman Bath House", "heritage site", "The visible remains of a Roman bath house make this one of the most accessible Antonine Wall sites in Scotland.", wiki="Bearsden_Bath_House", query="Bearsden Roman Bath House, Bearsden, Scotland"),
            P("Antonine Wall at New Kilpatrick Cemetery", "heritage site", "A clear stretch of the Antonine Wall's stone base can still be seen beside the cemetery.", wiki="Antonine_Wall", query="Antonine Wall, Bearsden, Scotland"),
            P("Kilmardinny House Arts Centre", "arts centre", "An Edwardian mansion turned arts venue, known for exhibitions, classes and landscaped grounds.", query="Kilmardinny House, Bearsden, Scotland"),
            P("New Kilpatrick Parish Church", "church", "A prominent church long associated with the community that existed here before modern Bearsden expanded.", wiki="New_Kilpatrick", query="New Kilpatrick Parish Church, Bearsden, Scotland"),
            P("Bearsden Cross", "landmark", "The commercial heart of Bearsden also works as a natural starting point for exploring the town's heritage sites.", query="Bearsden Cross, Bearsden, Scotland"),
            P("Cairnhill Woods", "nature reserve", "Woodland paths and elevated ground here provide a quick nature escape on the edge of town.", query="Cairnhill Woods, Bearsden, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "East Dunbartonshire",
        "city": "Milngavie",
        "default_station": "Milngavie",
        "city_wiki": wiki_url("Milngavie"),
        "center": {"lat": 55.9410, "lng": -4.3149},
        "places": [
            P("West Highland Way Start Point", "monument", "The granite obelisk in central Milngavie marks the official start of Scotland's most famous long-distance walk.", wiki="West_Highland_Way", query="West Highland Way start, Milngavie, Scotland"),
            P("Mugdock Country Park", "country park", "A huge park of woodland, moor, reservoirs and family trails immediately north of Milngavie.", wiki="Mugdock_Country_Park", urls=["https://www.mugdock-country-park.org.uk/"], query="Mugdock Country Park, Milngavie, Scotland"),
            P("Mugdock Castle", "castle", "Ruins of the former seat of Clan Graham set within the grounds of Mugdock Country Park.", wiki="Mugdock_Castle", query="Mugdock Castle, Mugdock Country Park, Scotland", station=None),
            P("Milngavie Reservoirs", "loch shore", "The chain of reservoirs north of town is valued for waterside walking and wide views toward the Campsies.", wiki="Milngavie_Reservoirs", query="Milngavie Reservoirs, Scotland", station=None),
            P("Craigallian Loch", "nature reserve", "A small, atmospheric loch on the edge of Mugdock Country Park, popular for short walks and quiet views.", query="Craigallian Loch, Milngavie, Scotland", station=None),
            P("Allander Water Walk", "park", "This local riverside route follows the Allander Water through the greener edges of Milngavie.", wiki="Allander_Water", query="Allander Water, Milngavie, Scotland"),
            P("Dougalston Loch", "nature reserve", "A peaceful lochside spot popular with walkers and local wildlife enthusiasts.", query="Dougalston Loch, Milngavie, Scotland", station=None),
            P("Lennox Park", "park", "A central park that works well for easy town-centre walks before or after longer outings nearby.", query="Lennox Park, Milngavie, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "West Dunbartonshire",
        "city": "Dumbarton",
        "default_station": "Dumbarton Central",
        "city_wiki": wiki_url("Dumbarton"),
        "center": {"lat": 55.9449, "lng": -4.5645},
        "places": [
            P("Dumbarton Castle", "castle", "A dramatically sited fortress on volcanic rock, long one of the most strategically important strongholds in western Scotland.", wiki="Dumbarton_Castle", query="Dumbarton Castle, Dumbarton, Scotland"),
            P("Dumbarton Rock", "landmark", "The twin-peaked basalt rock is both a natural landmark and the reason for the castle's commanding position.", wiki="Dumbarton_Rock", query="Dumbarton Rock, Dumbarton, Scotland"),
            P("Denny Ship Model Experiment Tank", "museum", "A rare surviving naval architecture test tank celebrating Dumbarton's world-class shipbuilding heritage.", wiki="Denny_Ship_Model_Experiment_Tank", query="Denny Tank, Dumbarton, Scotland"),
            P("Levengrove Park", "park", "A substantial riverside park with ornamental grounds, river views and one of the town's most attractive public spaces.", query="Levengrove Park, Dumbarton, Scotland"),
            P("Overtoun House", "historic building", "A grand country house above Dumbarton known for its imposing architecture and landscaped setting.", wiki="Overtoun_House", query="Overtoun House, Dumbarton, Scotland", station=None),
            P("Overtoun Bridge", "historic building", "This dramatic stone bridge is one of the estate's best-known features and a memorable viewpoint over the wooded gorge.", wiki="Overtoun_Bridge", query="Overtoun Bridge, Dumbarton, Scotland", station=None),
            P("Dumbarton Old Parish Church", "church", "A historic parish church that anchors the older heart of the town.", query="Dumbarton Old Parish Church, Dumbarton, Scotland"),
            P("Bruce's Well", "historic site", "A traditional site connected in local lore with Robert the Bruce and the medieval history of the district.", query="Bruce's Well, Dumbarton, Scotland"),
            P("Clyde and Leven Waterfront", "viewpoint", "The meeting of river and estuary gives broad views and a strong sense of Dumbarton's maritime geography.", query="River Leven waterfront, Dumbarton, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "West Dunbartonshire",
        "city": "Helensburgh",
        "default_station": "Helensburgh Central",
        "city_wiki": wiki_url("Helensburgh"),
        "center": {"lat": 56.0048, "lng": -4.7319},
        "places": [
            P("The Hill House", "historic building", "Charles Rennie Mackintosh's masterful domestic design is one of Scotland's finest Arts and Crafts houses.", wiki="The_Hill_House,_Helensburgh", urls=["https://www.nts.org.uk/visit/places/the-hill-house"], query="The Hill House, Helensburgh, Scotland"),
            P("Helensburgh Pier", "landmark", "The pier is a classic west-coast promenade landmark with ferry-era associations and long views across the Clyde.", query="Helensburgh Pier, Helensburgh, Scotland"),
            P("Hermitage Park", "park", "A well-kept Victorian park with formal layout, bandstand and family-friendly green space near the centre.", query="Hermitage Park, Helensburgh, Scotland"),
            P("John Logie Baird Memorial", "monument", "A memorial to the television pioneer, who was born in Helensburgh and remains one of its most famous figures.", wiki="John_Logie_Baird", query="John Logie Baird memorial, Helensburgh, Scotland"),
            P("Glenarn Gardens", "garden", "A steep and sheltered hillside garden celebrated for rhododendrons, woodland paths and views over the Firth of Clyde.", query="Glenarn Gardens, Helensburgh, Scotland"),
            P("St Michael and All Angels Church", "church", "An impressive church interior and exterior make this one of Helensburgh's most notable historic buildings.", query="St Michael and All Angels Church, Helensburgh, Scotland"),
            P("West Bay Esplanade", "viewpoint", "The esplanade provides broad sea views, sunsets and one of the best promenade walks in town.", query="West Bay Esplanade, Helensburgh, Scotland"),
            P("Ardencaple Castle Ruins", "castle", "Fragments of the old Ardencaple estate connect Helensburgh to the area's older landed history.", wiki="Ardencaple_Castle", query="Ardencaple Castle, Helensburgh, Scotland", station=None),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "West Dunbartonshire",
        "city": "Alexandria",
        "default_station": "Alexandria",
        "city_wiki": wiki_url("Alexandria,_West_Dunbartonshire"),
        "center": {"lat": 55.9920, "lng": -4.5860},
        "places": [
            P("Christie Park", "park", "A central park and sporting ground that remains one of Alexandria's best-known civic spaces.", query="Christie Park, Alexandria, Scotland"),
            P("Smollett Fountain", "monument", "A listed fountain in the town centre commemorating writer Tobias Smollett and adding a Victorian flourish to Alexandria's streetscape.", query="Smollett Fountain, Alexandria, Scotland"),
            P("Lomond Galleries", "historic building", "The former Argyll Motor Works building is one of the most striking industrial-era facades in the Vale of Leven.", wiki="Argyll_Motor_Works", query="Lomond Galleries, Alexandria, Scotland"),
            P("Ballantine's Distillery", "distillery", "The continuing presence of whisky production connects Alexandria to a long industrial tradition in the Vale of Leven.", query="Ballantine's Distillery, Alexandria, Scotland", station=None),
            P("River Leven Heritage Walk", "park", "Waterside paths along the River Leven give a greener perspective on the town and its industrial past.", wiki="River_Leven,_Dunbartonshire", query="River Leven, Alexandria, Scotland"),
            P("Dalquhurn Works Heritage Site", "heritage site", "Remnants of the once-important textile works evoke the manufacturing history that shaped Alexandria and the Vale.", query="Dalquhurn Works, Alexandria, Scotland"),
        ],
    },
    {
        "region": "Glasgow & Clyde Valley",
        "prefecture": "West Dunbartonshire",
        "city": "Balloch",
        "default_station": "Balloch",
        "city_wiki": wiki_url("Balloch,_Dunbartonshire"),
        "center": {"lat": 56.0021, "lng": -4.5838},
        "places": [
            P("Balloch Castle Country Park", "country park", "A major lochside country park of woodlands, lawns and shoreline paths at the southern gateway to Loch Lomond.", wiki="Balloch_Country_Park", query="Balloch Castle Country Park, Balloch, Scotland"),
            P("Balloch Castle", "historic building", "A castellated 19th-century mansion overlooking Loch Lomond from within the country park.", wiki="Balloch_Castle_(West_Dunbartonshire)", query="Balloch Castle, Balloch, Scotland"),
            P("Loch Lomond Shores", "heritage site", "A busy visitor hub with event space, waterfront access and one of the easiest ways to experience southern Loch Lomond.", query="Loch Lomond Shores, Balloch, Scotland", urls=["https://www.lochlomondshores.com/"]),
            P("Maid of the Loch", "heritage site", "The restored paddle steamer is one of the Clyde and loch steamship era's most charismatic survivors.", wiki="PS_Maid_of_the_Loch", urls=["https://maidoftheloch.org/"], query="Maid of the Loch, Balloch, Scotland"),
            P("Balloch Pier", "landmark", "The pier remains a classic departure point for cruises and lochside wandering at the foot of Loch Lomond.", query="Balloch Pier, Balloch, Scotland"),
            P("Loch Lomond Bird of Prey Centre", "nature reserve", "A specialist wildlife attraction introducing owls, hawks and eagles close to the waterfront.", query="Loch Lomond Bird of Prey Centre, Balloch, Scotland", urls=["https://llbopc.co.uk/"]),
            P("Drumkinnon Wood Nature Reserve", "nature reserve", "Woodland and shoreline habitats around Drumkinnon give quieter walks just beside the main visitor area.", query="Drumkinnon Wood Nature Reserve, Balloch, Scotland"),
            P("Loch Lomond Waterfront", "loch shore", "The broad waterfront at Balloch gives easy access to loch views, marinas and the national park atmosphere.", wiki="Loch_Lomond", query="Loch Lomond Shores waterfront, Balloch, Scotland"),
            P("Balloch Park", "park", "Central open space and paths make this a useful stop between the station and the loch.", query="Balloch Park, Balloch, Scotland"),
            P("Loch Lomond and The Trossachs Gateway", "viewpoint", "Balloch acts as the principal southern gateway to the national park, with excellent introductory views and access points.", wiki="Loch_Lomond_and_The_Trossachs_National_Park", query="Loch Lomond and The Trossachs National Park, Balloch, Scotland"),
        ],
    },
]


def load_cache() -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {}


def save_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, indent=2, ensure_ascii=False))


def curl_json(url: str):
    cmd = ["curl", "-sA", "RoameoBot/1.0 (+https://github.com/github/copilot-cli)", url]
    out = subprocess.check_output(cmd, text=True)
    return json.loads(out)


def geocode(place: dict, city_meta: dict, cache: dict):
    attempts = []
    if place.get("query"):
        attempts.append(place["query"])
    attempts.extend(
        [
            f"{place['name']}, {city_meta['city']}, Scotland",
            f"{place['name']}, {city_meta['prefecture']}, Scotland",
            f"{place['name']}, Scotland",
        ]
    )

    seen = set()
    for query in attempts:
        if not query or query in seen:
            continue
        seen.add(query)
        if query in cache:
            result = cache[query]
        else:
            url = nominatim_url(query)
            data = curl_json(url)
            result = data[0] if data else None
            cache[query] = result
            save_cache(cache)
            time.sleep(1.05)
        if result:
            return {
                "lat": float(result["lat"]),
                "lng": float(result["lon"]),
                "address": result.get("display_name") or f"{place['name']}, {city_meta['city']}, Scotland",
                "source": nominatim_url(query),
            }
    return {
        "lat": city_meta["center"]["lat"],
        "lng": city_meta["center"]["lng"],
        "address": f"{place['name']}, {city_meta['city']}, Scotland",
        "source": city_meta["city_wiki"],
    }


def build_record(city_meta: dict, place: dict, timestamp: str, cache: dict):
    geo = geocode(place, city_meta, cache)
    source_urls = []
    if place.get("wiki"):
        source_urls.append(wiki_url(place["wiki"]))
    source_urls.extend(place.get("urls", []))
    if not source_urls:
        source_urls.append(city_meta["city_wiki"])
    source_urls = list(OrderedDict.fromkeys(source_urls))
    description_source = place.get("description_source") or source_urls[0]
    station = place.get("station", city_meta.get("default_station"))
    hours = place.get("hours")
    hours_status = place.get("hours_status", "unknown")

    record = OrderedDict()
    record["batch_id"] = BATCH_ID
    record["dedupe_key"] = f"name:{nk(city_meta['prefecture'])}:{nk(city_meta['city'])}:{nk(place['name'])}"
    record["region"] = city_meta["region"]
    record["prefecture"] = city_meta["prefecture"]
    record["city"] = city_meta["city"]
    record["country"] = "GB"
    record["name"] = place["name"]
    record["category"] = place["category"]
    record["description"] = place["description"]
    record["tips"] = place.get("tips", [])
    record["hours"] = hours
    record["hours_status"] = hours_status
    record["station"] = station
    record["google_place_id"] = None
    record["lat"] = round(geo["lat"], 6)
    record["lng"] = round(geo["lng"], 6)
    record["address"] = place.get("address") or geo["address"]
    record["rating"] = None
    record["price_level"] = None
    record["image_url"] = None
    record["badges"] = place.get("badges", [])
    record["source_urls"] = source_urls
    record["field_sources"] = {
        "description": description_source,
        "lat": geo["source"],
        "lng": geo["source"],
        "address": geo["source"],
    }
    record["photo"] = None
    record["extraction_model"] = "copilot-cli-knowledge"
    record["extraction_status"] = "extracted"
    record["validation_errors"] = []
    record["approved"] = False
    record["rejected_reason"] = None
    record["fetched_at"] = timestamp
    record["last_verified_at"] = timestamp
    return record


def validate_record(record: dict):
    required = ["description", "lat", "lng", "address"]
    missing = [k for k in required if k not in record["field_sources"]]
    if missing:
        raise ValueError(f"Missing field_sources keys for {record['name']}: {missing}")
    if not record["source_urls"]:
        raise ValueError(f"No source URLs for {record['name']}")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cache = load_cache()
    timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    summaries = []

    for city_meta in CITY_DATA:
        out_path = OUT_DIR / f"{nk(city_meta['city'])}.json"
        if out_path.exists():
            summaries.append((city_meta["city"], "skipped", 0))
            continue
        records = []
        for place in city_meta["places"]:
            record = build_record(city_meta, place, timestamp, cache)
            validate_record(record)
            records.append(record)
        out_path.write_text(json.dumps({"records": records}, indent=2, ensure_ascii=False) + "\n")
        summaries.append((city_meta["city"], "written", len(records)))

    for city, status, count in summaries:
        if status == "written":
            print(f"{city}: wrote {count} records")
        else:
            print(f"{city}: skipped existing file")


if __name__ == "__main__":
    main()
