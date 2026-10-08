# Daily events ingest

`scripts/daily-sources.mjs` is the entry point for the daily events import. It runs the adapters in `scripts/sources/adapters/` (the list lives in `scripts/sources/registry.mjs`), checks every row, and upserts the good ones into the shared `events` table, keyed on `(provider, provider_event_id)`. Skiddle and Ticketmaster write to the same table (`supabase/archive/add_events.sql`).

Shared code lives in `scripts/sources/core/`: `fetch.mjs` (robots.txt, rate limits, challenge detection), `jsonld.mjs`, `normalize.mjs`, `dedupe.mjs`, `validate.mjs`, `upsert.mjs`, `retire.mjs`, `health.mjs`, `venues.mjs`, `google-venues.mjs` and `backfill.mjs`.

## Why

`events` was previously only ever populated as a side-effect of a user's own request (`lib/events/getForDestination.ts`: cache-first read, live Skiddle/Ticketmaster fan-out, upsert, 6h TTL). There was no proactive crawl. Coverage depended on which destinations happened to get queried, and on a small per-request page size, which is most of why only ~97 upcoming rows existed against a city with thousands of events a month. (That per-request page size was also raised from 20 to 100, the ceiling both provider APIs allow; see `lib/events/index.ts`.) This script is the proactive half: scheduled, source-diverse, and independent of user traffic. It uses the same Skiddle/Ticketmaster field mapping as `lib/events/`, but paginates over a 31-day window instead of one capped live-request page.

## Sources

Every adapter in the registry, in run order. Cadence `daily` runs every time; `weekly` runs only on Mondays (Europe/London). Status `live` rows are upserted; `shadow` rows are fetched, validated and reported, but never written.

| Provider | Source (URL or API) | Cadence | Status | Notes |
|---|---|---|---|---|
| `luma` | https://lu.ma/edinburgh | daily | live | About 20 events, mostly tech, startup and networking. schema.org JSON-LD, no auth. |
| `eventbrite` | `eventbrite.co.uk/d/united-kingdom--edinburgh/`: `free--events` first (up to 8 pages), then `all-events` | daily | live | JSON-LD, no auth. A listing stops after two pages in a row add nothing new. At most 40 listing pages a run in total. Eventbrite starts returning 429 at about 35 pages, so any block (401, 403, 405, 429, 503 or a challenge) stops the whole adapter for that run. Free listings go first so the cheap and free events are always covered. |
| `songkick` | https://www.songkick.com/metro-areas/24551-uk-edinburgh (`?page=N`, up to 20 pages) | daily | live | The Edinburgh metro area is **24551** (24542 is Birmingham). JSON-LD, no auth. Paging stops when a page starts past the window, adds nothing new, or has no events. |
| `allevents` | https://allevents.in/edinburgh/all (up to 12 pages) and `/edinburgh/free-events` (up to 3) | daily | live | Leaks non-Edinburgh rows onto these pages, so every row is geo-filtered first (within 15 km of the city centre, or a recognised Edinburgh locality). JSON-LD, no auth. At most 15 page fetches a run. |
| `skiddle` | Skiddle Events API `/events/search/`, 10 mile radius, paginated | daily | live | Needs `SKIDDLE_API_KEY`; skipped with a log line when absent. Event pages answer bots with an empty HTTP 202, so these rows can't be page-checked. |
| `ticketmaster` | Ticketmaster Discovery v2 `/events.json`, 10 mile radius, paginated | daily | live | Needs `TICKETMASTER_API_KEY`; skipped when absent. Cancelled and postponed events are stored with `status` set to `cancelled`. |
| `sneakypetes` | https://sneakypetes.co.uk/feed (`?paged=N`) | daily | live | Sneaky Pete's WordPress feed. Each item's `<pubDate>` is the show's own date and time. No auth. |
| `voodoorooms` | https://thevoodoorooms.com/wp-json/tribe/events/v1/events (up to 10 pages of 50) | daily | live | Via the generic `tribe-events.mjs` adapter. Spot-checked 10 of 10 on 8 Oct. The venue is the building; the room (for example The Ballroom) goes into the address. |
| `jazzbar` | https://www.thejazzbar.co.uk/wp-json/wp/v2/posts?search=listings (newest 2 posts) | daily | live | Gigs are parsed from the post by code. DeepSeek is only a fallback when the parse looks unreliable (capped at $0.10 a run). Every gig must pass the quote check. The venue is fixed to The Jazz Bar. |
| `edfestivals` | Edinburgh Festivals Listings API, `api.edinburghfestivalcity.com` (HMAC-signed requests) | daily | **shadow** | Skipped and logged until `FESTIVALS_API_KEY` and `FESTIVALS_API_SECRET` are set. Covers every festival code except `demofringe` (test data, only with `FESTIVALS_INCLUDE_DEMOFRINGE=1`). Live `fringe` data needs separate approval from the API owners; a refusal is logged and the other festivals carry on. Licence duties: the attribution line on the detail page, ticket links as the API supplies them, and listings re-checked at least every 24 hours (this runs daily). |
| `foreveredinburgh` | edinburgh.org WordPress REST `/wp-json/wp/v2/event`, then each event's own page | **weekly** | live | Dates come from each event page's structured markup, read by code, never by AI. Pages are re-fetched only when WordPress `modified` is newer than the stored row. Events with a stated range longer than 120 days are skipped as permanent attractions. |

Notes:

- `voodoorooms` runs through `tribe-events.mjs`, a config-driven adapter for The Events Calendar REST API. A new Tribe venue is one config entry.
- `scripts/sources/adapters/venue-rss.mjs` is the generic venue RSS adapter. `VENUE_RSS_FEEDS` holds Sneaky Pete's only. Add a venue by appending a config entry once it publishes a real per-show feed.
- `scripts/sources/adapters/ical.mjs` is a generic iCal adapter with `ICAL_FEEDS` empty, so nothing runs from it yet.

### Not added, and why

Each site below was checked (robots.txt, plus the listing or event page for JSON-LD, a feed or a public API). Nothing here is fetched, and nothing gets past a block. The probe workflow re-checks the blocked ones (see "Re-checking blocked sites" below).

| Site | Why not added |
|---|---|
| 5pm.co.uk | Cloudflare challenge on every client, normal browsers included. Reading it would mean getting past the block. The route is to ask 5pm for a feed or partnership (a to-do). |
| Meetup | Its terms forbid displaying its data in a third-party commercial app. The API needs a paid Pro plan under the same terms. Some Meetup events already reach us through allevents. |
| DICE | UK Terms of Use, clause 6.4, forbids scripts and crawlers. |
| Fatsoma | Its sitemap has been frozen since 2023, and the discover page is an unreliable single-page app. No structured source to read. |
| Royal Botanic Garden | robots.txt disallows `/umbraco/`, the path its events API sits under. |
| Ents24 | Blocked (probed 8 Oct). |
| National Museums (Scotland) | Blocked (probed 8 Oct). |
| National Galleries | Blocked (probed 8 Oct). |
| Edinburgh Reporter | Blocked (probed 8 Oct). |
| Stramash and Whistlebinkies | Both refuse our bot's identity. We don't disguise it. |
| Fever | Mostly paid shows; not worth it. |
| The List | Owns the paid Data Thistle feed; not worth it. |
| The Skinny | Stale; not worth it. |
| EdinburghGuide, EventsList | Not worth it. |
| Fixr | Cloudflare challenge (403 "Just a moment...") on every request. |
| EUSA (Edinburgh University Students' Association) | robots.txt disallows all but a few named bots (Googlebot, bingbot, facebookexternalhit, slurp, baiduspider). |
| Heriot-Watt SU (hwunion.com) | Same Union Cloud platform and robots pattern as EUSA; the listing is also fully client-rendered. |
| Napier SU | robots.txt is permissive, but `/ents/eventlist/` is client-rendered. No JSON-LD, RSS or API in the server HTML. |
| Summerhall | Cloudflare challenge on every request, including `/robots.txt`. |
| The Stand Comedy Club | Client-rendered SPA. No JSON-LD and no per-show links in the server HTML. |
| Usher Hall | Redirects to cultureedinburgh.com, a client-rendered app of about 3.4 MB with no structured data. |
| The Queen's Hall | `/whats-on` JSON-LD is a placeholder (`name: "What's on"`, empty dates). `/rss.xml` has no items. |
| Traverse Theatre | Only venue and business schema on listing and event pages. `/blog/rss` is news, not shows. |
| Leith Theatre | Squarespace site with only generic `LocalBusiness` and `WebSite` JSON-LD. No event feed. |
| Cabaret Voltaire | Only `Organization` and `BreadcrumbList` JSON-LD. Client-rendered listing with no per-show links. |
| Capital Theatres (Festival and King's) | Only business and breadcrumb JSON-LD. `/feed` and `/whats-on/rss` are real RSS, but they carry press and news posts, not shows. |
| Assembly Roxy | SPA returns 200 `text/html` for any guessed path (`/events.ics`, `/events.json`, `/api/events` all serve the same shell). Homepage has no JSON-LD. |
| Edinburgh Filmhouse / Cameo | `filmhousecinema.com` doesn't resolve. `filmhouse.co.uk` redirects to an unrelated business. |

### Re-checking blocked sites

`.github/workflows/probe-sources.yml` (workflow name "Probe event and deal sources") is **manual only**. Run it from the Actions tab with "Run workflow", then read the job summary. It re-checks the blocked list from GitHub's runners, which is the network the pipeline really uses. Earlier probes went out through Delhi (Cloudflare's `cf-ray` codes ended `-DEL`), and several blocks look geographic.

The probe is strict: one identifying bot User-Agent, no retries, robots.txt obeyed, and a 403, 429 or challenge is recorded as it is. For each site it records robots.txt, HTTP status, challenge detection and structured-data counts. Results go to the job summary and to a `probe-sources` artifact (`scraper/out/probe-*.json`). Locally, `node scripts/probe-sources.mjs --only=fatsoma,5pm` runs a subset.

A site that answers cleanly from GitHub's runners, and whose robots.txt allows us in, can join the shadow queue (see "Adding a source" below).

## Descriptions

Every row's `description` goes through `scripts/lib/describe.mjs`'s `cleanDescription()`: HTML entities decoded, tags, URLs and emoji stripped, whitespace collapsed, and boilerplate dropped (ticket-sale calls to action, age and ID legal text, ticket limits, cookie notices, Ticketmaster's promoter company-registration strings, and a candidate that just repeats the event's own name or venue). It is trimmed to about 220 characters on a sentence boundary, or else a word boundary plus "…". Ticketmaster's `description` is almost always empty, so `bestTicketmasterDescription()` tries `info`, `pleaseNote`, `description` and then `promoter.description`, and keeps the first that survives cleaning.

Whatever is still empty or short (under 40 characters) after adapter mapping goes through the **backfill phase** (`backfillDescriptions()`, in dry runs and `--write`, after cross-source merge, before upsert). It fetches the row's own `ticket_url` through the same `politeFetch()` as the page adapters (robots.txt, per-host rate limit, 20s timeout, challenge detection). It then tries the page's JSON-LD `Event.description`, then `og:description`, then `<meta name="description">`. The run is capped at 400 fetches (`MAX_BACKFILL_FETCHES`), shared with the og:image backfill (see "Venues and photos"). Anything still blank gets a last-resort factual line from `fallbackDescription()`, for example "Live music at Sneaky Pete's · doors 19:00 · from £8". It never invents facts; it only uses fields already on the row.

No extra marking is needed for a later run to replace a fallback with a real description. Unlike `image_url`, `description` has no "omit when null" guard in `upsertEvents()`, so every run's upsert overwrites it with whatever this run computed.

### Date-only sources (the "01:00 in BST" bug)

`eventbrite`, `songkick` and `allevents` sometimes give a date-only `startDate` (`"2026-10-09"`, no time). `isoFromJsonLd()` stores that as `T00:00:00+00:00`. That is correct UTC, but it renders as 01:00 in the UI during BST, because nothing tells "genuinely midnight" from "we don't know the time". The backfill phase fixes this when it fetches the event's page anyway: if the row's `starts_at` is the midnight-UTC sentinel (`isMidnightUtcSentinel()`) and the page's own JSON-LD gives a real time for the same Europe/London date, the precise time replaces it (`datesFixed` in the run summary).

That only covers rows this run fetched a page for. The fetch budget is 400 a run, shared with the description and og:image backfill, so some rows keep the sentinel. The **proposed** UI flag is the same test `isMidnightUtcSentinel()` uses: `starts_at` exactly on `T00:00:00.000Z`. Formatting code can then show "date only" and hide the time, with no migration. A proper fix would add a nullable `starts_at_precision` (`'date' | 'time'`) column.

`events.provider` has no `CHECK` constraint, and no app code switches on provider strings for icons or formatting, so new providers need no schema change.

## Window, validation, retirement and health

- **Window.** `LOOKAHEAD_DAYS = 31` (`core/config.mjs`) is used by every adapter. Skiddle and Ticketmaster request exactly that window. Anything starting later is dropped (`beyond_window`).
- **Validation** (`core/validate.mjs`) runs in the orchestrator on every adapter's rows, live or shadow. Hard rejects are counted per source in the run summary and in `event_source_runs.rejected`: `missing_name`, `missing_start`, `bad_url`, `junk_title` (fewer than two letters or digits, "test event", or a title that equals the venue), `online_only`, `past`, `beyond_window`, `end_before_start` and `not_edinburgh`. Soft fixes: HTML entities and whitespace are cleaned from names, and a non-http `image_url` becomes null. A row with no location data passes the Edinburgh check only if its title names an Edinburgh locality.
- **Image check** (`core/images.mjs`). New rows, or rows whose image changed, get a HEAD request (a GET Range fallback, and byte-sniffing when the CDN sends no content type). The timeout is 8s and the cap is 300 checks a run. A broken image becomes null (`image_broken`). Rows over the cap are written unchecked.
- **Lifecycle** (`supabase/add_event_lifecycle.sql`, run by hand first). Each upsert stamps `last_seen_at` and `status`. `status` is `cancelled` for JSON-LD `EventCancelled` or `EventPostponed` and for Ticketmaster `cancelled` or `postponed`. With `--write`, after the upserts, retirement runs. It is soft only: nothing is deleted.
  - `expired`: the end has passed. A row with no `ends_at` uses start plus 2 hours, the same rule as `lib/events/format.ts`.
  - `gone`: an active row not seen for 3 days that starts within the next 25 days. This applies only to providers whose last 3 London days each had a healthy live run (ok, kept more than 0). A failing or empty source never retires its own rows, and weekly sources are never retired by this rule.
  - A row that reappears in its source goes back to `active`. Retired rows stay in the table, so saved events, shared links and the sitemap keep working.
  - A dry run prints what would change. Until the SQL is applied, the steps log a pointer and skip, and upserts fall back to the old columns.
- **Health** (`core/health.mjs`). One `event_source_runs` row per adapter per `--write` run. The "Source health" table (stdout and `$GITHUB_STEP_SUMMARY`) flags `ZERO_TWICE` (kept 0 on this run and the last) and `DROP` (kept under 40% of the 7-day median). The run summary also lists rejection reasons per source.
- **Spot-check** (`scripts/check-event-sample.mjs`). For a random sample of rows it fetches the event's own page and checks that the title words and date appear there, then prints the accuracy:

  ```bash
  node --env-file=.env.local scripts/check-event-sample.mjs --provider=x --n=10 [--source=db|dry-run] [--from-file=dump.json]
  ```

  `--source=db` (the default) samples live active rows. `--source=dry-run` runs `daily-sources.mjs --only=<provider> --dump=...` first. `--from-file` reads rows written by `daily-sources.mjs --dump=path.json`, which includes shadow adapters. Skiddle's event pages answer bots with an empty HTTP 202, so Skiddle rows can't be page-checked.

## Adding a source (shadow, then live)

1. Write `scripts/sources/adapters/<name>.mjs` exporting `{ name, cadence, status: "shadow", run(ctx) }`, and add it to `ADAPTERS` in `scripts/sources/registry.mjs`. A new adapter always starts in `shadow`: it runs and reports, but nothing is upserted.
2. Add the provider to `PROVIDER_PRIORITY` in `scripts/sources/core/dedupe.mjs`, and mirror it in `lib/events/identity.ts` and `lib/happenings/merge-events.ts`. These three must stay in step.
3. Dump the validated rows:

   ```bash
   node --env-file=.env.local scripts/daily-sources.mjs --only=<name> --dump=dump.json
   ```

4. Spot-check the dump. At least 90% must pass before the source goes live:

   ```bash
   node --env-file=.env.local scripts/check-event-sample.mjs --provider=<name> --n=10 --from-file=dump.json
   ```

   Below 90%, fix the adapter and repeat. Don't flip the status.
5. Set `status: "live"` in the adapter, and add the row to the Sources table above. The next `--write` run then shows the source in the health table.

A `gone` rule needs three healthy London days first, so a new source's rows can't be retired until it has that history.

## Venues and photos

Photos come from **free sources only**. No Google photo field and no Place Photos call is ever made. An event shows, in order: its source's own image, the event page's `og:image`, its linked venue's `places.image_url` (resolved at read time), and then a bundled tile for its category.

- **Venue linking** (`core/venues.mjs`, after validation and cross-source dedupe; read-only, so it also runs in dry runs). It loads the curated Edinburgh `places` once per run. The live `source=google` cache is left out, because its photos belong to Google. It sets `events.place_id` with `matchVenueName` from `scripts/lib/place-match.mjs`: an exact name, or a whole-token prefix. If the event and the place both have coordinates, the place must be within 400 m. If the event has none, only a unique name match links. Ambiguous venues stay unlinked and are listed (with 10 samples) in the run summary. `upsertEvents` sends `place_id` only when set, so a failed match never unlinks a row.
- **og:image backfill** (`core/backfill.mjs`). The description backfill already fetches each row's `ticket_url`. The same page now also supplies `og:image` (else the JSON-LD Event `image`, else `twitter:image`) for a row with no photo. The URL is resolved against the page, must be http(s), and generic logos and placeholders are skipped. It then passes the same HEAD check as other images. Candidates are rows missing a description or a photo. The cap is 400 fetches a run, shared with the description backfill. Every fetched row is stamped `enriched_at`, and rows stamped in the last 14 days are skipped, so dead pages aren't re-fetched daily. `enriched_at` needs `supabase/add_event_lifecycle.sql`. Without it the stamp is dropped and nothing is skipped. The summary reports `imageFromPage`.
- **Unknown venues** (`core/google-venues.mjs`). A venue name on 2 or more rows that didn't link goes to Google Places API (New). Text Search uses the field mask `places.id` (IDs Only, free). Place Details uses `id,displayName,formattedAddress,location,googleMapsUri`. `displayName` and `googleMapsUri` are billed at the Pro tier, which has 5,000 free calls a month, so the cap is **40 Google calls per run** (about 20 venues; `--google-max=N` sets it, and 0 turns it off). Venues are tried in order of distinct event names (a tour repeating daily counts once), then row count. A venue Google rejects or can't match is remembered for 30 days in the `source_pages` ledger (`url = google-venue:<normalised name>`, `source_id = google-venue-miss`, written only with `--write`). Skipped when `GOOGLE_PLACES_API_KEY` is not set. A hit is accepted only through `acceptMatch` (name similarity plus distance). It becomes a `places` row with `source = 'event-venue'`, so the matcher links it on later runs without Google. The row gets `country = 'GB'` and `google_fetched_at`, so `scripts/enrich-places-google.mjs`'s 30-day expiry applies. A Google id that already exists in a curated place just links to it, and fills its blank address, location and Maps link. A match on a `source=google` cache row is skipped. **Inserts and patches happen only with `--write`**; a dry run prints what it would do. `event-venue` places are left out of every place list and search (`listPlaces`, `listPlacesByCategory`, `searchPlacesByName`, `listPlacesByCity`, `/api/places/resolve`). They still resolve by id, and deal linking (`EDINBURGH_PLACES_QUERY`) may use them. The monthly `enrich-places-google.mjs --refresh` refreshes them with the narrow mask only (`id,displayName,formattedAddress,location,googleMapsUri`), writing just `google_maps_uri` and `google_fetched_at`. It never writes Enterprise fields.
- **App.** `lib/db/events.ts` embeds the linked venue as `place`. Lists use only its photo. The detail page shows the name, address, website and Maps link. `EventDetail` shows the venue address, "Open in Google Maps" (the venue's `google_maps_uri`, else a Maps search for venue plus address) and the venue's website.

## Running it

```bash
# Dry run (the default): prints per-source counts and sample rows, writes nothing
node --env-file=.env.local scripts/daily-sources.mjs

# Upsert into `events`, then retire and write health rows
node --env-file=.env.local scripts/daily-sources.mjs --write

# Only some adapters (comma-separated)
node --env-file=.env.local scripts/daily-sources.mjs --only=luma,songkick

# Skip some adapters (the same as DAILY_SOURCES_SKIP, comma-separated)
node --env-file=.env.local scripts/daily-sources.mjs --skip=eventbrite

# Include weekly adapters (foreveredinburgh) on a day other than Monday
node --env-file=.env.local scripts/daily-sources.mjs --all-cadences

# Write validated rows, including shadow adapters, to a file for check-event-sample
node --env-file=.env.local scripts/daily-sources.mjs --only=edfestivals --dump=dump.json

# Limit Google venue lookups for a run (0 turns them off)
node --env-file=.env.local scripts/daily-sources.mjs --write --google-max=10
```

`--only` names: `luma`, `eventbrite`, `songkick`, `allevents`, `skiddle`, `ticketmaster`, `sneakypetes`, `voodoorooms`, `edfestivals`, `foreveredinburgh`, `jazzbar`.

Requires `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for `--write`. Dry runs work without them and only print a warning. The optional keys each enable one piece and skip cleanly (a log line, not a failure) when absent: `SKIDDLE_API_KEY` and `TICKETMASTER_API_KEY` (those two adapters), `GOOGLE_PLACES_API_KEY` (the unknown-venue lookup), `DEEPSEEK_API_KEY` (the Jazz Bar fallback), and `FESTIVALS_API_KEY` with `FESTIVALS_API_SECRET` (the Festivals API). The script uses the Supabase REST API directly, not `@supabase/supabase-js`, because that client's Realtime and WebSocket setup crashes under plain Node 20. `scripts/promote-places.mjs` and `scripts/sweep-happenings.mjs` do the same.

## Scheduling

`.github/workflows/daily-sources.yml` runs `--write` in the `Production` environment at two times: 06:17 UTC, and 17:43 UTC as a second pass. GitHub drops scheduled runs under load (the first 06:17 run on 27 Sep never fired), and upserts are idempotent, so the extra run costs nothing. The job has a 35-minute timeout. The Monday part of the 06:17 run also does the weekly sample check (5 random rows per live provider, reported in the job summary, never fails the workflow). Manual runs go through `workflow_dispatch`.

Secrets live as **Production environment** secrets on `jasbir98/fomo`:

- `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_URL`: the project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: the service-role key. **Never** the anon key.
- `SKIDDLE_API_KEY`, `TICKETMASTER_API_KEY`: optional. Each adapter skips when its key is unset.
- `DEEPSEEK_API_KEY`: the Jazz Bar fallback. Optional.
- `GOOGLE_PLACES_API_KEY`: the unknown-venue lookup. Optional.
- `FESTIVALS_API_KEY`, `FESTIVALS_API_SECRET`: the Festivals API. Optional until issued; until then `edfestivals` is skipped.

If Eventbrite ever starts returning HTTP 405 on this workflow's runner (seen from some datacenter IPs, though not on every host), set a `DAILY_SOURCES_SKIP=eventbrite` variable (or edit the workflow's `env:` block). Run `--only=eventbrite` by hand from an unaffected network instead.

## Politeness and safety

These rules apply to every page and feed source: the JSON-LD pages, the Voodoo Rooms and Sneaky Pete's feeds, and the Jazz Bar and Forever Edinburgh WordPress APIs. Skiddle, Ticketmaster and the Festivals API are authenticated API calls, so robots.txt doesn't apply to them. They still run one request at a time under a hard per-run cap.

- `robots.txt` is fetched and evaluated once per hostname per run (cached) before any page on that host is requested. A disallowed URL is skipped (`robots_disallowed`): never fetched, never worked around. It fails **closed**: only a clean 404 means "no rules". Any other error or timeout skips that whole host for the run (`robots_unavailable`).
- A real, identifying `User-Agent`.
- About 1 request per second per hostname, raised further by a host's own `Crawl-delay` if longer.
- A 20s timeout per request.
- Every adapter, and every page fetch inside it, has its own `try`/`catch`. One dead source or page never kills the run.
- A `401`, `403`, `429` or `503`, or a detected bot challenge or interstitial, counts as "this source said no". It is skipped outright and never retried or worked around.
- Rows are never deleted. Upserts add and update rows. Retirement only changes `status`, and a retired row that comes back is set `active` again.

## Known gaps and follow-ups

- Date-only rows that this run didn't fetch a page for keep the `T00:00:00Z` sentinel (see "Date-only sources").
- Category falls back to `other` for rows with no source-specific type, segment or eventcode and no keyword match in `classifyCategory`. Expect a non-trivial `other` share on every run (see the category line in the run summary).
- Cross-source dedupe's 3-hour time bucket can occasionally fail to merge the same real event listed by two sources more than about 3 hours apart. It won't merge two different-city stops of a touring show when a source's venue name is blank. The design favours under-merging over ever collapsing two genuinely different performances into one row.
- Eventbrite's budget is tight (429 at about 35 pages). Its free listing is read first, but a run that hits a block loses the rest of Eventbrite until the next run.
- The Festivals `fringe` code needs separate approval from the API owners. Until it arrives, a refusal is logged and other festivals still import.
