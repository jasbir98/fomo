# Daily Tier-1 events ingest

`scripts/daily-sources.mjs` proactively crawls four free, public Edinburgh
event listing pages and pulls two provider APIs (Skiddle, Ticketmaster) once
a day, and upserts normalized rows into the shared `events` table — the same
table Skiddle/Ticketmaster cache into (`supabase/archive/add_events.sql`), keyed on
`(provider, provider_event_id)`.

## Why

`events` was previously only ever populated as a side-effect of a user's own
request (`lib/events/getForDestination.ts`: cache-first read, live
Skiddle/Ticketmaster fan-out, upsert, 6h TTL) — there was no proactive crawl.
Coverage was bounded by which destinations happened to get queried and by a
small per-request page size, which is most of why only ~97 upcoming rows
existed against a city with thousands of events/month. (That per-request page
size was also raised from 20 to 100 — the actual ceiling both provider APIs
allow — see `lib/events/index.ts`.) This script is the proactive half:
scheduled, source-diverse, and independent of user traffic — the same
Skiddle/Ticketmaster field mapping as `lib/events/`, but paginated over a
60-day window instead of one capped live-request page.

## Sources

| Provider       | Page(s) / API                                                            | Notes |
|----------------|----------------------------------------------------------------------------|-------|
| `luma`         | https://lu.ma/edinburgh                                                  | ~20 events; tech/startup/networking; schema.org JSON-LD, no auth |
| `eventbrite`   | `eventbrite.co.uk/d/united-kingdom--edinburgh/free--events/` (+ page 2, `events--this-weekend/`) | 20/page; schema.org JSON-LD, no auth |
| `songkick`     | https://www.songkick.com/metro-areas/24551-uk-edinburgh                  | Edinburgh metro area is **24551** — 24542 is Birmingham; JSON-LD, no auth |
| `allevents`    | https://allevents.in/edinburgh/all                                       | Known to leak non-Edinburgh rows onto this page — geo-filtered (within 15km of Edinburgh centre, or a recognized locality name) before anything is kept; JSON-LD, no auth |
| `skiddle`      | Skiddle Events API `/events/search/`, 10mi radius, 60-day lookahead, paginated | Requires `SKIDDLE_API_KEY`; skipped (logged, not a failure) when absent |
| `ticketmaster` | Ticketmaster Discovery v2 `/events.json`, ~16km radius, 60-day lookahead, paginated | Requires `TICKETMASTER_API_KEY`; skipped (logged, not a failure) when absent |
| `sneakypetes`  | https://sneakypetes.co.uk/feed                                           | Venue RSS feed (WordPress) — one `<item>` per upcoming gig, `<pubDate>` is the actual show date/time, no auth. First of a generic "venue RSS feed" adapter (`VENUE_RSS_FEEDS`, `adapterVenueRssFeed`) — add more venues by appending to that config array once they're confirmed to publish a real per-show feed |

### Student ticketing sites and venue feeds researched but not added

The following were checked (robots.txt + listing/event page inspected for JSON-LD, an ICS/RSS feed, or a public JSON API) and rejected — each blocks scripted access or exposes no structured per-event data to parse without a login or headless browser:

| Candidate | Reason rejected |
| --- | --- |
| Fixr | Cloudflare challenge (403 "Just a moment...") on every request |
| Edinburgh University Students' Association (EUSA) | `robots.txt` disallows all but a few named bots (Googlebot, bingbot, facebookexternalhit, slurp, baiduspider) |
| Heriot-Watt SU (hwunion.com) | Same Union Cloud platform/robots pattern as EUSA; listing page is also fully client-rendered |
| Napier SU | robots.txt is permissive, but `/ents/eventlist/` is a client-rendered SPA — zero JSON-LD/RSS/API in the server-sent HTML |
| Summerhall | Cloudflare challenge on every request, including `/robots.txt` itself |
| The Stand Comedy Club | Client-rendered SPA, no JSON-LD, no per-show links in server HTML |
| Usher Hall | Redirects to cultureedinburgh.com, a ~3.4MB client-rendered app with zero structured data |
| The Queen's Hall | `/whats-on` JSON-LD is a placeholder stub (`name: "What's on"`, empty dates); `/rss.xml` exists but has 0 `<item>`s |
| Traverse Theatre | Only venue/business schema (`EntertainmentBusiness`/`TouristAttraction`) on listing and event pages; `/blog/rss` is a news blog, not shows |
| Leith Theatre | Squarespace site; only generic `LocalBusiness`/`WebSite` JSON-LD, no event feed |
| Cabaret Voltaire | Only `Organization`/`BreadcrumbList` JSON-LD; client-rendered listing, no per-show links |
| Capital Theatres (Festival/King's) | Only business/breadcrumb JSON-LD; `/feed` and `/whats-on/rss` are real RSS but contain press/news posts, not shows |
| Assembly Roxy | SPA returns 200 `text/html` for any guessed path (false-positive "hits" for `/events.ics`, `/events.json`, `/api/events`, etc. all serve the same client shell); homepage has 0 JSON-LD |
| Edinburgh Filmhouse / Cameo | `filmhousecinema.com` doesn't resolve; `filmhouse.co.uk` redirects to an unrelated business |

Every row from any of the seven sources also gets:

- An **off-wedge filter** (`isOffWedge`): drops rows that read as a
  multi-day excursion/package rather than a single tonight/this-weekend
  outing — an explicit "leaves Edinburgh" keyword (day trips, Highlands/isle
  tours, NC500, etc.), or a >2-day span priced over £60.
- A **category fallback** (`classifyCategory`): a source's own specific
  signal (JSON-LD `@type`, Skiddle `eventcode`, Ticketmaster
  `classifications[].segment.name`) always wins when present; rows that
  still fall through to `other` get a second pass via a keyword classifier
  over name/venue/description, mapped only onto `lib/events/categories.ts`'s
  real `EventCategory` slugs.

Cross-provider dedupe (same gig listed twice) happens both within this
script — normalized title (accents/case/punctuation/venue-suffix folded) +
Europe/London calendar date + a coarse 3-hour time bucket + coarse venue name
(`crossSourceKey`/`dedupeAcrossSources`; picks the "better" candidate by
price info present, then image present, then provider priority, then
ticket-url present) — and, independently, at feed-read time
(`lib/happenings/merge-events.ts`'s `dedupeProviderEvents`) — so a row this
script writes and a row a live user request writes for the same event just
co-exist as two provider rows until the feed collapses them.

## Descriptions

Every row's `description` goes through `scripts/lib/describe.mjs`'s
`cleanDescription()`: HTML entities decoded, tags/URLs/emoji stripped,
whitespace collapsed, boilerplate dropped (ticket-sale CTAs, age/ID and
ticket-limit legal text, cookie notices, Ticketmaster's `promoter.description`
company-registration strings, a candidate that just repeats the event's own
name/venue), trimmed to ~220 chars on a sentence boundary (else a word
boundary + "…"). Ticketmaster's `description` field is essentially always
empty on live rows — `bestTicketmasterDescription()` instead tries `info`,
`pleaseNote`, `description`, then `promoter.description` in that order and
keeps whatever survives cleaning first (`info` usually has the useful
doors/start/curfew line before its own legal boilerplate).

Whatever's still empty/short (<40 chars) after adapter mapping goes through a
**backfill phase** (`backfillDescriptions()`, runs in both dry-run and
`--write`, after cross-source merge, before upsert): fetch the row's own
`ticket_url` through the same `politeFetch()` as the JSON-LD adapters
(robots.txt, per-host rate limit, 20s timeout, challenge detection), and try
the page's own JSON-LD `Event.description`, then `og:description`, then
`<meta name="description">` — capped at 400 fetches/run
(`MAX_BACKFILL_FETCHES`; the same fetch also yields a photo, see "Venues and photos"). Anything still blank after that gets a last-resort
factual one-liner from `fallbackDescription()` (category + venue + doors time
+ price, e.g. "Live music at Sneaky Pete's · doors 19:00 · from £8") — never
invented facts, only fields already on the row. No extra marking is needed
to let a later run replace a fallback with a real description once one
becomes available: unlike `image_url`, `description` has no "omit when
null" clobber guard in `upsertEvents()`, so every run's upsert always
overwrites it with whatever this run computed.

### Date-only sources (the "01:00 in BST" bug)

`eventbrite`, `songkick` and `allevents` (JSON-LD sources) sometimes give a
date-only `startDate` (`"2026-10-09"`, no time) — verified live against all
three. `isoFromJsonLd()` stores that as `T00:00:00+00:00`, which is correct
UTC but renders as 01:00 in the UI during BST since nothing distinguishes
"genuinely midnight" from "we don't know the time". The backfill phase
opportunistically fixes this for free when it fetches the event's own page
for a description anyway: if the row's `starts_at` looks like that midnight-UTC
sentinel (`isMidnightUtcSentinel()`) and the fetched page's own JSON-LD gives
a `startDate` with a real time component for the same Europe/London calendar
date, the precise time replaces it (`datesFixed` in the run summary). This
doesn't cover every date-only row — only ones this run happened to fetch a
page for (capped at 150/run, shared with the description backfill) and whose
own event page states a time the listing page didn't.

For whatever's left with no real time: no DB schema change was made (per the
existing no-schema-change stance below). The **proposed** flag, for whoever
owns the UI, is the same heuristic `isMidnightUtcSentinel()` already uses —
`starts_at` landing exactly on `T00:00:00.000Z` — since a real UK event
starting at the literal top of the UTC hour is vanishingly unlikely.
Formatting code can special-case that as "date only, hide the time" without a
migration; a future proper fix would add a nullable `starts_at_precision`
(`'date' | 'time'`) column set by whichever ingest path derived the value.

No DB schema change was needed: `events.provider` has no `CHECK` constraint
and no app code switches on specific provider strings for icons/formatting —
every place that mentions "Skiddle/Ticketmaster" in a comment treats
`EventItem.provider` as an opaque, generic value already.

## Window, validation, retirement and health

- **Window.** `LOOKAHEAD_DAYS = 31` (`core/config.mjs`). Skiddle and Ticketmaster request exactly that; anything starting later is dropped (`beyond_window`).
- **Validation** (`core/validate.mjs`, applied in the orchestrator to every adapter, live or shadow). Hard rejects, counted per source in the run summary and in `event_source_runs.rejected`: `missing_name`, `missing_start`, `bad_url`, `junk_title` (fewer than 2 letters/digits, "test event", title equals venue), `online_only`, `past`, `beyond_window`, `end_before_start`, `not_edinburgh`. Soft fixes: HTML entities and whitespace in names, a non-http `image_url` becomes null. A row with no location data at all passes `not_edinburgh` only if its title names an Edinburgh locality.
- **Image check** (`core/images.mjs`). New rows (or rows whose image changed) get a HEAD request (GET Range fallback, byte-sniffing when the CDN sends no content-type): 8s timeout, 300 checks per run. A broken image becomes null (`image_broken`). Rows over the cap are written unchecked.
- **Lifecycle** (`supabase/add_event_lifecycle.sql`, run by hand first). Each upsert stamps `last_seen_at` and `status` (`cancelled` for JSON-LD `EventCancelled`/`EventPostponed` and Ticketmaster `cancelled`/`postponed`). With `--write`, after the upserts: rows past their end go `expired` (no `ends_at`: start plus 2h, as in `lib/events/format.ts`); active rows unseen for 3 days and starting within 25 days go `gone`, but only for providers with a healthy live run (ok, kept>0) on each of the last 3 London days, so a failing source never retires its rows and weekly sources are never retired. Nothing is deleted; a row that reappears goes back to `active`. A dry run prints what it would change. Until the SQL is applied the steps log a pointer and skip, and upserts fall back to the old columns.
- **Health.** One `event_source_runs` row per adapter per `--write` run. The "Source health" table (stdout and `$GITHUB_STEP_SUMMARY`) flags `ZERO_TWICE` (kept 0 on this and the previous run) and `DROP` (below 40% of the 7-day median).
- **Spot-check.** `node --env-file=.env.local scripts/check-event-sample.mjs --provider=x --n=10 [--source=db|dry-run] [--from-file=dump.json]` fetches each sampled event's own page and checks the title words and date. 90% to go live. `daily-sources.mjs --dump=path.json` writes the validated rows (including shadow adapters) for `--from-file`. A weekly CI job runs it for every live provider. Skiddle's event pages answer bots with an empty HTTP 202, so Skiddle rows can't be page-checked.

## Venues and photos

Photos come from **free sources only**: no Google photo field and no Place Photos call is ever made. An event shows, in order: its source's own image, the event page's `og:image`, its linked venue's `places.image_url` (resolved at read time), then a bundled tile for its category.

- **Venue linking** (`core/venues.mjs`, after validation and cross-source dedupe; read-only, so it runs in dry runs too). Loads the curated Edinburgh `places` once per run (the live `source=google` cache is left out because its photos are Google's) and sets `events.place_id` with `matchVenueName` from `scripts/lib/place-match.mjs`: exact name, or a whole-token prefix. If both the event and the place have coordinates the place must be within 400 m; if the event has none, only a unique name match links. Ambiguous venues stay unlinked and are listed (with 10 samples) in the run summary. `upsertEvents` sends `place_id` only when set, so a later failed match never unlinks a row.
- **og:image backfill** (`core/backfill.mjs`). The description backfill already fetches each row's `ticket_url`; the same page now also supplies `og:image` (else the JSON-LD Event `image`, else `twitter:image`) for a row with no photo. The URL is resolved against the page, must be http(s), generic logos/placeholders are skipped, and it passes the same HEAD check as other images. Candidates are rows missing a description or a photo (a row whose stored copy already has a photo is skipped); the cap is 400 fetches a run. Every row fetched is stamped `enriched_at`, and rows stamped in the last 14 days are skipped, so dead pages are not re-fetched daily. `enriched_at` needs `supabase/add_event_lifecycle.sql`; without it the stamp is dropped and nothing is skipped. The summary reports `imageFromPage`.
- **Unknown venues** (`core/google-venues.mjs`). A venue name on 2 or more rows that did not link goes to Google Places API (New): Text Search with field mask `places.id` (IDs Only SKU, free), then Place Details with `id,displayName,formattedAddress,location,googleMapsUri`. `displayName` and `googleMapsUri` are billed at the Pro tier (5,000 free calls a month), so the cap is **40 Google calls per run**, about 20 venues (`--google-max=N`, 0 disables). Venues are tried in order of distinct event names (a tour repeating daily counts once), then row count. A venue Google rejected or couldn't match is remembered for 30 days in the `source_pages` ledger (`url = google-venue:<normalised name>`, `source_id = google-venue-miss`; written only with `--write`; no table means no cache). Skipped when `GOOGLE_PLACES_API_KEY` is not set. A hit is accepted only through `acceptMatch` (name similarity plus distance). It becomes a `places` row with `source = 'event-venue'` (so the matcher links it on later runs without Google), the event's own venue name, `country = 'GB'`, and `google_fetched_at` set so `scripts/enrich-places-google.mjs`'s 30-day expiry applies. A Google id that already exists in a curated place just links to it and fills its blank address/location/Maps link; a match on a `source=google` cache row is skipped. **Inserts and patches happen only with `--write`**; a dry run prints what it would do. `event-venue` places are left out of every place list and search (`listPlaces`, `listPlacesByCategory`, `searchPlacesByName`, `listPlacesByCity`, and `/api/places/resolve`); they still resolve by id, and deal linking (`EDINBURGH_PLACES_QUERY`) may use them. The monthly `enrich-places-google.mjs --refresh` refreshes them with the narrow mask only (`id,displayName,formattedAddress,location,googleMapsUri`) and writes just `google_maps_uri` and `google_fetched_at`, never Enterprise fields; the 30-day expiry-clear covers them like any other place.
- **App.** `lib/db/events.ts` embeds the linked venue as `place` (photo only in lists; name, address, website and Maps link on the detail page). `EventDetail` shows the venue address, "Open in Google Maps" (the venue's `google_maps_uri`, else a Maps search for venue plus address) and the venue's website.

## Running it

```bash
# Dry run (default) — prints per-source counts and 3 sample rows, writes nothing
node --env-file=.env.local scripts/daily-sources.mjs

# Actually upsert into `events`
node --env-file=.env.local scripts/daily-sources.mjs --write

# Only run specific adapters (comma-separated: luma, eventbrite, songkick, allevents, skiddle, ticketmaster)
node --env-file=.env.local scripts/daily-sources.mjs --only=luma,songkick

# Skip specific adapters (same as the DAILY_SOURCES_SKIP env var, comma-separated)
node --env-file=.env.local scripts/daily-sources.mjs --skip=eventbrite
```

Requires `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to
`--write` (dry runs work without them — they only print a warning). Optional
`SKIDDLE_API_KEY` / `TICKETMASTER_API_KEY` enable those two adapters, and `GOOGLE_PLACES_API_KEY` enables the unknown-venue lookup; each
skips cleanly (a log line, not a failure) when its key is absent. Uses the
Supabase REST API directly, not `@supabase/supabase-js`, since that client's
Realtime/WebSocket init crashes under plain Node 20 (same as
`scripts/promote-places.mjs` / `scripts/sweep-happenings.mjs`).

## Scheduling

`.github/workflows/daily-sources.yml` runs this with `--write` once a day at
06:17 UTC (plus `workflow_dispatch` for manual runs). Required/optional repo
secrets (Settings → Secrets and variables → Actions, on `jasbir98/fomo`):

- `SUPABASE_URL` — the project's Supabase URL (mapped to
  `NEXT_PUBLIC_SUPABASE_URL` in the workflow env)
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key, **never** the anon key
- `SKIDDLE_API_KEY` / `TICKETMASTER_API_KEY` — optional; the workflow passes
  these through, and the script skips the corresponding adapter gracefully
  when either is unset

If Eventbrite ever starts returning HTTP 405 on this workflow's runner (seen
happening from some datacenter IPs, though not reproduced on every host),
set a `DAILY_SOURCES_SKIP=eventbrite` repo/environment variable (or edit the
workflow's `env:` block) and run `--only=eventbrite` by hand from an
unaffected network instead.

## Politeness / safety

Applies to the four JSON-LD (HTML-scraped) sources — Skiddle/Ticketmaster
are authenticated API calls, not page scrapes, so robots.txt doesn't apply
to them, though they're still fetched one page at a time with a hard
per-run page cap (never an unbounded pagination loop).

- `robots.txt` is fetched and evaluated once per hostname per run (cached)
  before any page on that host is requested, and a disallowed URL is
  skipped ("robots_disallowed") — never fetched, never worked around. Fails
  **closed**: only a clean 404 means "no rules"; any other error/timeout
  skips that whole host for the run ("robots_unavailable").
- Real, identifying `User-Agent`.
- ~1 request/second per hostname (raised further by a host's own
  `Crawl-delay`, if longer).
- 20s timeout per request.
- Every adapter, and every individual page fetch within it, is wrapped in
  its own `try`/`catch` — one dead source or page never kills the run.
- A `401`/`403`/`429`/`503` or a detected bot-challenge/interstitial page is
  treated as "this source said no" and skipped outright — never retried,
  never worked around.
- Never deletes anything; only upserts.

## Known gaps / follow-ups

- Date-only source rows this run didn't happen to fetch a page for (backfill
  is capped at 150 fetches/run, shared between description-backfill and the
  date fix) keep the `T00:00:00Z` midnight-UTC sentinel — see "Date-only
  sources" above for the proposed UI-side flag.
- The description backfill fetches each qualifying row's `ticket_url` once
  per run, every run — there's no "already tried, skip next time" cache, so
  a genuinely description-less page (e.g. a bare listing with no per-event
  page content) gets re-fetched and re-fails daily rather than being marked
  permanently unknown. Low cost at current volume (≤150 fetches/run,
  well under the per-host politeness budget) but worth a small cache if
  volume grows.

- Category assignment still falls back to `other` for rows with no
  source-specific type/segment/eventcode signal *and* no keyword match in
  `classifyCategory`'s rule list — expect a non-trivial `other` share on
  every run (see the category-distribution line in the run summary).
- Eventbrite/Songkick pagination is currently fixed (a small, hand-picked
  list of URLs) rather than walking "next page" links — revisit if daily
  volume from those two turns out low.
- Cross-source dedupe's 3-hour time bucket can occasionally fail to merge
  the same real event across two sources that report times more than ~3h
  apart (rare), and will not merge two different-city stops of a touring
  show if a source's venue name is entirely blank — favoring occasional
  under-merging over ever wrongly collapsing two genuinely different
  performances into one row.

