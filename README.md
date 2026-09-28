# Fomo — Edinburgh deals & events PWA

An installable PWA for finding deals and events in Edinburgh (Next.js 16 App Router + TypeScript + Tailwind v4 + Supabase). Real integrations: AI chat (Claude), event sources (Skiddle, Ticketmaster), and weekly deal research. You'll need API credentials for those (see [Setup](#setup) below).

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript**
- **Tailwind v4** (design tokens live in `app/globals.css` `@theme` — there is no `tailwind.config.ts`)
- **Supabase** (Postgres + `@supabase/supabase-js`), anon key only — **no auth**
- **Per-device data scoping**: a UUID `device_id` in `localStorage` is attached to every domain row
- **PWA**: hand-rolled service worker (`public/sw.js`) + `public/manifest.json` (Turbopack-compatible)

## Prerequisites

- Node 20+ and npm
- A Supabase project (free tier is fine)
- An Anthropic API key (for Fomo chat)
- A Mapbox access token (for place geocoding and map display)
- A Google Cloud API key with "Places API (New)" enabled (for place search)
- Skiddle and Ticketmaster API keys (optional, for event listings)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database

In the Supabase dashboard → **SQL Editor**, run the files in order (details in [`supabase/README.md`](supabase/README.md)):

1. Paste and run [`supabase/schema.sql`](supabase/schema.sql) — creates tables, RLS policies, and indexes.
2. Paste and run [`supabase/seed.sql`](supabase/seed.sql) — populates read-only `places` and `social_posts` with Edinburgh data.

### 3. Add your credentials

Copy `.env.example` to `.env.local` and fill in all five values:

```bash
cp .env.example .env.local
```

```
# Supabase → Project Settings → API
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR-ANON-KEY

# console.anthropic.com — server-only, powers Fomo chat + the translator
ANTHROPIC_API_KEY=YOUR-ANTHROPIC-KEY

# account.mapbox.com/access-tokens — public, powers map rendering + geocoding
NEXT_PUBLIC_MAPBOX_TOKEN=YOUR-MAPBOX-TOKEN

# Google Cloud Console, "Places API (New)" enabled — server-only, powers live place search
GOOGLE_PLACES_API_KEY=YOUR-GOOGLE-PLACES-KEY

# skiddle.com/api — free key, server-only, powers UK-only event search (Skiddle has no international coverage)
SKIDDLE_API_KEY=YOUR-SKIDDLE-KEY

# developer.ticketmaster.com — free key, server-only, powers global event search
TICKETMASTER_API_KEY=YOUR-TICKETMASTER-KEY
```

The first five are required for core functionality. `SKIDDLE_API_KEY` and `TICKETMASTER_API_KEY` are optional — without them, the app works but event search is degraded. Without `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_MAPBOX_TOKEN`, or `GOOGLE_PLACES_API_KEY`, chat, place search, and mapping features will not work.

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>. For the intended experience, use a **mobile viewport** (the app renders inside a centered `max-w-[480px]` phone column on desktop).

## Walking the flow

Fresh device → `/` shows the Home page with today's deals, upcoming events, and recent recommendations.

Main screens:
- **Home** (`/`) — Fomo hero card, "This Weekend" events, trending places/deals
- **Explore** (`/explore`) — filtered search over places and deals by name, tag, and map
- **Ask Fomo** (`/ask`) — Claude-powered chat for deal and event recommendations
- **Saved** (`/saved`) — user-saved places and deals (stored in device-scoped `saved` table)
- **Weekend** (`/weekend`) — upcoming events and deals from Friday to Sunday

## Real integrations

| Feature | Files | Status |
|---|---|---|
| Chat | `app/api/chat/route.ts`, `lib/ai/anthropic.ts` | **Real** — Claude, server-only `ANTHROPIC_API_KEY` |
| Events | `lib/events/`, `app/api/events/route.ts` | **Real** — Skiddle (UK-only) + Ticketmaster Discovery v2, optional API keys |
| Places | `lib/places/google.ts`, `app/api/places/route.ts` | **Real** — Google Places API (New), server-only `GOOGLE_PLACES_API_KEY` |
| Geocoding | `lib/places/geocode.ts` | **Real** — Mapbox, `NEXT_PUBLIC_MAPBOX_TOKEN` |
| Weekly deals | `scraper/weekly_edinburgh.py`, `scripts/daily-sources.mjs` | **Real** — weekly scrape + daily Skiddle/Ticketmaster ingest |

### Events

`/api/events` pulls from **Skiddle** (UK-only) and **Ticketmaster Discovery v2** (global), caches into the `events` table (6h TTL), and dedupes cross-provider duplicates. `scripts/daily-sources.mjs` also runs nightly to proactively crawl public event listing pages (Luma, Eventbrite, Songkick, AllEvents, Sneaky Pete's) and sync results into `events`. See `docs/daily-sources.md` for details.

## Project layout

```
app/
  (shell)/        # routes with bottom nav (home, explore, ask, saved, weekend)
  api/            # chat, events, places, feed, saved endpoints
components/ui/    # design-system primitives (Button, Chip, Card, Input, BottomSheet, …)
components/shell/ # BottomNav + AppShell
lib/              # supabase client, device id, ai/ (Claude), places, events, happenings
lib/db/           # typed, device-scoped CRUD (one module per table)
scraper/          # Python scripts: weekly Edinburgh deals, city discovery
scripts/          # Node scripts: daily event ingest, place promotion, happenings
supabase/         # schema.sql, seed.sql, README
public/           # manifest.json, sw.js, icons
```

## Scripts

```bash
npm run dev     # dev server (Turbopack)
npm run build   # production build
npm run start   # serve the production build
npx eslint .    # lint (0 problems expected)
```

## Deploy (Vercel-ready, optional)

Import the repo in Vercel, set the environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_MAPBOX_TOKEN`, `GOOGLE_PLACES_API_KEY`, and optional event API keys), and deploy. Run `supabase/schema.sql` + `seed.sql` against your project first.

## Notes & limitations (v0)

- **No auth.** Data is scoped per-device by convention; RLS is enabled with a permissive policy. Harden RLS before any multi-user use.
- Clearing browser storage issues a new `device_id`, giving you a fresh slate.
- Chat, event search, place discovery, and geocoding require the API credentials listed in [Prerequisites](#prerequisites). The app will not work correctly without them.
