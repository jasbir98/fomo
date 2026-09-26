# Daily Tier-1 events ingest

`scripts/daily-sources.mjs` proactively crawls four free, public Edinburgh
event listing pages once a day and upserts normalized rows into the shared
`events` table — the same table Skiddle/Ticketmaster cache into
(`supabase/add_events.sql`), keyed on `(provider, provider_event_id)`.

## Why

`events` was previously only ever populated as a side-effect of a user's own
request (`lib/events/getForDestination.ts`: cache-first read, live
Skiddle/Ticketmaster fan-out, upsert, 6h TTL) — there was no proactive crawl.
Coverage was bounded by which destinations happened to get queried and by a
small per-request page size, which is most of why only ~97 upcoming rows
existed against a city with thousands of events/month. (That per-request page
size was also raised from 20 to 100 — the actual ceiling both provider APIs
allow — see `lib/events/index.ts`.) This script is the proactive half:
scheduled, source-diverse, and independent of user traffic.

## Sources

All four already embed schema.org `Event` JSON-LD on their public Edinburgh
listing pages — no paid API, no login required:

| Provider     | Page(s)                                                                 | Notes |
|--------------|--------------------------------------------------------------------------|-------|
| `luma`       | https://lu.ma/edinburgh                                                  | ~20 events; tech/startup/networking |
| `eventbrite` | `eventbrite.co.uk/d/united-kingdom--edinburgh/free--events/` (+ page 2, `events--this-weekend/`) | 20/page |
| `songkick`   | https://www.songkick.com/metro-areas/24551-uk-edinburgh                  | Edinburgh metro area is **24551** — 24542 is Birmingham |
| `allevents`  | https://allevents.in/edinburgh/all                                       | Known to leak non-Edinburgh rows onto this page — geo-filtered (within 15km of Edinburgh centre, or a recognized locality name) before anything is kept |

Cross-provider dedupe (same gig listed twice) happens both within this
script (slugified name + calendar day + coarse lat/lng, same heuristic as
`lib/events/dedupe.ts`) and, independently, at feed-read time
(`lib/happenings/merge-events.ts`'s `dedupeProviderEvents`) — so a row this
script writes and a row a live user request writes for the same event just
co-exist as two provider rows until the feed collapses them.

No DB schema change was needed: `events.provider` has no `CHECK` constraint
and no app code switches on specific provider strings for icons/formatting —
every place that mentions "Skiddle/Ticketmaster" in a comment treats
`EventItem.provider` as an opaque, generic value already.

## Running it

```bash
# Dry run (default) — prints per-source counts and 3 sample rows, writes nothing
node --env-file=.env.local scripts/daily-sources.mjs

# Actually upsert into `events`
node --env-file=.env.local scripts/daily-sources.mjs --write

# Only run specific adapters (comma-separated: luma, eventbrite, songkick, allevents)
node --env-file=.env.local scripts/daily-sources.mjs --only=luma,songkick
```

Requires `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to
`--write` (dry runs work without them — they only print a warning). Uses the
Supabase REST API directly, not `@supabase/supabase-js`, since that client's
Realtime/WebSocket init crashes under plain Node 20 (same as
`scripts/promote-japan-places.mjs` / `scripts/sweep-happenings.mjs`).

## Scheduling

`.github/workflows/daily-sources.yml` runs this with `--write` once a day at
06:17 UTC (plus `workflow_dispatch` for manual runs). Required repo secrets
(Settings → Secrets and variables → Actions, on `jasbir98/fomo`):

- `SUPABASE_URL` — the project's Supabase URL (mapped to
  `NEXT_PUBLIC_SUPABASE_URL` in the workflow env)
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key, **never** the anon key

## Politeness / safety

- Real, identifying `User-Agent`.
- ~1 request/second per hostname.
- 20s timeout per request.
- Every adapter, and every individual page fetch within it, is wrapped in
  its own `try`/`catch` — one dead source or page never kills the run.
- A `401`/`403`/`429`/`503` or a detected bot-challenge/interstitial page is
  treated as "this source said no" and skipped outright — never retried,
  never worked around.
- Never deletes anything; only upserts.

## Known gaps / follow-ups

- No `robots.txt` check before fetching (the sibling Python pipeline,
  `scraper/weekly_edinburgh.py`, does check it). Not implemented here for
  time; worth adding if any of these four sources starts pushing back.
- Category assignment is a coarse heuristic off the JSON-LD `@type` (e.g.
  `MusicEvent` → `music`); most rows will fall through to `other` since
  general listing pages rarely use the more specific event subtypes.
- Eventbrite/Songkick pagination is currently fixed (a small, hand-picked
  list of URLs) rather than walking "next page" links — revisit if daily
  volume from those two turns out low.
