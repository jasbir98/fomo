"""Scotland country config.

ADMIN_UNIT_REGION covers all 32 Scottish council areas — a complete,
non-overlapping partition of Scotland, mirroring how Japan's 47 prefectures
cover the whole country for the Stage 1 discovery loop. The regions they're
grouped into are a VisitScotland-style tourism grouping (not a formal
boundary), used only for reporting/organizing batches, exactly like Japan's
Kanto/Kansai/etc. groupings.
"""

from __future__ import annotations

from .base import CountryConfig

ADMIN_UNIT_REGION: dict[str, str] = {
    "City of Edinburgh": "Edinburgh & Lothians",
    "East Lothian": "Edinburgh & Lothians",
    "Midlothian": "Edinburgh & Lothians",
    "West Lothian": "Edinburgh & Lothians",
    "Glasgow City": "Glasgow & Clyde Valley",
    "North Lanarkshire": "Glasgow & Clyde Valley",
    "South Lanarkshire": "Glasgow & Clyde Valley",
    "East Renfrewshire": "Glasgow & Clyde Valley",
    "Renfrewshire": "Glasgow & Clyde Valley",
    "Inverclyde": "Glasgow & Clyde Valley",
    "East Dunbartonshire": "Glasgow & Clyde Valley",
    "West Dunbartonshire": "Glasgow & Clyde Valley",
    "Highland": "Highlands",
    "Aberdeen City": "Aberdeenshire & Grampian",
    "Aberdeenshire": "Aberdeenshire & Grampian",
    "Moray": "Aberdeenshire & Grampian",
    "Argyll and Bute": "Argyll & the Isles",
    "Fife": "Fife",
    "Perth and Kinross": "Perthshire",
    "Stirling": "Stirling & Trossachs",
    "Clackmannanshire": "Stirling & Trossachs",
    "Falkirk": "Stirling & Trossachs",
    "East Ayrshire": "Ayrshire & Arran",
    "South Ayrshire": "Ayrshire & Arran",
    "North Ayrshire": "Ayrshire & Arran",
    "Scottish Borders": "Scottish Borders",
    "Dumfries and Galloway": "Dumfries & Galloway",
    "Angus": "Angus & Dundee",
    "Dundee City": "Angus & Dundee",
    "Na h-Eileanan Siar": "Outer Hebrides",
    "Orkney Islands": "Orkney",
    "Shetland Islands": "Shetland",
}

SCOTLAND = CountryConfig(
    code="GB",
    name="Scotland",
    demonym="Scottish",
    admin_unit_label="council area",
    admin_unit_region=ADMIN_UNIT_REGION,
    category_examples=(
        "castles, distilleries, lochs, munros and hill walks, cathedrals, abbeys, "
        "museums, galleries, gardens, historic battlefields, standing stones, "
        "golf links, harbours"
    ),
    source_guidance=(
        "Prefer VisitScotland, National Trust for Scotland, Historic Environment "
        "Scotland, Wikipedia, and Wikimedia Commons. Do not use Reddit, TripAdvisor, "
        "TikTok, Instagram, or review text as factual truth."
    ),
)
