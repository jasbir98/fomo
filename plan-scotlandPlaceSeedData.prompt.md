## Plan: Scotland Place Seed Data (+ Generalize the Japan Pipeline)

Reuse the proven Japan places pipeline (`scraper/discover_cities.py` →
`scraper/discover_and_extract_city.py` → staging review → promote) for
Scotland. Almost nothing about the pipeline's *mechanics* is actually
Japan-specific — the Supabase schema, `/api/places`, the Map/Home curated-pick
lookup, the weather/disruption logic, and the real Claude chat are all already
destination-string/city-name driven and need **zero changes**. What's
hardcoded to Japan lives in a small number of places: two Python scripts'
constants/prompts and two literals in the promote script. The right move is a
one-time generalization pass (pull Japan's constants into a swappable
"country config"), then add a `scotland.py` config and run the same pipeline.

**Audit: what's already generic vs. what's Japan-only**

Already generic, confirmed by reading the code — no changes needed:
- `supabase/add_japan_places_pipeline.sql` — `places`/`places_staging` columns
  are `city text`, `prefecture text`, `country text default 'JP'`. The
  `'JP'` is a default value, not a constraint; Scotland rows just set
  `country='GB'` explicitly. No migration needed.
- `lib/db/places.ts:listPlacesByCity` — matches any `source != 'google'`
  against `city ilike` / `prefecture ilike`, not one hardcoded source string.
  A `seed-scotland-pipeline` row is picked up automatically.
- `app/api/places/route.ts` and `app/(shell)/page.tsx` — curated-first logic
  keys off `destination.split(",")[0]` (city guess), no country check.
- `lib/places/geocode.ts`, `lib/weather.ts` — Mapbox/Open-Meteo, geocode any
  destination string.
- `app/api/chat/route.ts` (the real Claude chat) — system prompt is built
  from `trip.destination` dynamically, including the emergency-mode
  instruction to "surface the destination country's real emergency numbers
  ... do not invent." Nothing Japan-specific here.
- `lib/roameo-ai.ts` — the v0 scripted mock with hardcoded Japan content
  (tipping etiquette, shrine etiquette, "call 110/119") is **dead code** for
  behavior: `app/api/chat/route.ts` and `app/(shell)/roameo/page.tsx` only
  import its *types* (`ChatMode`, `PlaceCard`, etc.), never `getChatReply`.
  No action needed for Scotland; optional unrelated cleanup only.

Actually Japan-hardcoded (the real work):
- `scraper/discover_cities.py` — `PREFECTURE_REGION` (47 Japan prefectures →
  9 regions) and a Japan-specific system prompt are module-level constants.
- `scraper/discover_and_extract_city.py` — `REGIONS` (the same 9 Japan
  regions, used as an `argparse` `choices=`) and `SYSTEM_PROMPT_TEMPLATE`
  hardcode "Japan" and Japan source guidance (JNTO, prefer official/Wikipedia
  over Reddit/TripAdvisor/social).
- `scraper/japan_place_extract.py` — legacy batch extractor (superseded by
  `discover_and_extract_city.py` per `scraper/JAPAN_PLACES_PIPELINE.md`, kept
  for future high-volume automation). Hardcodes `country: "JP"` and "Japan"
  throughout its prompt/schema.
- `scripts/promote-japan-places.mjs` — two literals: `source:
  "seed-japan-pipeline"` and `` `${cityOrPrefecture}, Japan` `` for
  `destination`.

**Recommended Option**

Do a small generalization refactor first (Step A below), then treat Scotland
as "just another config," exactly the way the Japan pipeline doc describes
scaling by prefecture. Do not fork the scripts into Scotland-only copies —
that duplicates every future fix. Start with a cheap pilot (agent-driven
variant, no API cost) for a handful of towns before running the Python
Haiku-based discovery pipeline nationwide, mirroring how Pilot 0/1 validated
Japan before `discover_cities.py`/`discover_and_extract_city.py` existed.

**Steps**

1. **Generalize `discover_cities.py`**: extract `PREFECTURE_REGION` and the
   discovery `SYSTEM_PROMPT` into a per-country config object (see Step 2).
   Add a `--country` flag (`japan` default, `scotland` new); everything else
   (progress file, resumability, Supabase exclusion fetch) stays as-is — the
   exclusion fetch already queries `source ilike '*seed*'` with no country
   filter, which is harmless today (Scotland/Japan city names won't collide)
   but worth tightening later with a `country` filter once more countries
   exist.
2. **Add a country-config module**, e.g. `scraper/countries/japan.py` and
   `scraper/countries/scotland.py`, each exporting: `CODE` ("JP"/"GB"),
   `NAME` ("Japan"/"Scotland"), `ADMIN_UNIT_LABEL` ("prefecture"/"region" —
   Scotland has no prefecture equivalent; use VisitScotland's ~13 tourism
   regions as the region grouping and a looser "area" string, e.g. "Isle of
   Skye" or "Loch Ness & Inverness", in the `prefecture` column — the column
   is just free text), `REGION_MAP` (admin-unit → region, mirrors
   `PREFECTURE_REGION`), `DISCOVERY_SYSTEM_PROMPT`, and
   `EXTRACT_SYSTEM_PROMPT_EXTRA` (source-preference and category guidance —
   see Step 4). `discover_cities.py` and `discover_and_extract_city.py` both
   import from this module by `--country` instead of hardcoding constants.
3. **Generalize `discover_and_extract_city.py`**: replace the hardcoded
   `REGIONS` choices and Japan-specific parts of `SYSTEM_PROMPT_TEMPLATE`
   with values pulled from the Step 2 config via `--country`. Tier targets
   (`TIER_TARGET_COUNT`/`TIER_MAX_SEARCHES`) and the dedupe-key/output-path
   logic are already country-agnostic — leave them.
4. **Define Scotland's category taxonomy** (parallel to Japan's
   shrine/temple/garden/market/viewpoint/landmark set), for the config's
   `EXTRACT_SYSTEM_PROMPT_EXTRA`: castle, distillery, loch, munro/hill walk,
   cathedral, abbey, museum, gallery, garden, historic battlefield, standing
   stones/prehistoric site, golf links, harbour, isle/island viewpoint. Keep
   the existing food/restaurant exclusion rule for parity with the separate
   reels-based food pipeline. Preferred sources: VisitScotland, National
   Trust for Scotland, Historic Environment Scotland, Wikipedia, Wikidata,
   Wikimedia Commons — same trust tier as JNTO/Wikidata for Japan; avoid
   TripAdvisor/Reddit/social as factual truth, same rule as Japan.
5. **Generalize `scripts/promote-japan-places.mjs`**: replace the two
   literals with parameters — `--source` (default keeps
   `seed-japan-pipeline` for backward compat) and either a
   `--destination-suffix` flag or a small `{JP: "Japan", GB: "Scotland"}`
   lookup keyed off `staging.country` (prefer the country→label lookup so a
   promote run never needs a manually-typed suffix). Rename to
   `scripts/promote-places.mjs` or keep the filename and just add flags —
   either is fine, but do not duplicate the file.
6. **Pilot** (agent-driven variant, no Python/API keys, same as Japan Pilot
   0/1): 4-6 towns — Edinburgh, Isle of Skye, Inverness/Loch Ness, St
   Andrews, Stirling, Glasgow — one `general-purpose` subagent per
   town, Haiku-equivalent consolidation, Opus critical review, then a
   generated `supabase/seed_scotland_pilot.sql` targeting `places_staging`,
   exactly like `seed_japan_pilot.sql`.
7. **Review gate + promote**: same rejection rules as Japan (no source URL,
   uncited fields, unlicensed photos, invented coordinates/hours/ratings,
   community text as fact) via the generalized `promote-places.mjs`.
8. **Verify in-app with zero app code changes**: `/api/places?destination=Edinburgh,%20Scotland`
   should return the curated Scotland picks the same way Tokyo/Kanto do
   today, because `listPlacesByCity` is already country-agnostic.
9. **Scale nationally** once the pilot's quality is confirmed: run
   `discover_cities.py --country scotland` for the full admin-unit list, then
   wave-based `discover_and_extract_city.py --country scotland` runs per
   region (Edinburgh & Lothians → Glasgow & Clyde Valley → Highlands →
   Aberdeenshire & Grampian → Fife & Perthshire → Argyll & the Isles →
   Ayrshire & Arran → Scottish Borders & Dumfries and Galloway → Angus &
   Dundee → Outer Hebrides / Orkney / Shetland), same wave-1-subagent →
   wave-2-direct-API-script pattern used for Japan's Kanto scale-up.

**Relevant Files**

- [scraper/discover_cities.py](scraper/discover_cities.py) — Stage 1
  (admin-unit discovery); has the `PREFECTURE_REGION` constant and the only
  Japan-specific system prompt in this stage. Needs the `--country` +
  config-import change (Step 1-2).
- [scraper/discover_and_extract_city.py](scraper/discover_and_extract_city.py) —
  Stage 2 (per-city research + extraction), the live pipeline path per
  `JAPAN_PLACES_PIPELINE.md`. Has the `REGIONS` constant and Japan-specific
  `SYSTEM_PROMPT_TEMPLATE`/`FINAL_SUBMIT_PROMPT` guidance. Needs Step 2-4.
- [scraper/japan_place_extract.py](scraper/japan_place_extract.py) — legacy
  batch extractor, hardcodes `country: "JP"` and "Japan" throughout; lower
  priority since Stage 2 above superseded it. Leave Japan-only (documented as
  legacy) unless a future high-volume batch mode is actually needed for
  Scotland too.
- [scripts/promote-japan-places.mjs](scripts/promote-japan-places.mjs) — the
  two literal Japan strings (`source`, `", Japan"` suffix). Needs Step 5.
- [supabase/add_japan_places_pipeline.sql](supabase/add_japan_places_pipeline.sql) —
  confirmed already country-agnostic (`country` has a default, not a
  constraint). No new migration needed for Scotland.
- [lib/db/places.ts](lib/db/places.ts) — `listPlacesByCity`, confirmed
  already generic (matches any non-`google` source against city/prefecture).
  No changes needed.
- [app/api/places/route.ts](app/api/places/route.ts) and
  [app/(shell)/page.tsx](app/\(shell\)/page.tsx) — curated-first lookup,
  confirmed already city-name-driven, no country check. No changes needed.
- [lib/disruption.ts](lib/disruption.ts) — `INDOOR_HINTS` list is a
  best-effort keyword match against category/name text; optionally add
  Scotland-relevant indoor words (`distillery`, `whisky`, `cathedral`,
  `abbey`) alongside the existing `museum`/`gallery`/`cafe`/`indoor`. Small,
  optional, not blocking.
- [lib/weather.ts](lib/weather.ts) — snow WMO codes (71-77, 85-86) are
  currently bucketed into the "rainy" disruption family with a comment
  noting Japan's launch cities/seasons rarely see snow. Scotland (Highlands,
  winter trips) will see real snow more often; the existing bucketing still
  correctly triggers a disruption alert for snow days, just with "Rain
  expected" copy instead of dedicated snow copy. Flag as an optional v1.1
  polish item, not a blocker for launch.
- [scraper/JAPAN_PLACES_PIPELINE.md](scraper/JAPAN_PLACES_PIPELINE.md) —
  once Steps 1-5 land, this doc's Python-script sections describe a
  Japan-only pipeline that's actually shared; either generalize this doc in
  place (rename references to "per `--country` config") or add a short
  `scraper/SCOTLAND_PLACES_PIPELINE.md` that just documents Scotland's config
  values, batch list, and links back here for the shared mechanics. Prefer
  generalizing the existing doc — a second near-duplicate doc will drift.

**Verification**

1. After the Step 1-5 refactor, run
   `python scraper/discover_cities.py --country japan --prefecture Tottori --dry-run`
   and confirm output is byte-identical in shape to today's pre-refactor run
   (regression check that generalizing didn't change Japan's behavior).
2. Run `python scraper/discover_and_extract_city.py --country scotland --city Edinburgh --region "Edinburgh & Lothians" --tier major --batch-id scot-pilot-<date>` (once the config exists) and inspect the written JSON for cited sources, no food/restaurant categories, and no invented coordinates/hours.
3. Confirm every promoted Scotland place has `country='GB'`, a non-null
   `city` or `prefecture`, and a `source` starting with `seed` (or whatever
   the pilot's chosen source string is) via a Supabase count query.
4. Hit `/api/places?destination=Edinburgh,%20Scotland` locally and confirm
   curated picks return before falling through to live Google — no app code
   changes should have been required for this to work.
5. Re-run the Japan pipeline once more after the refactor (a single
   prefecture is enough) to confirm the generalization didn't regress the
   existing Japan batches already promoted into `places`.
6. `npm run lint` after any `scripts/promote-places.mjs` / TS changes;
   `npm run build` only if a schema-dependent file actually changed (it
   shouldn't, per the audit above).

**Decisions**

- Generalize the pipeline scripts once, rather than forking
  `discover_cities_scotland.py`-style copies — the mechanics (resumability,
  dedupe-key format, citation/validation rules, staging→promote flow) are
  identical across countries; only the admin-unit list, region grouping, and
  a few prompt sentences differ.
- No Supabase schema changes are needed for Scotland — `city`/`prefecture`/
  `country`/`region` are already free-text columns with `'JP'` only as a
  default, not a constraint.
- Scotland's `prefecture`-column equivalent is a looser "area" (e.g. "Isle of
  Skye"), not a formal administrative unit, since Scotland's 32 council areas
  don't map to tourist relevance the way Japan's 47 prefectures roughly do.
  Use VisitScotland's ~13 tourism regions for the `region` grouping instead
  (the equivalent of Japan's 9 regions), since that's the source most likely
  to agree with what a Haiku discovery call will return.
- Keep the food/restaurant exclusion rule for parity with the existing
  separate reels/food pipeline rather than special-casing Scotland to include
  food in this pipeline.
- Treat the weather snow-bucketing gap and `INDOOR_HINTS` additions as
  optional polish, not launch blockers — both already degrade gracefully
  (snow still triggers a disruption alert; unmatched categories just don't
  get an indoor bias, same as today for any place whose category text
  doesn't match a hint).

**Further Considerations**

1. Scope: recommended default is the 4-6 town pilot (Step 6) before any
   Python/Haiku automation, exactly matching how Japan validated via Pilot
   0/1 first.
2. Source strictness: same high-trust default as Japan — official
   (VisitScotland, National Trust for Scotland, Historic Environment
   Scotland)/Wikidata/Wikimedia/Google-derived facts only; community/social
   sources for leads and tips, never as factual truth for hours/coordinates.
3. Destination-string convention: promoted Scotland places should produce
   `destination = "<city or area>, Scotland"` (not "..., UK" or "...,
   United Kingdom") to match how `new-trip`/`geocode.ts` examples and the
   app's existing "Tokyo, Japan" convention read a destination string — this
   is why Step 5 recommends a country→label lookup over a raw ISO code.
4. `lib/roameo-ai.ts` is unused dead code today (verified: only its types are
   imported, `getChatReply` is never called). Worth flagging separately as
   cleanup, but out of scope for enabling Scotland since the real chat
   (`app/api/chat/route.ts`) is already destination-agnostic.
