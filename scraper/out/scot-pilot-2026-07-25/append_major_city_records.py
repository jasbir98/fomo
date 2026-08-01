from __future__ import annotations

import importlib.util
import json
from pathlib import Path

BASE_DIR = Path('/Users/jasbirsingh/Documents/personal/Roameo/scraper/out/scot-pilot-2026-07-25')
BUILD_SCRIPT = BASE_DIR / 'build_scot_places.py'

spec = importlib.util.spec_from_file_location('build_scot_places', BUILD_SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

city_lookup = {entry['output_file']: entry for entry in mod.CITY_DATA}


def place(name, category, *, wiki=None, area=None, desc=None, station=None, hours=None, badges=None, source_urls=None, tips=None, aliases=None):
    data = mod.P(
        name,
        category,
        wiki=wiki,
        area=area,
        desc=desc,
        station=station,
        hours=hours,
        badges=badges,
        source_urls=source_urls,
        tips=tips,
    )
    data['aliases'] = aliases or []
    return data


CANDIDATES = {
    'dundee.json': [
        place('Overgate Centre Heritage', 'historic district', wiki='Overgate Centre', area='Overgate, Dundee', desc='Shopping and city-centre site preserving the memory of Dundee\'s medieval Overgate street, one of the old routes that once ran beside the city churches and helped shape the historic core.'),
        place("Dundee Parish Church (St Mary's)", 'historic church', wiki="Dundee Parish Church (St Mary's)", area='Nethergate, Dundee', desc='Historic city-centre church beside the Old Steeple, long associated with Dundee\'s burgh history and the medieval parish of St Mary.'),
        place('Baxter Park', 'park', wiki='Baxter Park', area='Baxter Park, Dundee', desc='Victorian public park designed with terraces, ornamental features and wide lawns, gifted to the city by the Baxter family.'),
        place('Riverside Nature Park', 'nature park', area='Riverside Drive, Dundee', desc='Waterside park on the Tay with ponds, wildflower areas, birdlife and views back across the estuary and city skyline.'),
        place('Caird Park', 'park', area='Caird Park, Dundee', desc='Large north Dundee parkland with open views, mature trees and sports facilities, reflecting the city\'s tradition of generous public green space.'),
        place("D'Arcy Thompson Zoology Museum", 'museum', wiki="D'Arcy Thompson Zoology Museum", area='University of Dundee, Dundee', desc='Compact university museum named for the pioneering biologist D\'Arcy Wentworth Thompson, with zoological specimens and scientific heritage displays.'),
        place('Dundee International Submarine Memorial', 'monument', area='Dundee Waterfront, Dundee', desc='Waterfront memorial commemorating international submariners and Dundee\'s long maritime and naval connections.'),
        place('Dudhope Park', 'park', area='Dudhope, Dundee', desc='Hillside urban park around Dudhope Castle with mature trees, open lawns and good elevated views over western Dundee.'),
        place('Wishart Arch', 'historic site', area='Cowgate, Dundee', desc='Medieval gateway and remnant of old Dundee associated with reformer George Wishart, tucked into the surviving lanes of the historic centre.'),
        place('Minnie the Minx Statue', 'monument', area='Dundee City Centre', desc='Public sculpture celebrating Dundee\'s long association with Beano and D.C. Thomson comic heritage.'),
    ],
    'stornoway.json': [
        place('Carloway Village and Coastline', 'coastal scenery', area='Carloway, Lewis', desc='Harbour village and rugged west-coast shoreline often paired with Dun Carloway, offering loch views, moorland scenery and Atlantic light.'),
        place('Ness Village', 'village', area='Ness, Lewis', desc='Northern Lewis village area known for strong Gaelic culture, crofting landscapes and access to the dramatic far north of the island.'),
        place('Cross-Skigersta Standing Stone', 'prehistoric site', area='Ness, Lewis', desc='Striking standing stone in the Ness district, part of the rich prehistoric landscape of northern Lewis.'),
        place('Bridge to Nowhere', 'walking trail', area='North Tolsta, Lewis', desc='Well-known walking route from Tolsta toward an unfinished bridge, prized for cliffs, sea views and the remote feel of the east Lewis coast.'),
        place('Stornoway Golf Club', 'golf course', area='Stornoway', desc='Coastal golf course above Broad Bay with expansive sea views and a classic links-style island setting.'),
        place('Melbost Beach', 'beach', area='Melbost, Lewis', desc='Accessible beach and shoreline close to Stornoway, useful for a short seaside stop near the town.'),
        place('Broad Bay Beach', 'beach', area='Broad Bay, Lewis', desc='Long sweep of sand and shore villages on the east side of Lewis, reached easily from Stornoway.'),
        place('Dalmore Beach', 'beach', area='Dalmore, Lewis', desc='Scenic west Lewis beach backed by dunes and low hills, often visited together with the beaches of Uig.'),
        place('Port Stoth', 'viewpoint', area='Aird a\' Mhulaidh, Lewis', desc='Dramatic coastal viewpoint above a natural geo and inlet on the east side of Lewis, popular with walkers and photographers.'),
        place('Aird Uig Viewpoint', 'viewpoint', area='Aird Uig, Lewis', desc='Remote west Lewis viewpoint over sea lochs, hills and Atlantic coastline at the edge of inhabited land.'),
    ],
    'kirkwall.json': [
        place('Skara Brae', 'archaeological site', wiki='Skara Brae', area='Bay of Skaill, Orkney', desc='UNESCO-listed 5,000-year-old Neolithic village and the best-preserved prehistoric settlement in northern Europe.', badges=['unesco'], aliases=['Skara Brae archaeological site']),
        place('Pier Arts Centre', 'gallery', area='Stromness', desc='Major modern art gallery in Stromness noted for works connected to Barbara Hepworth and the St Ives school.'),
        place('Scapa Flow', 'historic waters', area='Scapa Flow, Orkney', desc='Vast natural anchorage central to twentieth-century naval history, including the scuttling of the German High Seas Fleet and world-famous wreck diving.'),
        place('Skaill House', 'historic house', area='Bay of Skaill, Orkney', desc='Historic laird\'s house beside Skara Brae, closely linked to the site\'s nineteenth-century rediscovery.'),
        place('Bay of Skaill', 'beach', area='Bay of Skaill, Orkney', desc='Sweeping west Mainland bay beside Skara Brae, with a sandy beach and wide Atlantic views.'),
        place('Old Man of Hoy', 'sea stack', area='Hoy, Orkney', desc='Iconic sandstone sea stack rising from Hoy\'s cliffs, one of the best-known natural landmarks in Britain.'),
        place('Orkney Fossil and Heritage Centre', 'museum', area='Burray, Orkney', desc='Local heritage centre with island history exhibits and fossil displays gathered from Orkney\'s geology-rich shores.'),
        place('Kirbuster Farm Museum', 'museum', area='Birsay, Orkney', desc='Preserved traditional farmstead presenting rural Orkney life in an eighteenth- and nineteenth-century setting.'),
        place('Minehowe', 'archaeological site', area='Tankerness, Orkney', desc='Remarkable Iron Age underground structure reached by a spiral stair, part of an important excavated settlement landscape.'),
        place('Brough of Deerness', 'archaeological site', area='Deerness, Orkney', desc='Headland walk to a tidal island with Norse and medieval remains perched dramatically above the sea.'),
        place('Mull Head Nature Reserve', 'nature reserve', area='Deerness, Orkney', desc='Clifftop reserve and walking area on Orkney\'s east coast with sea arches, seabirds and views over the North Sea.'),
        place('Dwarfie Stane', 'prehistoric site', area='Hoy, Orkney', desc='Unique rock-cut Neolithic tomb on Hoy, carved directly into a massive block of sandstone.'),
    ],
    'lerwick.json': [
        place('Bressay Island', 'island scenery', area='Bressay', desc='Island just across the ferry from Lerwick with quiet roads, coastal walks, heritage sites and onward access toward Noss.'),
        place('Gardie House', 'historic house', area='Bressay', desc='Historic laird\'s house on Bressay, adding architectural interest to the island\'s easy day-trip appeal from Lerwick.'),
        place('Up Helly Aa Exhibition', 'festival heritage', area='Lerwick', desc='Exhibition space celebrating Lerwick\'s famous winter fire festival, guizer squads and Viking galley traditions.', source_urls=['https://en.wikipedia.org/wiki/Up_Helly_Aa']),
        place('Bod of Gremista', 'historic house', area='Gremista, Lerwick', desc='Restored eighteenth-century fishing bod and birthplace of Arthur Anderson, co-founder of P&O.'),
        place('Sands of Sound Beach', 'beach', area='Lerwick', desc='Accessible sandy beach on the south side of Lerwick with broad views across the Sound and Bressay.'),
        place('Staney Hill Chambered Cairn', 'prehistoric site', area='Lerwick', desc='Neolithic chambered cairn on the hill above Lerwick, rewarding a short climb with expansive town and sea views.'),
        place('Bressay Heritage Centre', 'museum', area='Bressay', desc='Small island heritage centre interpreting Bressay\'s maritime, crofting and community history.'),
        place('Shetland Crofthouse Museum', 'museum', area='Dunrossness, Shetland', desc='Thatched crofthouse museum showing traditional domestic life in Shetland before modern utilities.'),
        place('Quendale Watermill', 'historic mill', area='Quendale, Shetland', desc='Restored horizontal watermill representing older grain-milling traditions in the South Mainland.'),
        place('Stanydale Temple', 'prehistoric site', area='West Mainland, Shetland', desc='Large prehistoric ritual or assembly building, one of the most intriguing Neolithic monuments in Shetland.'),
        place('Eshaness Cliffs', 'cliff walk', area='Northmavine, Shetland', desc='Spectacular wave-cut cliffs and sea stacks formed within an ancient volcanic landscape on Shetland\'s west side.'),
        place('Tangwick Haa Museum', 'museum', area='Eshaness, Shetland', desc='Local museum in a laird\'s house telling the story of Northmavine and the dramatic Eshaness district.'),
        place('Scord of Brouster', 'archaeological site', area='Walls, Shetland', desc='Important Bronze Age settlement site preserving the remains of prehistoric houses in western Shetland.'),
        place('Ward of Bressay', 'viewpoint', area='Bressay', desc='High point on Bressay with commanding views over Lerwick, the sound and outer isles.'),
        place('Ness of Sound Viewpoint', 'viewpoint', area='Lerwick', desc='Coastal viewpoint on the western side of Lerwick overlooking the harbour approaches and nearby islands.'),
    ],
}


def name_keys(name: str, aliases: list[str]) -> set[str]:
    keys = {mod.nk(name)}
    keys.update(mod.nk(alias) for alias in aliases)
    return keys


for filename, candidates in CANDIDATES.items():
    path = BASE_DIR / filename
    data = json.loads(path.read_text(encoding='utf-8'))
    records = data['records']
    existing = {mod.nk(record['name']) for record in records}
    city_meta = city_lookup[filename]
    added = 0
    for candidate in candidates:
        aliases = candidate.pop('aliases', [])
        if existing.intersection(name_keys(candidate['name'], aliases)):
            continue
        record = mod.build_record(city_meta, candidate)
        records.append(record)
        existing.add(mod.nk(candidate['name']))
        added += 1
    path.write_text(json.dumps({'records': records}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'{filename}: +{added} => {len(records)}')
