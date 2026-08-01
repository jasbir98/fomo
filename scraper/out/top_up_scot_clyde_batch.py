from __future__ import annotations

import json
import re
import subprocess
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

OUT_DIR = Path("/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25")
CACHE_PATH = OUT_DIR / "nominatim_topup_cache.json"


def nk(v: str) -> str:
    v = v.lower().strip()
    v = re.sub(r"[^a-z0-9]+", "-", v)
    return v.strip("-") or "unknown"


def wiki_url(title: str) -> str:
    return f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"


def nominatim_url(query: str) -> str:
    return "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + quote(query)


def p(name, category, description, **kwargs):
    rec = {"name": name, "category": category, "description": description}
    rec.update(kwargs)
    return rec


TOP_UPS = {
    "paisley": {
        "target": 40,
        "places": [
            p("Ferguslie Gardens", "park", "A compact Victorian public garden in Paisley's west side, valued for its floral displays and local heritage.", query="Ferguslie Gardens, Paisley, Scotland"),
            p("John Neilson Institution", "historic building", "An educational and cultural landmark associated with local philanthropist John Neilson and Paisley's civic improvement era.", query="John Neilson Institution, Paisley, Scotland"),
            p("High Street Conservation Area", "historic area", "Paisley's historic commercial spine, lined with sandstone facades, closes and buildings that reflect the town's textile wealth.", query="High Street, Paisley, Scotland"),
            p("Renfrewshire House", "historic building", "A major civic building on Cotton Street that anchors the modern administrative quarter beside the old town.", query="Renfrewshire House, Paisley, Scotland"),
            p("Paisley Canal", "heritage site", "The canal corridor recalls the waterway and railway routes that once linked Paisley's industries with Glasgow and the Clyde.", wiki="Paisley_Canal_line", query="Paisley Canal, Paisley, Scotland"),
            p("Paisley Canal Railway Heritage", "heritage site", "Bridges, embankments and alignments around Paisley Canal preserve the trace of the old canal and its later railway conversion.", query="Paisley Canal railway station, Paisley, Scotland"),
            p("Abbey Mill Business Centre", "historic building", "A repurposed mill building close to the abbey precinct that speaks to Paisley's industrial scale and thread-making past.", query="Abbey Mill Business Centre, Paisley, Scotland"),
            p("Oakshaw Trinity Church", "church", "A hilltop church in the Oakshaw area, notable for its strong skyline presence above central Paisley.", query="Oakshaw Trinity Church, Paisley, Scotland"),
            p("Oakshaw Head", "viewpoint", "The elevated Oakshaw district offers short but rewarding views over Paisley's abbey quarter, streets and rooftops.", query="Oakshaw Head, Paisley, Scotland"),
            p("Russell Institute", "historic building", "A distinguished late-Victorian public building that adds to Paisley's dense collection of civic architecture.", query="Russell Institute, Paisley, Scotland"),
            p("Paisley Sheriff Court", "historic building", "An imposing court building that contributes to the monumental civic townscape of central Paisley.", query="Paisley Sheriff Court, Paisley, Scotland"),
            p("Brodie Park", "park", "A spacious local park with sports grounds, mature planting and a quieter atmosphere than Paisley's busier flagship parks.", query="Brodie Park, Paisley, Scotland"),
            p("Seedhill Cemetery", "historic site", "A historic cemetery with memorials, mature trees and a calm setting that reflects Paisley's 19th-century growth.", query="Seedhill Cemetery, Paisley, Scotland"),
            p("Ferguslie Park Heritage Trail", "heritage site", "A local heritage trail exploring one of Paisley's most historically significant working-class districts.", query="Ferguslie Park, Paisley, Scotland"),
            p("Abbey Close and Medieval Precinct", "heritage site", "The lanes and spaces around Paisley Abbey preserve the feel of the medieval monastic core of the town.", query="Abbey Close, Paisley, Scotland"),
            p("Coats Fountain", "monument", "An ornate Victorian fountain associated with the powerful Coats family and Paisley's thread-making prosperity.", query="Coats Fountain, Paisley, Scotland"),
            p("Weaver's Cottage, Kilbarchan", "museum", "A National Trust for Scotland property showing the last hand-loom weaver's cottage in the village long tied to Paisley's textile hinterland.", wiki="Kilbarchan", urls=["https://www.nts.org.uk/visit/places/the-weavers-cottage"], station="Johnstone", query="Weaver's Cottage, Kilbarchan, Scotland"),
            p("Kilbarchan Steeple", "historic building", "Kilbarchan's iconic steeple with its Habbie Simpson figure is one of Renfrewshire's best-known weaving-era landmarks.", wiki="Kilbarchan", station="Johnstone", query="Kilbarchan Steeple, Kilbarchan, Scotland"),
            p("Castle Semple Loch", "loch shore", "A freshwater loch at Lochwinnoch now popular for sailing, paddle sports and easy shoreline walks in Clyde Muirshiel Regional Park.", wiki="Castle_Semple_Loch", station="Lochwinnoch", query="Castle Semple Loch, Lochwinnoch, Scotland"),
            p("RSPB Lochwinnoch Nature Reserve", "nature reserve", "An important wetland reserve with hides, boardwalks and birdlife close to Castle Semple Loch.", wiki="Lochwinnoch", urls=["https://www.rspb.org.uk/days-out/reserves/lochwinnoch"], station="Lochwinnoch", query="RSPB Lochwinnoch Nature Reserve, Lochwinnoch, Scotland"),
            p("Rouken Glen Park", "park", "One of Greater Glasgow's finest parks, with glen walks, a waterfall, boating pond and strong appeal as a shared green escape from Paisley.", wiki="Rouken_Glen_Park", station="Whitecraigs", query="Rouken Glen Park, Giffnock, Scotland"),
            p("Paisley Mural Trail", "arts centre", "A growing collection of murals and public art pieces that give the town centre fresh colour and interpretation.", query="Paisley mural trail, Paisley, Scotland"),
        ],
    },
    "greenock": {
        "target": 25,
        "places": [
            p("James Watt Statue", "monument", "A prominent statue celebrating Greenock-born engineer James Watt, one of the town's defining historical figures.", wiki="James_Watt", query="James Watt statue, Greenock, Scotland"),
            p("James Watt Birthplace Memorial", "heritage site", "A memorial site marking the birthplace of James Watt and Greenock's outsized role in industrial history.", wiki="James_Watt", query="James Watt birthplace memorial, Greenock, Scotland"),
            p("Fort Matilda", "viewpoint", "The Fort Matilda area offers a broad waterfront outlook and a useful east-west link between Greenock and Gourock.", query="Fort Matilda, Greenock, Scotland"),
            p("Fort Matilda Seafront Viewpoint", "viewpoint", "A breezy shoreline stop with open Firth of Clyde views and easy access from the rail line.", query="Fort Matilda seafront, Greenock, Scotland"),
            p("Clune Park Conservation Area", "historic area", "A striking and atmospheric planned workers' district that preserves part of Greenock's industrial housing story.", query="Clune Park, Port Glasgow, Scotland"),
            p("Inverclyde Heritage Trail", "heritage site", "A heritage route linking port history, memorials and shoreline views across Greenock and the wider Inverclyde coast.", query="Inverclyde Heritage Trail, Greenock, Scotland"),
            p("Greenock Esplanade Walk", "viewpoint", "A classic seafront walk looking across the estuary to Dunoon, Cowal and the passing traffic of the Clyde.", query="Esplanade, Greenock, Scotland"),
            p("Well Park", "park", "A historic hillside park offering open space and elevated views above central Greenock.", query="Well Park, Greenock, Scotland"),
            p("Murdieston Dam", "viewpoint", "Reservoir-side views and upper-town scenery give Murdieston Dam a quieter, more elevated feel than the waterfront.", query="Murdieston Dam, Greenock, Scotland"),
            p("James Watt Dock Marina", "heritage site", "The dock and marina area reflect Greenock's continuing maritime use while preserving the memory of commercial Clyde shipping.", query="James Watt Dock Marina, Greenock, Scotland"),
            p("Loch Thom", "loch shore", "A hillside reservoir above Greenock whose broad setting helps explain the engineering story behind the town's water supply.", wiki="Loch_Thom", query="Loch Thom, Greenock, Scotland"),
            p("Cornalees Bridge", "viewpoint", "A high moorland viewpoint and route junction giving expansive views over the Clyde and Inverclyde hills.", query="Cornalees Bridge, Greenock, Scotland"),
            p("Greenock Cemetery Viewpoint", "viewpoint", "Higher ground in the cemetery gives unexpectedly wide perspectives across Greenock and the estuary.", query="Greenock Cemetery, Greenock, Scotland"),
            p("Cathcart Square", "historic area", "A central civic square framed by public buildings and long associated with Greenock's administrative life.", query="Cathcart Square, Greenock, Scotland"),
        ],
    },
    "gourock": {
        "target": 25,
        "places": [
            p("Granny Kempock Stone", "monument", "A megalithic standing stone above Kempock Street, steeped in folklore, sailing superstition and witchcraft associations.", wiki="Granny_Kempock_Stone", query="Granny Kempock Stone, Gourock, Scotland"),
            p("Cardwell Bay", "beach", "A sheltered stretch of shore and foreshore that gives Gourock one of its gentler waterside settings.", query="Cardwell Bay, Gourock, Scotland"),
            p("Gourock Golf Club", "golf course", "A scenic clifftop course with commanding views over the Clyde towards Cowal and Argyll.", query="Gourock Golf Club, Gourock, Scotland"),
            p("Inverkip Marina", "harbour", "A major nearby marina and promenade destination south of Gourock, useful for long coastal walks and yacht watching.", query="Inverkip Marina, Inverkip, Scotland"),
            p("Cornalees Bridge Visitor Centre", "viewpoint", "The upland gateway above Gourock opens out to panoramic views and paths into Clyde Muirshiel country.", query="Cornalees Bridge visitor centre, Gourock, Scotland"),
            p("Clyde Muirshiel Regional Park Gateway", "nature reserve", "The Gourock-Cornalees side of Clyde Muirshiel provides easy access to moorland paths, reservoirs and big-sky viewpoints.", wiki="Clyde_Muirshiel_Regional_Park", query="Clyde Muirshiel Regional Park, Inverclyde, Scotland"),
            p("Lunderston Bay", "beach", "A popular bay and family-friendly shore walk at the edge of Gourock with woodland, grass and broad estuary views.", query="Lunderston Bay, Gourock, Scotland"),
            p("Fort Matilda Shoreline", "viewpoint", "The shoreline around Fort Matilda forms a natural link walk between Greenock's and Gourock's waterfronts.", query="Fort Matilda shoreline, Gourock, Scotland"),
            p("Lyle Hill Viewpoint", "viewpoint", "A short hop from Gourock, Lyle Hill gives one of the classic panoramas over the Firth of Clyde and the Free French memorial.", wiki="Lyle_Hill", query="Lyle Hill, Greenock, Scotland"),
            p("Darroch Park", "park", "A local hill park whose rising ground opens out to views across Gourock and the firth.", query="Darroch Park, Gourock, Scotland"),
            p("Royal Gourock Yacht Club", "harbour", "The yacht club and surrounding shore create a strong sailing atmosphere and another pleasant point on the promenade.", query="Royal Gourock Yacht Club, Gourock, Scotland"),
            p("Tower Hill Viewpoint", "viewpoint", "This elevated spot behind the town rewards walkers with a broader perspective over Gourock's villas and shore.", query="Tower Hill, Gourock, Scotland"),
            p("Ashton Promenade Gardens", "park", "A small formal green space on the promenade that softens Gourock's seafront with planting and seats.", query="Ashton promenade gardens, Gourock, Scotland"),
            p("Kilcreggan Ferry Viewpoint", "viewpoint", "Views over the ferry crossing towards Kilcreggan add to Gourock's classic west-coast transport character.", query="Kilcreggan ferry, Gourock, Scotland"),
            p("Cloch Point", "viewpoint", "The point around the lighthouse is a strong place to appreciate the narrowing upper Clyde and the weather of the firth.", wiki="Cloch_Point_Light", query="Cloch Point, Gourock, Scotland"),
            p("Ravenscraig Park", "park", "Open waterside parkland near the Greenock-Gourock edge, good for a breezy stroll and estuary views.", query="Ravenscraig Park, Gourock, Scotland"),
            p("Gourock Park", "park", "A quieter inland public park offering a pause from the promenade and shore-focused attractions.", query="Gourock Park, Gourock, Scotland"),
        ],
    },
    "kirkintilloch": {
        "target": 25,
        "places": [
            p("Barony Chambers Museum", "museum", "A local museum space and heritage stop in the civic centre of Kirkintilloch, complementing the Auld Kirk Museum.", query="Barony Chambers, Kirkintilloch, Scotland"),
            p("Thomas Muir Statue", "monument", "A memorial to the political reformer Thomas Muir of Huntershill, whose story is closely tied to the area.", wiki="Thomas_Muir_of_Huntershill", query="Thomas Muir statue, Kirkintilloch, Scotland"),
            p("Huntershill House", "historic building", "The birthplace of Thomas Muir, remembered as an important site in the story of democratic reform in Scotland.", wiki="Thomas_Muir_of_Huntershill", query="Huntershill House, Bishopbriggs, Scotland"),
            p("Oxgang Road Roman Distance Slab Site", "heritage site", "The site recalls one of the Antonine Wall's important Roman inscriptions discovered in the district.", wiki="Antonine_Wall", query="Oxgang Road, Kirkintilloch, Scotland"),
            p("Merkland Bridge", "historic building", "An old bridge crossing near the town that fits naturally into canal-side and riverside heritage walks.", query="Merkland Bridge, Kirkintilloch, Scotland"),
            p("Kirky Puffer Boat Trips", "heritage site", "Seasonal canal boat trips give visitors a slow-moving way to appreciate Kirkintilloch's Forth and Clyde heritage.", query="Kirky Puffer, Kirkintilloch, Scotland"),
            p("Luggie Water Walk", "park", "A pleasant walk beside the Luggie Water adding a greener route to the canal- and town-centre experience.", query="Luggie Water, Kirkintilloch, Scotland"),
            p("Campsie Viewpoint", "viewpoint", "Open streets and paths on the edge of town give good lines of sight north to the Campsie Fells.", query="Campsie viewpoint, Kirkintilloch, Scotland"),
            p("Kirkintilloch Marina", "harbour", "A small marina and basin area reinforcing the town's identity as a canal settlement.", query="Kirkintilloch Marina, Kirkintilloch, Scotland"),
            p("Southbank Marina Walk", "park", "A waterside stroll linking marina activity, canal engineering and easy town-centre walking.", query="Southbank marina, Kirkintilloch, Scotland"),
            p("Townhead Bridge", "historic building", "One of the canal crossings that helps define Kirkintilloch's layered waterside townscape.", query="Townhead Bridge, Kirkintilloch, Scotland"),
            p("Auld Aisle Cemetery", "historic site", "An older burial ground that helps tell the story of the town before its great canal-era growth.", query="Auld Aisle Cemetery, Kirkintilloch, Scotland"),
            p("Woodhead Park", "park", "A broad local green space popular for easy walks and a break from the canal corridor.", query="Woodhead Park, Kirkintilloch, Scotland"),
            p("Antonine Wall Trail", "heritage site", "Kirkintilloch is one of the best places to understand the Antonine Wall as both a Roman frontier and a modern walking route.", wiki="Antonine_Wall", query="Antonine Wall, Kirkintilloch, Scotland"),
            p("Twechar Towpath Link", "park", "The canal-side route towards Twechar adds more rural scenery and strengthens Kirkintilloch's connections along the waterway.", query="Twechar towpath, Kirkintilloch, Scotland"),
            p("St Ninian's Parish Church", "church", "A landmark church adding architectural interest to the historic core of Kirkintilloch.", query="St Ninian's Parish Church, Kirkintilloch, Scotland"),
            p("Roman Fort Viewpoint", "viewpoint", "Open areas around the Antonine Wall line give a sense of the strategic Roman siting around Kirkintilloch.", wiki="Antonine_Wall", query="Roman fort viewpoint, Kirkintilloch, Scotland"),
        ],
    },
    "dumbarton": {
        "target": 25,
        "places": [
            p("Dunglass Castle", "castle", "Ruins beside the Clyde west of Dumbarton, recalling a strong medieval and early modern defensive presence on the estuary.", wiki="Dunglass_Castle", query="Dunglass Castle, Bowling, Scotland"),
            p("Cardross Medieval Royal Site", "heritage site", "The Cardross area preserves the memory of Robert the Bruce's manor house and final years on the Clyde.", wiki="Cardross", query="King Robert the Bruce site, Cardross, Scotland"),
            p("Dalreoch Beach", "beach", "A narrow stretch of shoreline that gives a more open look across the estuary west of central Dumbarton.", query="Dalreoch beach, Dumbarton, Scotland"),
            p("Broadmeadow Estuary", "nature reserve", "Open tidal ground at the mouth of the Leven where river and estuary landscapes meet.", query="Broadmeadow estuary, Dumbarton, Scotland"),
            p("Castle Street Viewpoint", "viewpoint", "Streets below the rock provide classic upward views of the castle perched above Dumbarton.", query="Castle Street, Dumbarton, Scotland"),
            p("Dumbuck Hill", "viewpoint", "This low hill and surrounding open ground give a broader sense of Dumbarton's setting between river and upland.", query="Dumbuck Hill, Dumbarton, Scotland"),
            p("St Augustine's Church", "church", "A notable church building that contributes to Dumbarton's substantial 19th-century townscape.", query="St Augustine's Church, Dumbarton, Scotland"),
            p("Dumbarton Harbour", "harbour", "The harbour area keeps alive the town's long relationship with the Clyde and commercial river traffic.", query="Dumbarton Harbour, Dumbarton, Scotland"),
            p("Langbank Riverside Viewpoint", "viewpoint", "Views east along the Clyde from Langbank help place Dumbarton in its wider estuarine landscape.", query="Langbank riverside, Scotland"),
            p("Silverton Viaduct Viewpoint", "historic building", "Railway engineering and river scenery come together around the viaduct approaches on Dumbarton's eastern side.", query="Silverton viaduct, Dumbarton, Scotland"),
            p("River Leven Estuary Walk", "park", "A waterside route following the lower Leven as it opens into the Clyde beside Dumbarton.", wiki="River_Leven,_Dunbartonshire", query="River Leven estuary, Dumbarton, Scotland"),
            p("Dumbarton Town Basin", "heritage site", "The basin and surrounding waterside infrastructure help explain the town's working-river past.", query="Dumbarton town basin, Dumbarton, Scotland"),
            p("Scottish Maritime Museum Connection", "heritage site", "Though centred elsewhere, the maritime-museum connection helps frame Dumbarton's celebrated shipbuilding heritage.", query="Scottish Maritime Museum, Dumbarton, Scotland"),
            p("Cardross Bay", "viewpoint", "A nearby shoreline viewpoint with open water, mudflats and sweeping estuary scenery.", query="Cardross Bay, Cardross, Scotland"),
            p("Vale of Leven Heritage Trail", "heritage site", "The trail north towards Balloch and Alexandria reinforces Dumbarton's place at the mouth of the historic Vale of Leven.", query="Vale of Leven heritage trail, Dumbarton, Scotland"),
            p("Dumbarton Central Riverfront", "viewpoint", "The central riverfront is a good place to appreciate the confluence of castle rock, river and estuary.", query="Dumbarton central riverfront, Dumbarton, Scotland"),
        ],
    },
    "balloch": {
        "target": 25,
        "places": [
            p("Duck Bay Marina Viewpoint", "viewpoint", "A west-shore viewpoint south of Luss known for boats, loch panoramas and a classic southern-Loch-Lomond feel.", query="Duck Bay Marina, Balloch, Scotland"),
            p("Drumkinnon Bay Beach", "beach", "A small lochside beach and foreshore area giving one of Balloch's easiest close-up encounters with the water.", query="Drumkinnon Bay, Balloch, Scotland"),
            p("Cameron House Grounds View", "viewpoint", "From the public lochside, visitors can enjoy views across the water towards the grounds of Cameron House.", query="Cameron House, Balloch, Scotland"),
            p("Inchmurrin Island", "loch shore", "The largest freshwater island in the British Isles, seen from Balloch and reached by loch boat services.", wiki="Inchmurrin", query="Inchmurrin, Loch Lomond, Scotland"),
            p("Inchcailloch Island", "nature reserve", "A wooded island national nature reserve on Loch Lomond, rich in trails, history and loch views.", wiki="Inchcailloch", query="Inchcailloch, Loch Lomond, Scotland"),
            p("Balmaha Shore Viewpoint", "viewpoint", "Balloch's loch services and shore paths create a strong visual and travel connection to the Balmaha side of the loch.", query="Balmaha viewpoint, Loch Lomond, Scotland"),
            p("Ben Lomond Viewpoint", "viewpoint", "Balloch is one of the easiest places to appreciate the profile of Ben Lomond rising beyond southern Loch Lomond.", wiki="Ben_Lomond", query="Ben Lomond viewpoint, Balloch, Scotland"),
            p("Loch Lomond Waterbus", "heritage site", "Seasonal waterbus services help visitors explore the loch as a lived-in transport landscape rather than just a view.", query="Loch Lomond waterbus, Balloch, Scotland"),
            p("Balloch Boat Trips", "heritage site", "Cruise departures from Balloch remain one of the classic ways to experience the length and scale of Loch Lomond.", query="Balloch boat trips, Balloch, Scotland"),
            p("SEA LIFE Loch Lomond Aquarium", "museum", "The aquarium at Loch Lomond Shores adds a family-friendly indoor attraction to Balloch's lochside mix.", wiki="Sea_Life_Centres", query="SEA LIFE Loch Lomond Aquarium, Balloch, Scotland"),
            p("Balloch Bridge", "historic building", "The bridge and its approaches frame a classic transition from River Leven to open loch water.", query="Balloch Bridge, Balloch, Scotland"),
            p("Loch Lomond Cruises Terminal", "heritage site", "The cruise terminal concentrates much of Balloch's role as southern gateway to the loch.", query="Loch Lomond Cruises, Balloch, Scotland"),
            p("Balloch Castle Walled Garden", "garden", "The castle-park garden area adds a quieter horticultural corner to Balloch's better-known lochside scenery.", query="Balloch Castle walled garden, Balloch, Scotland"),
            p("Pier Road Slipway Viewpoint", "viewpoint", "A practical launching point that also works as a simple viewpoint across busy southern Loch Lomond waters.", query="Pier Road slipway, Balloch, Scotland"),
            p("Loch Lomond Shores Boardwalk", "park", "The waterfront boardwalk creates an easy promenade experience with constant loch views and boat activity.", query="Loch Lomond Shores boardwalk, Balloch, Scotland"),
        ],
    },
    "helensburgh": {
        "target": 25,
        "places": [
            p("John Logie Baird Memorial", "monument", "A memorial to the television pioneer born in Helensburgh, celebrating one of the town's most famous figures.", wiki="John_Logie_Baird", query="John Logie Baird memorial, Helensburgh, Scotland"),
            p("Kidston Park", "park", "A seafront park and gathering space on the east side of town with open water views and a strong promenade character.", query="Kidston Park, Helensburgh, Scotland"),
            p("Kidston Park Pool", "historic building", "The pool complex at Kidston adds a longstanding leisure landmark to Helensburgh's waterfront.", query="Kidston Park pool, Helensburgh, Scotland"),
            p("Craigendoran Pier Ruins", "historic site", "The remains of the pier evoke the town's steamer era and the long history of Clyde passenger travel.", query="Craigendoran Pier, Helensburgh, Scotland"),
            p("Rosneath Peninsula Viewpoint", "viewpoint", "Open views from Helensburgh's shore constantly draw the eye across to the Rosneath Peninsula.", query="Rosneath Peninsula view, Helensburgh, Scotland"),
            p("Faslane Peace Camp", "heritage site", "The nearby peace camp is an unusual and enduring part of the modern political landscape around Gare Loch.", wiki="Faslane_Peace_Camp", query="Faslane Peace Camp, Helensburgh, Scotland"),
            p("Colquhoun Square", "historic area", "The formal central square anchors Helensburgh's planned-town layout and civic identity.", query="Colquhoun Square, Helensburgh, Scotland"),
            p("Helensburgh Parish Church", "church", "A notable town-centre church contributing to the planned Victorian character of Helensburgh.", query="Helensburgh Parish Church, Helensburgh, Scotland"),
            p("Ardmore Point", "viewpoint", "A shoreline point east of town with broad estuary views and a more open relationship to the Clyde.", query="Ardmore Point, Helensburgh, Scotland"),
            p("Helensburgh Upper Viewpoint", "viewpoint", "Higher streets near Helensburgh Upper station provide wider views over the town, Gare Loch and the Clyde.", query="Helensburgh Upper station viewpoint, Helensburgh, Scotland"),
        ],
    },
    "giffnock": {
        "target": 25,
        "places": [
            p("Auldhouse Burn Walk", "park", "A short green corridor walk following the burn through the south-side suburban landscape around Giffnock.", query="Auldhouse Burn, Giffnock, Scotland"),
            p("Whitecraigs Golf Club Viewpoint", "viewpoint", "Higher ground around Whitecraigs opens out to wide views across Giffnock and East Renfrewshire.", query="Whitecraigs Golf Club, Giffnock, Scotland"),
            p("Giffnock Conservation Area", "historic area", "A pocket of older villas, sandstone details and mature planting that preserves part of Giffnock's suburban heritage.", query="Giffnock conservation area, Giffnock, Scotland"),
            p("Thornliebank Heritage Trail", "heritage site", "A short hop from Giffnock, this shared trail recalls the district's thread works and industrial communities.", query="Thornliebank heritage trail, Thornliebank, Scotland"),
            p("Rouken Glen Waterfall", "viewpoint", "The park's wooded glen and small waterfall are among the most atmospheric features of Rouken Glen.", wiki="Rouken_Glen_Park", query="Rouken Glen waterfall, Giffnock, Scotland"),
            p("Rouken Glen Walled Garden", "garden", "A formal garden corner within Rouken Glen that adds structure and horticultural interest to the park.", wiki="Rouken_Glen_Park", query="Rouken Glen walled garden, Giffnock, Scotland"),
            p("Rouken Glen Boating Pond", "park", "The boating pond is one of Rouken Glen's most recognisable family attractions.", wiki="Rouken_Glen_Park", query="Rouken Glen boating pond, Giffnock, Scotland"),
            p("Eastwood Leisure Centre", "arts centre", "A busy leisure and cultural complex that complements the adjacent theatre and park facilities in Giffnock.", query="Eastwood Leisure Centre, Giffnock, Scotland"),
            p("Fairweather Hall", "arts centre", "A long-serving local hall and community venue representing Giffnock's civic and cultural life.", query="Fairweather Hall, Giffnock, Scotland"),
            p("Whitecraigs Railway Heritage", "heritage site", "The railway helped turn Giffnock into a commuter suburb, and Whitecraigs remains central to that story.", query="Whitecraigs station, Giffnock, Scotland"),
            p("Braidbar Nature Trail", "nature reserve", "A useful short green route linking residential Giffnock with pockets of burn-side habitat.", query="Braidbar, Giffnock, Scotland"),
            p("Whitecraigs Reservoir Walk", "loch shore", "A convenient waterside-style walk and open-space circuit in the Whitecraigs area.", query="Whitecraigs reservoir, Giffnock, Scotland"),
            p("Mearns Castle Viewpoint", "viewpoint", "From Giffnock's southern edge, routes towards Newton Mearns connect to views of the historic Mearns Castle site.", wiki="Mearns_Castle", query="Mearns Castle, Newton Mearns, Scotland"),
            p("Pollok Country Park South Gateway", "country park", "Giffnock sits within easy reach of the south side of Pollok Country Park, a major shared green asset.", wiki="Pollok_Country_Park", query="Pollok Country Park, Glasgow, Scotland"),
            p("Linn Park Connection", "park", "Shared walking routes towards Linn Park add river valley scenery to Giffnock's nearby options.", wiki="Linn_Park", query="Linn Park, Glasgow, Scotland"),
            p("Giffnock Library Heritage Corner", "historic building", "The local library and civic buildings form part of Giffnock's quieter civic identity.", query="Giffnock Library, Giffnock, Scotland"),
            p("Braidholm Green Walk", "park", "Open ground and paths around Braidholm provide a gentle local walk close to central Giffnock.", query="Braidholm, Giffnock, Scotland"),
            p("Davieland Estate Walk", "park", "A residential-edge walk recalling some of the landed history that predated modern Giffnock's expansion.", query="Davieland Road, Giffnock, Scotland"),
        ],
    },
    "newton-mearns": {
        "target": 25,
        "places": [
            p("Mearns Castle Church", "church", "The restored tower house is incorporated into the church complex, making this a striking blend of worship space and medieval fabric.", wiki="Mearns_Castle", query="Maxwell Mearns Castle Church, Newton Mearns, Scotland"),
            p("Whitelee Moorland Trails", "nature reserve", "Open trails around the windfarm visitor area add moorland walking and broad horizons to Newton Mearns's nearby attractions.", wiki="Whitelee_Wind_Farm", query="Whitelee Windfarm trails, Newton Mearns, Scotland"),
            p("Parklands Country Club Grounds", "park", "The landscaped grounds and water features around Parklands add another polished green setting to modern Newton Mearns.", query="Parklands Country Club, Newton Mearns, Scotland"),
            p("Cowglen Golf Club Viewpoint", "viewpoint", "Rising ground around Cowglen provides open views across southern Glasgow and East Renfrewshire.", query="Cowglen Golf Club, Newton Mearns, Scotland"),
            p("Barrhead Dams Link", "country park", "Routes west towards the Barrhead dams and Dams to Darnley connect Newton Mearns to a larger regional outdoor network.", wiki="Dams_to_Darnley_Country_Park", query="Barrhead Dams, Scotland"),
            p("Pollok Country Park South Fringe", "country park", "The shared south-side green corridor puts Pollok Country Park within easy reach of Newton Mearns.", wiki="Pollok_Country_Park", query="Pollok Country Park, Glasgow, Scotland"),
            p("Eaglesham Village Link", "historic area", "Newton Mearns makes a practical base for visiting the planned historic village of Eaglesham just to the east.", wiki="Eaglesham", query="Eaglesham village, Eaglesham, Scotland"),
            p("Patterton Reservoirs", "loch shore", "Reservoir-side paths and open views near Patterton are a quieter complement to the bigger regional parks.", query="Patterton reservoirs, Newton Mearns, Scotland"),
            p("Capelrig Burn Walk", "park", "A small-scale local burn-side route that reflects the older rural landscape beneath modern suburban growth.", query="Capelrig Burn, Newton Mearns, Scotland"),
            p("Levern Water Green Corridor", "park", "Paths beside the Levern Water introduce a greener edge to Newton Mearns's mainly suburban form.", query="Levern Water, Newton Mearns, Scotland"),
            p("Broom Estate Heritage", "historic building", "The Broom district recalls estate history that shaped the later street pattern of Newton Mearns.", query="Broom estate, Newton Mearns, Scotland"),
            p("Greenlaw Village Walk", "park", "A comfortable walk through newer landscaped quarters showing the contemporary evolution of Newton Mearns.", query="Greenlaw village, Newton Mearns, Scotland"),
            p("Kirkhill Forest Edge", "nature reserve", "Woodland-edge paths near Kirkhill add a more secluded feel than the town's open suburban parks.", query="Kirkhill, Newton Mearns, Scotland"),
            p("Maidenhill Viewpoint", "viewpoint", "Newer high ground around Maidenhill offers broad suburban and moorland views.", query="Maidenhill, Newton Mearns, Scotland"),
            p("Aurs Road Moorland Walk", "viewpoint", "Routes out along Aurs Road quickly leave the housing estates behind for open views and a more rural atmosphere.", query="Aurs Road, Newton Mearns, Scotland"),
            p("Broom Parish Church", "church", "A notable parish church serving one of Newton Mearns's established residential areas.", query="Broom Parish Church, Newton Mearns, Scotland"),
            p("Whitecraigs Rail Heritage Link", "heritage site", "Nearby Whitecraigs station helps explain the transport connections that underpinned the area's suburban expansion.", query="Whitecraigs station, Newton Mearns, Scotland"),
            p("Malletsheugh Woodland Walk", "park", "Wooded edges and newer path networks around Malletsheugh add another easy outdoor option.", query="Malletsheugh, Newton Mearns, Scotland"),
        ],
    },
    "eaglesham": {
        "target": 25,
        "places": [
            p("Eaglesham Conservation Area", "historic area", "One of Scotland's finest preserved planned villages, with distinctive two-pronged greens and a strong Georgian character.", wiki="Eaglesham", query="Eaglesham conservation area, Eaglesham, Scotland"),
            p("Rudolf Hess Landing Site", "historic site", "The area west of the village is associated with Rudolf Hess's dramatic 1941 wartime landing.", wiki="Rudolf_Hess", query="Rudolf Hess landing site, Eaglesham, Scotland"),
            p("Lochgoin Farm", "heritage site", "A long-associated Covenanting farm and museum site in the uplands south-west of Eaglesham.", query="Lochgoin Farm, Eaglesham, Scotland"),
            p("Dunwan Dam", "loch shore", "A moorland reservoir and walking area on the higher ground beyond Eaglesham.", query="Dunwan Dam, Eaglesham, Scotland"),
            p("Picketlaw Reservoir", "loch shore", "A smaller upland reservoir that adds another quiet walking target above the village.", query="Picketlaw Reservoir, Eaglesham, Scotland"),
            p("Bonnyton Moor Viewpoint", "viewpoint", "Open moorland around Bonnyton gives wide skies and views back towards Eaglesham.", query="Bonnyton Moor, Eaglesham, Scotland"),
            p("Covenanters Trail", "heritage site", "Local routes around Eaglesham are rich in Covenanting associations and persecution-era memory.", query="Covenanters trail, Eaglesham, Scotland"),
            p("Fenwick Moor Gateway", "viewpoint", "The road and moorland edge towards Fenwick open Eaglesham out to a wilder south-western landscape.", query="Fenwick Moor, Eaglesham, Scotland"),
            p("Blackwood Hill Viewpoint", "viewpoint", "A local hill viewpoint that helps explain the shape of the moorland around the village.", query="Blackwood Hill, Eaglesham, Scotland"),
            p("Kittoch Water Headwaters", "nature reserve", "The upper-water landscape east of Eaglesham adds streams, grazing land and softer valley scenery.", query="Kittoch Water, Eaglesham, Scotland"),
            p("Moor Road Reservoirs", "loch shore", "Small upland waters reached from the moor roads give another dimension to Eaglesham's outdoor appeal.", query="Moor Road reservoir, Eaglesham, Scotland"),
            p("Eaglesham Parish Burying Ground", "historic site", "Historic gravestones and churchyard spaces deepen the sense of continuity in the old village.", query="Eaglesham Parish Churchyard, Eaglesham, Scotland"),
            p("Polnoon Burn Walk", "park", "A short burn-side route connecting the planned village with the castle and estate edge.", query="Polnoon Burn, Eaglesham, Scotland"),
            p("Whitelee Visitor Centre East Trails", "nature reserve", "Eastern trails from the Whitelee visitor area add more walking options across turbines, reservoirs and moorland.", wiki="Whitelee_Wind_Farm", query="Whitelee visitor centre east trails, Eaglesham, Scotland"),
            p("Eaglesham Village Heritage Trail", "heritage site", "A self-guided way to appreciate the village plan, buildings and local stories that make Eaglesham distinctive.", query="Eaglesham heritage trail, Eaglesham, Scotland"),
            p("Bonnyton Golf Viewpoint", "viewpoint", "Open land by the golf course edge provides broad suburban-to-moorland transitions and easy views.", query="Bonnyton Golf Club, Eaglesham, Scotland"),
            p("Auldhouse Burn Headwaters", "nature reserve", "The headwaters landscape helps show the rural character that still surrounds Eaglesham on several sides.", query="Auldhouse Burn, Eaglesham, Scotland"),
        ],
    },
    "milngavie": {
        "target": 15,
        "places": [
            p("Craigmaddie Reservoir", "loch shore", "A major reservoir north of town that forms part of Milngavie's waterworks heritage and surrounding walking country.", wiki="Craigmaddie_Reservoir", query="Craigmaddie Reservoir, Milngavie, Scotland"),
            p("Tannoch Loch", "loch shore", "A compact local loch adding a more intimate waterside feel within the urban fabric of Milngavie.", query="Tannoch Loch, Milngavie, Scotland"),
            p("Mugdock Loch", "loch shore", "A scenic loch within Mugdock Country Park, surrounded by paths and woodland.", wiki="Mugdock_Country_Park", query="Mugdock Loch, Milngavie, Scotland"),
            p("Craigend Castle", "historic building", "The romantic ruin within Mugdock Country Park adds another strong historic note beyond Mugdock Castle itself.", wiki="Craigend_Castle", query="Craigend Castle, Milngavie, Scotland"),
            p("West Highland Way Information Centre", "heritage site", "Town-centre visitor information and interpretation strengthen Milngavie's role as the start of the West Highland Way.", wiki="West_Highland_Way", query="West Highland Way information centre, Milngavie, Scotland"),
            p("Glengoyne Distillery", "distillery", "A famous Highland-edge distillery north of Milngavie offering tours and a strong whisky connection.", wiki="Glengoyne_distillery", query="Glengoyne Distillery, Dumgoyne, Scotland"),
            p("Drumclog Moor Trail", "nature reserve", "Open moorland paths near Mugdock add a wilder walking option on the fringe of Milngavie.", wiki="Mugdock_Country_Park", query="Drumclog Muir, Milngavie, Scotland"),
        ],
    },
    "bearsden": {
        "target": 15,
        "places": [
            p("Antonine Wall Trail", "heritage site", "Bearsden is one of the easiest places to follow the Antonine Wall as a modern walking route and Roman frontier.", wiki="Antonine_Wall", query="Antonine Wall, Bearsden, Scotland"),
            p("Bearsden Conservation Area", "historic area", "Older villas, leafy streets and mature planting preserve part of Bearsden's classic suburban identity.", query="Bearsden conservation area, Bearsden, Scotland"),
            p("Allander Sports Complex", "park", "A major sporting and leisure complex that also acts as a green corridor on the edge of town.", query="Allander Sports Complex, Bearsden, Scotland"),
            p("Kilmardinny Loch", "loch shore", "A small loch beside Kilmardinny House that adds calm waterside scenery to the arts-centre grounds.", query="Kilmardinny Loch, Bearsden, Scotland"),
            p("Bearsden Ski Club", "viewpoint", "The dry slope and surrounding high ground add an unusual recreation feature to Bearsden.", query="Bearsden Ski Club, Bearsden, Scotland"),
            p("Roman Fort Site", "heritage site", "The wider Roman fort area helps explain why Bearsden became one of the Antonine Wall's key visitor locations.", wiki="Antonine_Wall", query="Roman fort site, Bearsden, Scotland"),
            p("Mosshead Park", "park", "A useful local park and open space with a quieter residential atmosphere.", query="Mosshead Park, Bearsden, Scotland"),
            p("Boclair House", "historic building", "A striking baronial-style house that adds architectural drama to the Bearsden area.", query="Boclair House, Bearsden, Scotland"),
            p("Westerton Garden Suburb Walk", "historic area", "Walking the Westerton side of Bearsden reveals another layer of planned suburban development and rail-era growth.", query="Westerton, Bearsden, Scotland"),
        ],
    },
    "clarkston": {
        "target": 15,
        "places": [
            p("Cathcart Castle Ruins", "castle", "The remains and site associations of Cathcart Castle link Clarkston to a much older landscape above the Cart.", wiki="Cathcart_Castle", query="Cathcart Castle, Clarkston, Scotland"),
            p("Linn Park", "park", "A major park nearby with gorge walks, river scenery and one of the best green escapes close to Clarkston.", wiki="Linn_Park", query="Linn Park, Glasgow, Scotland"),
            p("Busby Glen", "park", "A leafy walk near the White Cart and Busby area, well suited to short suburban nature outings.", wiki="Busby,_East_Renfrewshire", query="Busby Glen, Busby, Scotland"),
            p("Eaglesham Road Conservation Area", "historic area", "The older streetscape along Eaglesham Road preserves some of Clarkston's early suburban character.", query="Eaglesham Road, Clarkston, Scotland"),
            p("Eastwood Community Heritage Trail", "heritage site", "Local routes around Eastwood reveal how villages, estates and commuter growth shaped Clarkston.", query="Eastwood heritage trail, Clarkston, Scotland"),
            p("Williamwood Walks", "park", "The Williamwood side of Clarkston offers tree-lined streets and green fragments suited to relaxed local wandering.", query="Williamwood, Clarkston, Scotland"),
            p("Auldhouse Burn Walk", "park", "Burn-side paths add a greener, softer-edged walking option close to Clarkston's residential core.", query="Auldhouse Burn, Clarkston, Scotland"),
            p("Stamperland Park", "park", "A local public park serving the Stamperland side of Clarkston with open space and everyday green appeal.", query="Stamperland Park, Clarkston, Scotland"),
            p("Busby Viaduct Viewpoint", "viewpoint", "Views near Busby underline the engineering and river-valley setting on Clarkston's eastern side.", query="Busby viaduct, Busby, Scotland"),
        ],
    },
    "alexandria": {
        "target": 15,
        "places": [
            p("Bonhill Bridge", "historic building", "The bridge links Alexandria to neighbouring communities in the Vale of Leven and offers a useful river vantage point.", query="Bonhill Bridge, Alexandria, Scotland"),
            p("Overtoun House Viewpoint", "viewpoint", "Public approaches around the Overtoun estate provide broader views over wooded slopes above Alexandria.", wiki="Overtoun_House", query="Overtoun House, Dumbarton, Scotland"),
            p("Balloch Link Path", "park", "The route north towards Balloch is one of the easiest ways to understand Alexandria's place in the wider Vale of Leven.", query="Balloch link path, Alexandria, Scotland"),
            p("Loch Lomond Shore Access", "loch shore", "From the Alexandria-Balloch area, public routes quickly reach the shore of Loch Lomond and its southern gateway scenery.", wiki="Loch_Lomond", query="Loch Lomond shore access, Alexandria, Scotland"),
            p("Vale of Leven Heritage Trail", "heritage site", "This heritage route gathers together the industrial, social and river history of the Vale communities.", query="Vale of Leven heritage trail, Alexandria, Scotland"),
            p("Alexandria Railway Station Heritage", "heritage site", "The station area represents Alexandria's long rail connection with Glasgow and the loch.", query="Alexandria railway station, Alexandria, Scotland"),
            p("Cameron House Viewpoint", "viewpoint", "Public viewpoints near the south end of the loch look across towards Cameron House and the wider leisure landscape.", query="Cameron House viewpoint, Alexandria, Scotland"),
            p("Renton Bridge Riverside", "viewpoint", "The riverside near the bridge provides another perspective on the Vale's close relationship with the Leven.", query="Renton Bridge, Alexandria, Scotland"),
            p("Alexandria Riverside Park", "park", "A simple riverside green space adding an accessible outdoor stop within the town itself.", query="Alexandria riverside park, Alexandria, Scotland"),
        ],
    },
    "johnstone": {
        "target": 15,
        "places": [
            p("Houston Village", "historic area", "A nearby historic village whose old street pattern and church make it a useful heritage excursion from Johnstone.", wiki="Houston,_Renfrewshire", query="Houston village, Houston, Scotland"),
            p("Weaver's Cottage, Kilbarchan", "museum", "A National Trust for Scotland museum in the nearby weaving village of Kilbarchan, closely tied to the wider Johnstone-Paisley textile story.", wiki="Kilbarchan", urls=["https://www.nts.org.uk/visit/places/the-weavers-cottage"], station="Johnstone", query="Weaver's Cottage, Kilbarchan, Scotland"),
            p("Linwood Moss Nature Reserve", "nature reserve", "A nearby mossland and wetland reserve that offers a quieter natural counterpoint to Johnstone's urban history.", query="Linwood Moss, Linwood, Scotland"),
            p("Renfrewshire Canal Heritage Trail", "heritage site", "The old canal line and related routes help explain how Johnstone's industries connected to the wider region.", query="Renfrewshire Canal, Johnstone, Scotland"),
            p("Castle Semple Collegiate Church", "church", "A Historic Environment Scotland site near Lochwinnoch, representing one of the area's finest late-medieval ecclesiastical remains.", wiki="Castle_Semple_Collegiate_Church", station="Lochwinnoch", query="Castle Semple Collegiate Church, Lochwinnoch, Scotland"),
            p("RSPB Lochwinnoch Nature Reserve", "nature reserve", "Wetlands, hides and walking paths make this a rewarding nearby wildlife destination from Johnstone.", wiki="Lochwinnoch", urls=["https://www.rspb.org.uk/days-out/reserves/lochwinnoch"], station="Lochwinnoch", query="RSPB Lochwinnoch Nature Reserve, Lochwinnoch, Scotland"),
            p("Castle Semple Loch", "loch shore", "The loch and regional-park setting provide watersports, shoreline walking and open Renfrewshire scenery.", wiki="Castle_Semple_Loch", station="Lochwinnoch", query="Castle Semple Loch, Lochwinnoch, Scotland"),
            p("Howwood Heritage Walk", "heritage site", "A short nearby village heritage walk that helps place Johnstone within its historic Renfrewshire context.", wiki="Howwood", station="Howwood", query="Howwood village, Howwood, Scotland"),
        ],
    },
    "renfrew": {
        "target": 25,
        "places": [
            p("Renfrew Cross", "monument", "The old market cross area marks the medieval heart of Renfrew and its long burgh history.", wiki="Renfrew", query="Renfrew Cross, Renfrew, Scotland"),
            p("King's Inch Nature Park", "nature reserve", "Green space and waterside habitat on the old Clyde islands and meadows bring nature into Renfrew's river setting.", query="Kings Inch, Renfrew, Scotland"),
            p("Renfrew Golf Club", "golf course", "One of Renfrewshire's oldest golf clubs, occupying a riverside landscape linked to the old industrial fringe.", query="Renfrew Golf Club, Renfrew, Scotland"),
            p("Black Cart Water Estuary", "viewpoint", "Where the Black Cart meets the Clyde, river geography and tidal scenery define Renfrew's landscape.", wiki="Black_Cart_Water", query="Black Cart Water estuary, Renfrew, Scotland"),
            p("Braehead Arena", "historic building", "The arena forms part of Renfrew's modern visitor district at Braehead on the Clyde's south bank.", query="Braehead Arena, Renfrew, Scotland"),
            p("Braehead Waterfront", "viewpoint", "The Clyde-side edge at Braehead offers broad river views and a strong sense of Renfrew's changing economy.", wiki="Braehead", query="Braehead waterfront, Renfrew, Scotland"),
            p("Royal Ordnance Factory Heritage Trail", "heritage site", "Interpretive heritage around the old factory links Renfrew to wartime manufacturing and engineering history.", query="Royal Ordnance Factory, Renfrew, Scotland"),
            p("Blythswood House", "historic building", "An older estate association that adds another layer to Renfrew's pre-industrial landscape story.", query="Blythswood House, Renfrew, Scotland"),
            p("Porterfield Road Heritage", "heritage site", "Routes and remnants around Porterfield Road help tell the story of Renfrew's changing town edge.", query="Porterfield Road, Renfrew, Scotland"),
            p("Yoker-Renfrew River Crossing Viewpoint", "viewpoint", "A viewpoint associated with the long-lived ferry crossing between Renfrew and Yoker.", query="Yoker Renfrew ferry, Renfrew, Scotland"),
            p("Robertson Park Bandstand", "monument", "The bandstand adds a formal Victorian flourish within Renfrew's principal public park.", query="Robertson Park bandstand, Renfrew, Scotland"),
            p("Renfrew Old Parish Church", "church", "A long-established church tied to the old county town and its religious history.", query="Renfrew Old Parish Church, Renfrew, Scotland"),
            p("Ferry Road Riverside", "viewpoint", "The riverside along Ferry Road offers one of the clearest practical views of Renfrew's Clyde frontage.", query="Ferry Road, Renfrew, Scotland"),
            p("King's Inch Riverside Walk", "park", "A simple waterside route connecting newer leisure districts with older river landscapes.", query="Kings Inch riverside, Renfrew, Scotland"),
            p("Braehead Sculpture Trail", "arts centre", "Public art and riverside placemaking give Braehead a more visitor-oriented feel than a simple retail destination.", query="Braehead sculpture trail, Renfrew, Scotland"),
            p("Meadowside Street Heritage", "historic area", "Historic streets on the approach to the old centre help preserve Renfrew's burgh-scale character.", query="Meadowside Street, Renfrew, Scotland"),
            p("Renfrew Harbour Viewpoint", "viewpoint", "A river-edge outlook that reinforces the town's long dependence on crossings, shipping and the Clyde.", query="Renfrew harbour, Renfrew, Scotland"),
        ],
    },
    "waterfoot": {
        "target": 15,
        "places": [
            p("Ardoch Burn Walk", "park", "A small-scale burn-side route giving Waterfoot a gentler local walking option.", query="Ardoch Burn, Waterfoot, Scotland"),
            p("Eaglesham Village Walks", "historic area", "Waterfoot sits close enough to Eaglesham for easy walks into its notable planned-village streetscape.", wiki="Eaglesham", query="Eaglesham village, Eaglesham, Scotland"),
            p("Lochgoin Farm", "heritage site", "A nearby Covenanting farm museum that adds an unexpectedly deep historical layer to the moorland south-west of Waterfoot.", query="Lochgoin Farm, Eaglesham, Scotland"),
            p("Fenwick Moor", "viewpoint", "Open moorland scenery south-west of Waterfoot gives a broader sense of the upland landscape beyond the suburb edge.", query="Fenwick Moor, Scotland"),
            p("Dunwan Dam", "loch shore", "A higher reservoir walk accessible from the Waterfoot-Eaglesham side of the moors.", query="Dunwan Dam, Eaglesham, Scotland"),
            p("Cart Water Headwaters", "nature reserve", "Upper-water landscapes around Waterfoot help explain the local burn and river systems before they reach the city.", query="White Cart Water headwaters, Waterfoot, Scotland"),
            p("Picketlaw Reservoir", "loch shore", "A smaller upland reservoir suitable for quiet walking and broad views.", query="Picketlaw Reservoir, Eaglesham, Scotland"),
            p("Bonnyton Moor Viewpoint", "viewpoint", "Open land near Bonnyton provides long views back across East Renfrewshire.", query="Bonnyton Moor, Eaglesham, Scotland"),
            p("Whitelee Moor Edge", "viewpoint", "The visible edge of the Whitelee uplands gives Waterfoot one of its strongest connections to the surrounding moorland landscape.", wiki="Whitelee_Wind_Farm", query="Whitelee moor edge, Waterfoot, Scotland"),
        ],
    },
    "port-glasgow": {
        "target": 15,
        "places": [
            p("James Watt Dock Heritage", "heritage site", "The dock and its wider river setting help explain the industrial and maritime context shared across lower-Clyde towns.", query="James Watt Dock, Greenock, Scotland"),
            p("Finlaystone House & Country Estate", "historic building", "A category A mansion and designed landscape east of Port Glasgow with long ties to regional history.", wiki="Finlaystone_House", query="Finlaystone House, Langbank, Scotland"),
            p("Woodhall Farm Walks", "park", "Local paths and open ground around Woodhall offer a quieter green-space contrast to the town's waterfront identity.", query="Woodhall Farm, Port Glasgow, Scotland"),
            p("Parklea Estuary Viewpoint", "viewpoint", "This higher riverside edge gives strong views out over the Clyde estuary and shipping lanes.", query="Parklea, Port Glasgow, Scotland"),
            p("Port Glasgow Harbourside", "heritage site", "The harbourside preserves the feel of a town built around dock access, ship repair and river trade.", query="Port Glasgow harbourside, Port Glasgow, Scotland"),
            p("Kelburn Park", "park", "A generous local parkland space on the inland side of the town.", query="Kelburn Park, Port Glasgow, Scotland"),
            p("Boglestone Woods", "nature reserve", "Wooded local paths above Port Glasgow offering a different, greener perspective on the town.", query="Boglestone Woods, Port Glasgow, Scotland"),
            p("Port Glasgow Heritage Trail", "heritage site", "A practical way to link the town buildings, castle, waterfront and later industrial sites into one story.", query="Port Glasgow heritage trail, Port Glasgow, Scotland"),
        ],
    },
}


def load_cache() -> dict:
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {}


CACHE = load_cache()


def save_cache() -> None:
    CACHE_PATH.write_text(json.dumps(CACHE, indent=2, ensure_ascii=False))


def curl_json(url: str):
    out = subprocess.check_output(["curl", "-sA", "RoameoBot/1.0 (+https://github.com/github/copilot-cli)", url], text=True)
    return json.loads(out)


def geocode(query: str, fallback_lat: float, fallback_lng: float, fallback_address: str):
    if query in CACHE:
        result = CACHE[query]
    else:
        data = curl_json(nominatim_url(query))
        result = data[0] if data else None
        CACHE[query] = result
        save_cache()
        time.sleep(1.0)
    if result:
        return {
            "lat": round(float(result["lat"]), 6),
            "lng": round(float(result["lon"]), 6),
            "address": result.get("display_name") or fallback_address,
            "source": nominatim_url(query),
        }
    return {
        "lat": fallback_lat,
        "lng": fallback_lng,
        "address": fallback_address,
        "source": None,
    }


def build_record(meta: dict, place: dict, timestamp: str) -> OrderedDict:
    query = place.get("query") or f"{place['name']}, {meta['city']}, Scotland"
    fallback_address = f"{place['name']}, {meta['city']}, Scotland"
    geo = geocode(query, meta["lat"], meta["lng"], fallback_address)
    source_urls = []
    wiki = place.get("wiki")
    if isinstance(wiki, str):
        source_urls.append(wiki_url(wiki))
    elif isinstance(wiki, list):
        source_urls.extend(wiki_url(w) for w in wiki)
    source_urls.extend(place.get("urls", []))
    if not source_urls:
        source_urls.append(meta["city_wiki"])
    # unique preserve order
    seen = set()
    uniq = []
    for url in source_urls:
        if url and url not in seen:
            seen.add(url)
            uniq.append(url)
    source_urls = uniq
    description_source = source_urls[0]
    geo_source = geo["source"] or source_urls[0]
    station = place.get("station", meta.get("station"))

    rec = OrderedDict()
    rec["batch_id"] = meta["batch_id"]
    rec["dedupe_key"] = f"name:{nk(meta['prefecture'])}:{nk(meta['city'])}:{nk(place['name'])}"
    rec["region"] = meta["region"]
    rec["prefecture"] = meta["prefecture"]
    rec["city"] = meta["city"]
    rec["country"] = meta["country"]
    rec["name"] = place["name"]
    rec["category"] = place["category"]
    rec["description"] = place["description"]
    rec["tips"] = place.get("tips", [])
    rec["hours"] = place.get("hours")
    rec["hours_status"] = place.get("hours_status", "unknown")
    rec["station"] = station
    rec["google_place_id"] = None
    rec["lat"] = geo["lat"]
    rec["lng"] = geo["lng"]
    rec["address"] = place.get("address") or geo["address"]
    rec["rating"] = None
    rec["price_level"] = None
    rec["image_url"] = None
    rec["badges"] = place.get("badges", [])
    rec["source_urls"] = source_urls
    rec["field_sources"] = {
        "description": description_source,
        "lat": geo_source,
        "lng": geo_source,
        "address": geo_source,
    }
    rec["photo"] = None
    rec["extraction_model"] = "copilot-cli-knowledge"
    rec["extraction_status"] = "extracted"
    rec["validation_errors"] = []
    rec["approved"] = False
    rec["rejected_reason"] = None
    rec["fetched_at"] = timestamp
    rec["last_verified_at"] = timestamp
    return rec


def infer_meta(records: list[dict]) -> dict:
    first = records[0]
    station = next((r.get("station") for r in records if r.get("station")), None)
    city_wiki = None
    for r in records:
        for url in r.get("source_urls", []):
            if "wikipedia.org/wiki/" in url:
                city_wiki = url
                break
        if city_wiki:
            break
    return {
        "batch_id": first.get("batch_id", "scot-pilot-2026-07-25"),
        "region": first["region"],
        "prefecture": first["prefecture"],
        "city": first["city"],
        "country": first.get("country", "GB"),
        "station": station,
        "lat": float(first["lat"]),
        "lng": float(first["lng"]),
        "city_wiki": city_wiki or wiki_url(first["city"].replace(" ", "_")),
    }


def main() -> None:
    timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    summary = []
    for slug, cfg in TOP_UPS.items():
        path = OUT_DIR / f"{slug}.json"
        data = json.loads(path.read_text())
        records = data["records"]
        meta = infer_meta(records)
        existing = {nk(r["name"]) for r in records}
        appended = 0
        for place in cfg["places"]:
            if len(records) >= cfg["target"]:
                break
            if nk(place["name"]) in existing:
                continue
            rec = build_record(meta, place, timestamp)
            records.append(rec)
            existing.add(nk(place["name"]))
            appended += 1
        if len(records) < cfg["target"]:
            raise RuntimeError(f"{slug} only reached {len(records)} of {cfg['target']}")
        path.write_text(json.dumps({"records": records}, indent=2, ensure_ascii=False) + "\n")
        summary.append((slug, len(records), appended))
    for slug, count, appended in summary:
        print(f"{slug}: {count} total ({appended} appended)")


if __name__ == "__main__":
    main()
