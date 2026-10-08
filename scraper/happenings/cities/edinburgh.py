"""Edinburgh city config for the happenings research pipeline.

Source domains below are all verified to exist (per the brief) — used
verbatim, do not add unverified domains without checking they resolve and
actually state terms (see rule 10 in happenings_research.py: never cite an
aggregator that merely links elsewhere without itself stating the terms).
"""

from __future__ import annotations

from ..base import CityHappeningsConfig

EDINBURGH = CityHappeningsConfig(
    slug="edinburgh",
    city="Edinburgh",
    region="Scotland",
    country_code="GB",
    timezone="Europe/London",
    currency="GBP",
    local_postcode_prefix="EH",
    calendar_sources=(
        "doorsopendays.org.uk",
        "edinburgh.org/whats-on/",
        "edinburgh.org/residentrewards/",
        "edinburghfestivalcity.com",
        "list.co.uk",
        "whatsoninedinburgh.co.uk",
        "nms.ac.uk",
        "nationalgalleries.org",
    ),
    offer_sources=(
        "edinburgh.org/planning/offers-deals/",
        "designmynight.com/edinburgh",
        "realmarykingsclose.com",
        "nms.ac.uk",
        "nationalgalleries.org",
        "picturehouses.com/cinema/the-cameo",
        "filmhouse.org.uk",
        "dominioncinema.co.uk",
    ),
    national_sources=(
        "odeon.co.uk",
        "cineworld.co.uk",
        "nts.org.uk",
        "historicenvironment.scot",
        "unidays.com",
        "studentbeans.com",
        "jdwetherspoon.com",
        "nandos.co.uk",
    ),
    known_fixtures=(
        "Doors Open Days Edinburgh",
        "National Cinema Weekend UK",
        "Forever Edinburgh Resident Rewards Days",
        "Edinburgh's Hogmanay",
        "Edinburgh Science Festival",
        "Edinburgh International Film Festival",
        "St Andrew's Day free entry Scotland",
        "Burns Night Edinburgh",
        "Museums at Night / late openings Edinburgh",
        "Historic Environment Scotland free entry days",
        "Free Fringe",
        "Young Scot £1 Edinburgh Castle",
    ),
    calendar_guidance=(
        "Walk known_fixtures one by one by name via web_search — do not rely on a single "
        "generic 'events in Edinburgh' or 'whats on Edinburgh' query, which surfaces "
        "aggregator noise and misses named annual fixtures entirely (this is the exact "
        "failure mode that made the app's own user miss National Cinema Weekend). For each "
        "fixture, search for its official page (doorsopendays.org.uk, edinburgh.org, "
        "edinburghfestivalcity.com, nms.ac.uk, nationalgalleries.org, or the relevant "
        "national_sources domain for a UK-wide fixture like National Cinema Weekend) and "
        "confirm this year's or next occurrence's actual stated date before recording one. "
        "After working through known_fixtures, do a small number of broader searches "
        "against list.co.uk / whatsoninedinburgh.co.uk to catch dated one-offs not already "
        "named above, but treat those as a supplement, never the primary method."
    ),
    offer_guidance=(
        "Recurrence first: most offers here are standing venue deals (a permanent discount, "
        "a weekly happy hour, a resident-only year-round code) rather than dated events — "
        "expect starts_at/ends_at to be null far more often than not, with the real timing "
        "captured in `recurrence` and `time_note`. Check edinburgh.org/planning/offers-deals/ "
        "and realmarykingsclose.com first for resident/local discounts and their exact promo "
        "codes; check designmynight.com/edinburgh for venue happy-hour and "
        "2-for-1 deals. A promo code must be copied character-for-character from the page "
        "that prints it — if a discount is described but no code is printed, promo_code is "
        "null, never a guess at what the code 'probably' is.\n"
        "Also broaden the search beyond one-off promo codes to three more categories, each "
        "only if currently valid and sourced: (1) student deals — check unidays.com and "
        "studentbeans.com for Edinburgh-valid venues/offers, and cinema chains' own student-day "
        "pages (odeon.co.uk, cineworld.co.uk); (2) UK chains with an Edinburgh-valid standing "
        "offer, e.g. Wetherspoon (jdwetherspoon.com) meal deals or Nando's student/Fridays "
        "offers (nandos.co.uk) — only record it if the chain's own page states the offer "
        "applies nationally/at Edinburgh branches; (3) cheap cinema days at Edinburgh's "
        "independent cinemas — picturehouses.com/cinema/the-cameo, filmhouse.org.uk, "
        "dominioncinema.co.uk (Filmhouse's own site, not a listings aggregator, for its "
        "current status). Separately, record permanently-free museums/galleries as "
        "kind=free_access with recurrence {\"type\":\"always\"} — e.g. National Museum of "
        "Scotland (nms.ac.uk) and the National Galleries of Scotland sites "
        "(nationalgalleries.org) — only when the page itself states free general admission."
    ),

    whats_on_sources=(
        "parkrun.org.uk",
        "edinburgh.org/whats-on/",
        "rbge.org.uk",
        "waterofleith.org.uk",
        "nms.ac.uk",
        "nationalgalleries.org",
        "edinburghfarmersmarket.co.uk",
        "stockbridgemarket.com",
    ),
    whats_on_fixtures=(
        "Cramond parkrun",
        "Portobello parkrun",
        "Holyrood parkrun",
        "Edinburgh Free Tour Old Town",
        "Sandemans New Europe Edinburgh free walking tour",
        "Royal Botanic Garden Edinburgh free guided walk",
        "Water of Leith Conservation Trust guided walk",
        "Edinburgh Farmers Market Castle Terrace",
        "Stockbridge Market",
        "National Museum of Scotland late / after-hours event",
        "National Galleries of Scotland free talk",
    ),
    whats_on_guidance=(
        "This mode is NOT about discounts — it's about things worth doing that a visitor or "
        "even a longtime resident might not know are happening. For every parkrun, verify the "
        "actual run day/time and start location on the specific event's own parkrun.org.uk page "
        "(e.g. parkrun.org.uk/cramond) rather than assuming Saturday 9am — some UK parkruns run "
        "different days. For walking tours, distinguish genuinely free/tip-based tours (record "
        "is_free=true, saving_label 'Free (tips welcome)') from paid ones (is_free=false, real "
        "price in saving_label only if that's the notable fact). For markets, get the actual "
        "recurrence (weekly on a specific day vs monthly) from the market's own site, not a "
        "generic listings page. For museum/gallery lates and free talks, check nms.ac.uk and "
        "nationalgalleries.org's own events/whatson pages for actual dates or recurring patterns "
        "— do not invent a 'first Thursday of the month' pattern unless the venue's page states it."
    ),

    book_early_sources=(
        "edinburghshogmanay.com",
        "edfringe.com",
        "eif.co.uk",
        "edbookfest.co.uk",
        "edinburghchristmas.com",
        "tickets.edintattoo.co.uk",
        "scottishrugby.org",
        "usherhall.co.uk",
        "edinburghplayhouse.org.uk",
        "ticketmaster.co.uk",
        "gigsinscotland.com",
    ),
    book_early_fixtures=(
        "Edinburgh's Hogmanay tickets on sale",
        "Edinburgh Festival Fringe tickets on sale",
        "Edinburgh International Festival tickets on sale",
        "Edinburgh International Book Festival tickets on sale",
        "Royal Edinburgh Military Tattoo tickets on sale",
        "Edinburgh Christmas Market",
        "Scotland rugby Murrayfield tickets on sale",
        "Usher Hall upcoming concerts on sale",
        "Edinburgh Playhouse upcoming shows on sale",
    ),
    book_early_guidance=(
        "For each fixture, search for its OWN ticketing announcement (the venue's or festival's "
        "own site, or a reputable news report quoting the official on-sale time) — never infer a "
        "release date from 'last year it was around this time'. Hogmanay, the Tattoo, and "
        "Fringe/EIF/Book Festival tickets typically go on sale months ahead with a publicised "
        "date and time; Murrayfield internationals and Usher Hall/Playhouse concerts are "
        "announced individually per show/fixture. When you find a specific on-sale time (e.g. "
        "'tickets on sale 10am, Wednesday 1 October'), that precision is the single most "
        "valuable thing this mode produces — do not round it down to just a date. If a fixture's "
        "next occurrence hasn't been announced yet at all (no date, no on-sale info published "
        "anywhere), skip it rather than guessing when it 'usually' happens."
    ),
)
