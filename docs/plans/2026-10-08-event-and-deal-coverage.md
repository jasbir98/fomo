# Plan: more Edinburgh events and deals, more sources, proper validation

> **Outcome (8 Oct):** built on branch `event-coverage`. Not built after checking: DICE (terms clause 6.4 forbids crawlers), Fatsoma (sitemap frozen in 2023), Royal Botanic Garden (robots disallows its events API), PizzaExpress deals (left in shadow, nothing passed the gate). The Festivals API adapter is built but waits for a key. Current state lives in `docs/daily-sources.md` and `docs/weekly-pipeline.md`.

## Context

Fomo's events table holds **726 upcoming events** (checked 8 Oct). Skiddle supplies 389 and Ticketmaster 203. The other five sources are thin: Songkick 44, allevents 39, Sneaky Pete's 24 (none with photos), Eventbrite 15, Luma 12. Sites like 5pm.co.uk list far more, and the user wants coverage that feels complete, **for deals as well as events**.

Deals are about 111 live rows in `happenings` (kind `deal`). Almost all of them come from the weekly DeepSeek web-search topics (13 of the 47 topics are deal searches). None comes from a structured source, because the existing direct-source path only parses events.

All events come from the daily job `scripts/daily-sources.mjs` (2,087 lines, one file). It writes rows to the `events` table, skipping any row it already has. Four gaps:
- nothing ever removes expired or cancelled events;
- results aren't checked beyond the Edinburgh distance filter (which only allevents uses);
- nothing tracks whether a source is healthy;
- events are never linked to venues (`events.place_id` is always empty), so they can't borrow a venue's photo or details.

**User decisions (8 Oct)**
- **Window:** keep every event happening in the next 31 days, at any price. Fetch on a rolling basis, and retire events once they've passed.
- **Photos:** free fallbacks only, so no Google photo calls. Google may still be used for venue details within its free monthly quotas.
- **Sources approved:** DICE, Forever Edinburgh, Jazz Bar via DeepSeek, Fatsoma, plus anything else that can be added safely. Meetup was also requested; see below.

- **Retiring old rows:** soft-delete only. Events get a status (`expired`, `gone` or `cancelled`), the same way happenings go `dormant`. Nothing is hard-deleted.
- **Deals:** find the valid deal sources and add them.

**Not included, and why** (probed 8 Oct)
- **5pm.co.uk:** Cloudflare's bot check blocks every client, normal browsers included. Reading it would mean bypassing the block. The only route is asking 5pm for a feed or partnership.
- **Meetup:** its terms forbid displaying its data in a third-party commercial app, and the API needs a paid Pro plan under the same terms. Some Meetup events already reach us through allevents.
- **Young Scot:** its terms forbid scraping. We ask them for permission (a to-do).
- **Groupon, Wowcher:** Groupon's pages are behind a Cloudflare challenge. Wowcher's pages are challenged too, and its JSON API is undocumented, so there's no page we can check its deals against. Both are better reached through an affiliate feed (Awin or Partnerize), which also fits the "booking commissions" to-do.
- **Blocked:**
  - Events: Ents24, National Museums, National Galleries, Edinburgh Reporter.
  - Deals: TheFork, Cineworld, Odeon, Vue, Tesco Clubcard, O2 Priority, Nando's, OpenTable, EUSA.
  - Stramash and Whistlebinkies refuse our bot's identity, and we won't disguise it.
- **Not worth it:**
  - Events: Fever (paid shows), The List (owns the paid Data Thistle feed), The Skinny (stale), EdinburghGuide and EventsList.
  - Deals: DesignMyNight (no offers page), Student Beans and UNiDAYS (national online brands, login-gated), tastecard (paid membership). Quandoo has shut down.
- **Egress caveat:** these probes went out through Delhi (Cloudflare's `cf-ray` codes ended `-DEL`), and several blocks look geographic. The pipeline runs on GitHub's runners, so a one-off probe workflow re-checks the blocked list from there (Phase 2). A source that answers cleanly from there and allows us in robots.txt joins the shadow-mode queue.

## How the work is split

- **Main session (Opus):** plans, reviews every diff, runs the dry runs and spot-checks, and decides when a source goes live.
- **Sonnet agents:**
  - the refactor, cleanup and validation work;
  - the harder event adapters (DICE, Festivals API, Forever Edinburgh, Jazz Bar with DeepSeek);
  - venue linking;
  - the deal-source framework, plus the pipeline fixes it needs (Phase 7).
- **Haiku agents:**
  - expanding the existing sources;
  - simple config-driven adapters;
  - probing sites and the probe workflow;
  - the smaller deal page configs;
  - docs.

Work happens on a new branch `event-coverage`, cut from `main`, and ends in one PR. Phases 3, 4 and 7 can run in parallel: each adapter lives in its own file, so the agents don't collide.

---

## Phase 0: Split `daily-sources.mjs` into modules (Sonnet)

This is behaviour-preserving and must land first.
- Create `scripts/sources/core/`:
  - `fetch.mjs`: the robots.txt handling, `politeFetch`, host rate limiting and challenge detection.
  - `jsonld.mjs`: `extractJsonLdBlocks`, `mapJsonLdEvent`, `pickImage`, `isoFromJsonLd`, `parsePrice`.
  - `normalize.mjs`: `isEdinburghRow`, `classifyCategory`, `isOffWedge`.
  - `dedupe.mjs`: `crossSourceKey`, `dedupeAcrossSources`, `PROVIDER_PRIORITY`.
  - `upsert.mjs`: `upsertEvents`, including the guard that stops an empty image overwriting an existing one.
  - `backfill.mjs`.
- Move each adapter to `scripts/sources/adapters/<name>.mjs` and export `{ name, cadence: 'daily'|'weekly', status: 'live'|'shadow', run(ctx) }`. `scripts/sources/registry.mjs` lists them all.
- `daily-sources.mjs` stays the entry point with the same flags (`--write`, `--only`, `--skip`, `DAILY_SOURCES_SKIP`).
- Fix the stale comments that still mention the deleted `getForDestination.ts`.
- **Gate:** a dry run before and after the split must give identical per-source counts.

## Phase 1: Rolling 31-day window and removing old events (Sonnet)

- **One lookahead setting.** Add `LOOKAHEAD_DAYS = 31` in core and use it everywhere. Skiddle and Ticketmaster drop from 60 days to 31. Rows starting after the window are dropped at ingest.
- **New SQL file** `supabase/add_event_lifecycle.sql`. The user runs it before deploy.
  - New `events` columns: `last_seen_at timestamptz`, `status text not null default 'active'` (`active` / `cancelled` / `gone` / `expired`), `enriched_at timestamptz`.
  - New `event_source_runs` table: `run_id, provider, started_at, ok, fetched, kept, inserted, updated, rejected jsonb, error`. Row-level security on, service role only.
  - New `source_pages` table, a page-change ledger shared by every source that sends pages to the AI (Forever Edinburgh, the Jazz Bar, all the deal pages): `url (unique), source_id, content_hash, last_fetched_at, last_changed_at, last_status`. If a page's normalised text hasn't changed, its extraction is skipped. This is a smaller version of the `source_items` ledger in `docs/plan-data-collection.md`.
- **During each run:** every upserted row gets `last_seen_at = now()`. JSON-LD `eventStatus` values `EventCancelled` or `EventPostponed` become `status = 'cancelled'`, as does Ticketmaster's `dates.status.code`.
- **Retirement step: soft-delete only, never `DELETE`.** It runs only with `--write`, at the end of the run, and follows the same pattern as `happenings` going dormant.
  1. Events whose end (or start, if no end) has passed become `status = 'expired'`.
  2. Mark an event `gone` when all of these hold: it hasn't been seen for 3 days, it starts within the next 25 days, and its source had a successful run in each of those 3 days. The successful runs are read from `event_source_runs`. A source that failed or came back empty never retires its own rows.
  3. A `gone` or `cancelled` row that shows up again in its source goes back to `active`, because the upsert sets `status` and `last_seen_at`.
  - Rows are kept, so saved items, shared links and the sitemap never break. Add an index on `(status, starts_at)` so the app's queries stay fast as the table grows.
- **App side:** `lib/db/events.ts` (`listUpcomingEvents`, `listEventsByIds`) filters to `status = 'active'`. Detail pages for expired or gone events still render, with a "This has finished" note, as happening pages do today. Deploy this only after the SQL has run.

## Phase 2: Validation and source health (Sonnet)

- **New `scripts/sources/core/validate.mjs`** (pure functions, unit-tested with `node --test`). Every row from every adapter goes through it.
  - **Hard rejects, each counted by reason:**
    - missing name or start time;
    - start time in the past or beyond the window;
    - end before start;
    - outside Edinburgh (the existing distance filter, now applied to **all** sources);
    - online-only (JSON-LD `VirtualLocation`, or "online" or "livestream" as the venue);
    - non-http links;
    - junk titles, such as test listings, all-symbol names, or a title that is just the venue name.
  - **Soft fixes:**
    - decode HTML entities and trim titles;
    - check a new row's `image_url` with a HEAD request (it must be an image and return 200; at most 300 checks a run), and set a broken one to null so the fallback image is used.
- **Shadow mode for new sources.** An adapter with `status: 'shadow'` is fetched, validated and reported, but never written. It goes `live` only after I review its first report and spot-check.
- **New spot-check script** `scripts/check-event-sample.mjs --provider=x --n=10`. For a random sample of rows it fetches the event's own page and confirms the title words and the date appear there, then prints an accuracy %.
  - A new source needs at least 90% to go live.
  - A weekly CI step samples 5 rows per source and reports the result.
- **Health check.** Each run writes one `event_source_runs` row per source. The GitHub Actions job summary flags a source in two cases:
  - it kept 0 rows for 2 runs in a row;
  - it kept less than 40% of its 7-day median.
- The run summary also lists rejection reasons per source.
- **Probe workflow (Haiku).** `scripts/probe-sources.mjs` plus a manually triggered `.github/workflows/probe-sources.yml`. It re-checks the blocked list (events and deals) from GitHub's runners, the network the pipeline actually uses. For each site it records robots.txt, HTTP status, challenge detection and structured-data counts. The bot keeps its real identity, and nothing gets past a challenge. Results go into `docs/daily-sources.md`.

## Phase 3: Get more from the existing sources (Haiku)

- **Eventbrite:** read the categories `all-events`, `free--events`, `nightlife--events`, `events--this-weekend`, `music--events`, `arts--events`, `food-and-drink--events` and `community--events`.
  - For each category, read pages 1 to N, where N is the `page_count` stated in the page HTML, capped at 50.
  - Drop rows outside the window and de-duplicate on the `/e/` event id.
  - At one request a second that's roughly 300 pages, about 6 minutes.
  - If Eventbrite answers 405, log it and skip the source.
- **Songkick:** follow `?page=N` until a page adds nothing new.
- **allevents:** probe its category and pagination URLs (`/edinburgh/music`, `/edinburgh/free`, `?page=`). Add any that carry JSON-LD.
- **Workflow:** in `.github/workflows/daily-sources.yml`, raise the timeout from 15 to 35 minutes and add `DEEPSEEK_API_KEY` (and the Festivals keys, once issued) to the env.

## Phase 4: New structured sources (Sonnet; Haiku for the config-driven ones)

Each one starts in shadow mode and goes through the Phase 2 gate.

| Source | Adapter | Notes |
|---|---|---|
| Voodoo Rooms | Generic `tribe-events.mjs` (Haiku), configured with a list of venues | Reads `/wp-json/tribe/events/v1/events?per_page=50&page=N` and follows `next_rest_url`. 76 events, all with photos. Add a generic `ical.mjs` alongside it so future venues are a one-line config change. |
| DICE | `dice.mjs` (Sonnet) | **First, read DICE's terms. If they forbid automated collection, stop and report back.** Otherwise read `sitemap1–8.xml`, keep `/event/` URLs containing `edinburgh`, and fetch each page's JSON-LD. Only fetch URLs not already stored, plus ones whose stored start is within 3 days, to re-check them. About 80 events. |
| Edinburgh Festivals API | `festivals-api.mjs` (Sonnet) | Requests are signed with HMAC-SHA1. Fetch every festival whose performances fall in the window (Storytelling runs 21–31 Oct, Hogmanay 29 Dec–1 Jan). Without `FESTIVALS_API_KEY` / `FESTIVALS_API_SECRET` it is skipped and logged. **In the app**, festival-sourced events show "Data courtesy of the Edinburgh Festivals Listings API · Fomo is not an official festival app", and ticket links go where the licence says. |
| Forever Edinburgh | `forever-edinburgh.mjs` (Sonnet), runs weekly | Reads `/wp-json/wp/v2/event?per_page=100&_embed` for the title, photo and categories (category 880 is "free"). The date comes from each event's page, parsed by code, not AI. A page is only re-fetched when the API's `modified` date is newer than the stored row. |
| Fatsoma | Probe, then maybe an adapter (Haiku) | Check its sitemaps and its event pages for JSON-LD. Add it only if the data is structured; otherwise record why it was turned down in `docs/daily-sources.md`. |
| Royal Botanic Garden | Probe, then maybe an adapter (Haiku) | Its calendar data comes from `POST /umbraco/api/eventsapi/getvalidevents`. If that returns event JSON, add it. |

- Add every new provider to `PROVIDER_PRIORITY` in `scripts/sources/core/dedupe.mjs`, and to its counterparts in `lib/events/identity.ts` and `lib/happenings/merge-events.ts`. Keep them in step: those three must stay in sync.

## Phase 5: Jazz Bar listings via DeepSeek (Sonnet), weekly

- Fetch `/wp-json/wp/v2/posts?search=listings` and take the newest 2 posts covering the window. Send the post text to DeepSeek (`deepseek-flash`, the same Anthropic-compatible endpoint the scraper already uses; see `scraper/llm_client.py` for the known quirks).
- Ask for one entry per gig: `{title, date, time, price, quote}`.
- Keep a gig only if all of these hold:
  - the quote appears word for word in the post, compared after the same normalising that `scripts/lib/extraction-gate.mjs` does;
  - the date sits under the matching day header;
  - any price figure appears in the quote.
- Venue is fixed to The Jazz Bar. Spend is capped at $0.10 a run.

## Phase 6: Photos and venue details, free sources only (Sonnet)

- **Link events to venues.** In the daily run, match each event's venue name, plus a distance check, against the `places` table using `buildPlaceIndex` / `matchVenueName` from `scripts/lib/place-match.mjs`, and fill `events.place_id`. Ambiguous matches stay unlinked and are listed in the summary.
- **Photo fallbacks, cheapest first.** Google photos are not used.
  1. The source's own image.
  2. The event page's `og:image`. The description backfill already fetches that page, so taking the image too costs nothing. Raise its cap from 150 to 400 a run, and use `enriched_at` to skip rows already tried, so the same pages aren't fetched every day.
  3. At read time, the linked venue's own `places.image_url`.
  4. A category tile. Pass `category` into `defaultImageFor` in the feed and detail cards; today they pass nothing, so every event gets the neutral tile.
- **Venue details from Google.** Some venues aren't in `places`, or are missing an address or location. For each one with at least 2 upcoming events, look it up with Google Text Search (the free IDs-only tier) and Place Details (Essentials fields: address, location, Maps link), at most 100 calls a run. Then add or update a `places` row using the existing `scripts/lib/google-place-map.mjs` (`acceptMatch`, `buildPlacePatch`). Google-owned columns keep the 30-day expiry already enforced by `enrich-places-google.mjs`. **No photo fields.**
- **App.** `lib/db/events.ts` joins `place:places(image_url, website, google_maps_uri, address)`. `EventDetail.tsx` shows the venue address, a Maps link and the website, and uses the venue photo when the event has none.

## Phase 7: Deal sources (Sonnet builds the framework; Haiku adds the page configs)

Deals stay in `happenings` and go through the existing staging, verify and promote path. This phase adds **page-grounded deal sources** alongside the DeepSeek web-search topics, so deals come from pages we read directly rather than from search results.

**7a. Pipeline fixes needed first** (Sonnet, in `scraper/` and `scripts/promote-happenings.mjs`)
- **New SQL file** `supabase/add_deal_source_columns.sql` adds `price_text`, `includes` and `season_valid_until` to `happenings_staging`. Add the same three to `ALLOWED_COLUMNS` in `scraper/upsert_happenings.py` and to the column list in `promote-happenings.mjs`. Promote also carries over the staging row's `place_id` and `image_url`, instead of throwing them away.
- **Don't overwrite enriched text.** When promote updates an existing slug, a field that already has evidence in `enrich_sources` keeps its stored value; the model's paraphrase doesn't replace it.
- **Soft-retire ended recurring deals.** `scripts/sweep-happenings.mjs` also moves weekly and `dates` deals to `dormant` once `recurrence.until` (or their last date) has passed. Today these stay `live` and are only hidden by the app.
- **Approve SQL for verified rows.** The report's approve SQL also covers rows that passed verification but are still `approved=false`, so one command approves everything that verified cleanly.

**7b. Deal-source framework** (Sonnet): new `scraper/deal_sources/`, called from `weekly_edinburgh.py` before the search topics.
- **Each source** is a config: `{id, name, trust: 'official'|'commercial', discover, extract_hints}`. `discover` is one of three things: a WordPress REST query, a sitemap filter, or a fixed list of URLs.
- **Flow for each page:**
  1. Fetch the page politely (robots.txt, the bot's real identity, skip on any challenge).
  2. Hash the text and check `source_pages`; an unchanged page is skipped.
  3. DeepSeek extracts every deal on the page into the existing happenings schema. Each field comes with the verbatim quote it came from.
  4. Run the existing evidence gate and verify step.
- **Rules every deal must pass:**
  - The quote appears word for word on the page.
  - Every £ figure and % figure appears in its quote.
  - Any promo code is verbatim.
  - Dates and weekdays are stated on the page.
  - The deal is in Edinburgh: an EH postcode, a matched `places` row, or an official Edinburgh source.
  - It hasn't expired.
  - It would pass the app's `isGenuineDeal` check (a real saving, discount wording or a promo code). Plain-price vouchers like "£45 afternoon tea" aren't counted as deals.
- **Duplicates:** `scraper/identity.py` matches each deal against live and dormant rows.
- **Photo and venue:** the page's `og:image` or the WordPress featured image. Venues link through `place-match`, with a free Google lookup for unknown venues (the same rule as Phase 6).
- **Publishing:**
  - From `official` sources, a deal that passes every check is published automatically.
  - Deals from `commercial` sources always go to review.
  - Either way, every row appears in the weekly report.
- **Spend:** DeepSeek is capped at $0.50 a run for deal pages, inside the existing $3 weekly cap.

**7c. Deal sources to add** (all probed 8 Oct; each starts in shadow mode, meaning it is reported but not staged, until one report has been reviewed)

| # | Source | Discover | Trust | Expected |
|---|---|---|---|---|
| 1 | Forever Edinburgh offers and deals | `edinburgh.org/wp-json/wp/v2/pages?parent=5095&per_page=100&orderby=modified`, using `content.rendered` | official | 10–20 live at a time (brunches, kids eat free, set menus) |
| 2 | More By The Shore specials (Leith and Newhaven) | `edinburgh.org/wp-json/wp/v2/pages?slug=more-by-the-shore-specials` | official | About 35 offers, with addresses and dates |
| 3 | Resident Rewards | Page 7239 and its child pages. It moves from the search topic to direct reading. | official | The existing rewards, refreshed |
| 4 | itison Edinburgh | Links from `/edinburgh` → `/Edinburgh/deals/<slug>`. Reads `og:price:amount`, the validity text, days and times, and the address. | commercial | About 30–40 in Edinburgh. Out-of-city ones (no EH postcode) and anything without a stated saving are dropped. |
| 5 | Fort Kinnaird offers | `/offers` with `?type=student` and the dining and kids filters | commercial | 10–20 student and kids offers |
| 6 | OMNI Centre | `/offers/student-discounts-and-more` | commercial | 8–10 |
| 7 | Edinburgh Leisure | Watch `page-sitemap.xml` and `post-sitemap.xml` for URLs containing `offer`, `free` or `£0` | official | 5–10 a year, cheap or free |
| 8 | PizzaExpress offers | `/offers`, stored as a national-scope deal valid at the Edinburgh branches | commercial | 3–6 |

- The 13 deal search topics keep running, but they now skip anything these direct sources already cover. Known-items injection already passes their titles in. The topics' dead seeds are removed: 5pm, `filmhousecinema.co.uk` and `cameopicturehouse.co.uk`.
- **Annual promo calendar** (Haiku): `scraper/deal_sources/annual.yaml` lists the promotions that come round once a year: National Cinema Day, Doors Open Days, Museums at Night, National Lottery Open Week and Kids Eat Free weeks. Each entry has its usual month and the official announcement URL. In the 6 weeks before an entry's usual month, its URL is checked like any other deal page.

## Phase 8: Docs and wrap-up (Haiku)

- Rewrite `docs/daily-sources.md`: the source table, the shadow-to-live process, the soft-retire rules, validation, health checks and the probe results.
- Update `docs/weekly-pipeline.md`: the deal sources, official vs commercial trust, the `source_pages` skip, and the topic count (47, not 32).
- Save this plan as `docs/plans/2026-10-08-event-and-deal-coverage.md` and add a row to `docs/README.md`.
- Add these open to-dos to `docs/README.md`:
  - run `add_event_lifecycle.sql` and `add_deal_source_columns.sql`;
  - register for the Festivals API as an app developer ("Type C", which needs their approval) and add the key and secret as GitHub secrets;
  - add `DEEPSEEK_API_KEY` to the daily workflow's environment;
  - ask Young Scot for permission to list their discounts;
  - ask 5pm for a feed or partnership;
  - look into Awin/Partnerize affiliate feeds for Groupon and Wowcher, alongside the money to-do.

## Critical files

- `scripts/daily-sources.mjs`, which becomes the entry point over the new `scripts/sources/{core,adapters}/`; `scripts/check-event-sample.mjs` and `scripts/probe-sources.mjs` (new).
- Reused: `scripts/lib/place-match.mjs`, `scripts/lib/google-place-map.mjs`, `scripts/lib/describe.mjs` and `scripts/lib/extraction-gate.mjs`.
- `scraper/weekly_edinburgh.py`, `scraper/deal_sources/` (new), `scraper/upsert_happenings.py`, `scraper/identity.py` (reused), `scraper/llm_client.py` (reused), `scraper/happenings/cities/edinburgh.py` (dead seeds).
- `scripts/promote-happenings.mjs`, `scripts/sweep-happenings.mjs`.
- `supabase/add_event_lifecycle.sql` and `supabase/add_deal_source_columns.sql` (new).
- `lib/db/events.ts`, `lib/events/identity.ts`, `lib/happenings/merge-events.ts`, `lib/happenings/category-style.ts` (`defaultImageFor`) and `EventDetail.tsx`.
- `.github/workflows/daily-sources.yml`, `weekly-research.yml`, and `probe-sources.yml` (new).

## Verification

1. **Unit tests:** `node --test scripts/sources/core/*.test.mjs scripts/lib/*.test.mjs` cover validation, dedupe with the new providers, window filtering and date parsing. `npx tsx --test` covers the changes to `lib/`.
2. **Refactor check:** dry-run counts per source are identical before and after Phase 0.
3. **Each new source:** run it in shadow mode, read its report (counts, rejection reasons, sample rows), then run `check-event-sample.mjs` on it. It goes live only at 90% or better.
4. **Local `--write` run:** query upcoming events by provider, with the share that have a photo, a `place_id` and status `active`. Compare against 726 today. The aim is 1,500 or more unique events in the next 31 days after de-duplication.
5. **Retirement check:** do a dry run first that prints what would become `expired` or `gone` without changing anything. Then confirm no rows were deleted (the total row count never drops) and that a saved event that has expired still opens.
6. **Production run:** trigger the daily workflow by hand from GitHub (`workflow_dispatch`). Check the job summary's source-health table and that it finishes in under 35 minutes.
7. **Deals:**
   - Run `python3 scraper/weekly_edinburgh.py --dry-run`, then a `--stage` run with only the deal sources.
   - Read the report: deals per source, gate rejections, and duplicates of live rows.
   - Hand-check 10 staged deals against their pages.
   - Confirm that unchanged pages are skipped on a second run (`source_pages`) and that the run cost what the report says.
   - After promote, check `/deals` and the Today strip in the app. Each new deal should show its saving, its photo or its venue's photo, and the right days.
8. **App check:** run the dev server. The feed and Explore should show the new events with photos or category tiles, never blank. An event's detail page should show venue details, and a festival event should show the attribution line. Screenshot as proof.
