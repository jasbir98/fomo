# Roameo — v0 PWA

An installable AI travel-companion PWA (Next.js 16 App Router + TypeScript + Tailwind v4 + Supabase). AI chat, the vision-based translator, and maps/places are **real integrations** (Claude, Mapbox, Google Places) — you'll need API credentials for those (see [Setup](#setup) below). Calendar connection is still **mocked** behind a swappable interface (Google Calendar OAuth is planned but not built).

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript**
- **Tailwind v4** (design tokens live in `app/globals.css` `@theme` — there is no `tailwind.config.ts`)
- **Supabase** (Postgres + `@supabase/supabase-js`), anon key only — **no auth**
- **Per-device data scoping**: a UUID `device_id` in `localStorage` is attached to every domain row
- **PWA**: hand-rolled service worker (`public/sw.js`) + `public/manifest.json` (Turbopack-compatible)

## Prerequisites

- Node 20+ and npm
- A Supabase project (free tier is fine)
- An Anthropic API key (for Roameo chat + the translator)
- A Mapbox access token (for map rendering + geocoding)
- A Google Cloud API key with "Places API (New)" enabled (for live place search)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create the database

In the Supabase dashboard → **SQL Editor**, run the two files in order (details in [`supabase/README.md`](supabase/README.md)):

1. Paste and run [`supabase/schema.sql`](supabase/schema.sql) — creates the 8 tables, RLS policies, and indexes.
2. Paste and run [`supabase/seed.sql`](supabase/seed.sql) — populates the shared read-only `places` and `social_posts` (Tokyo demo data).

> The per-device demo trip ("Tokyo Spring Trip" + its timeline items) is **not** in `seed.sql` — it's seeded automatically for your device the first time you finish onboarding, via `ensureDemoTrip()`.

### 3. Add your credentials

Copy `.env.example` to `.env.local` and fill in all five values:

```bash
cp .env.example .env.local
```

```
# Supabase → Project Settings → API
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR-ANON-KEY

# console.anthropic.com — server-only, powers Roameo chat + the translator
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

All five are required — without `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_MAPBOX_TOKEN`, or `GOOGLE_PLACES_API_KEY` the chat, map, translator, and place-search features will not work. `SKIDDLE_API_KEY` and `TICKETMASTER_API_KEY` are optional — without either, `/api/events` still returns 200 with `degraded: "no-event-keys"` and whatever's already cached, so the app works, just without live events.

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>. For the intended experience, use a **mobile viewport** (the app renders inside a centered `max-w-[480px]` phone column on desktop).

## Walking the flow

Fresh device → `/` redirects into onboarding:

1. **Onboarding** (`/onboarding`) → marketing carousel → `/setup/*`
2. **Setup** — connect calendar (mock) → trip detected → **Travel DNA** (sliders/chips/languages, saved to `travel_preferences`) → **Always Remember** (rules → `roameo_rules`), which seeds the demo trip and lands on Home
3. **Home** (`/`) — trip header, "What's Hot", trending social, 90-minute wins
4. **Discovery** — `/map`, `/place/[id]` (Add to Trip), `/social/[id]`, `/90-minute-wins`
5. **Plan** (`/plan`) — Timeline ⇄ Calendar; the rain-flagged Arashiyama item → `/plan/disruption/[id]` (swap in a covered alternative); add/edit items
6. **Roameo** (`/roameo`) — real Claude-powered chat (mode chips, rich cards, action proposals that add itinerary items) + `/roameo/translator` (real Claude-vision EN⇄JP)
7. **Profile** (`/profile`) — persisted Travel DNA + Rules (Edit/Manage deep-link back into setup in edit mode), saved trips

Confirm writes land in the Supabase **Table Editor** as you go.

## Real integrations vs. remaining mocks

| Surface | File | Status |
|---|---|---|
| Roameo chat | `app/api/chat/route.ts`, `lib/ai/anthropic.ts` | **Real** — Claude, server-only `ANTHROPIC_API_KEY` |
| Translator | `app/api/translate/route.ts`, `lib/ai/anthropic.ts` | **Real** — Claude vision, same `ANTHROPIC_API_KEY` |
| Map + geocoding | `app/(shell)/map/page.tsx`, `lib/places/geocode.ts` | **Real** — Mapbox GL, `NEXT_PUBLIC_MAPBOX_TOKEN` |
| Place search | `lib/places/google.ts`, `app/api/places/route.ts` | **Real** — Google Places API (New), server-only `GOOGLE_PLACES_API_KEY` |
| Events ("What's On Nearby") | `lib/events/`, `app/api/events/route.ts` | **Real** — Skiddle (UK-only) + Ticketmaster Discovery v2 (global), server-only `SKIDDLE_API_KEY` / `TICKETMASTER_API_KEY`, both optional |
| Disruption suggestions | `lib/disruption.ts` | **Mocked** — hardcoded covered-alternative pairs (weather-alert flag is manual, not forecast-driven) |
| Calendar | UI-only, `app/setup/connect-calendar/page.tsx` | **Mocked** — provider "connect" is visual only; no OAuth |

`lib/roameo-ai.ts` and `lib/translator-data.ts` are leftover pre-integration scripted fallbacks, fully superseded by the routes above.

### Events

`/api/events` fans out to **Skiddle** (UK-only, free key) and **Ticketmaster Discovery v2** (global, free key, 5 req/s / 5000-req/day limit), caches results into the `events` table (6h TTL), and dedupes cross-provider duplicates before returning. Two sources were investigated and deliberately excluded: **Eventbrite** has no public venue-search endpoint (its only working geo route is an undocumented, session-gated internal API — not suitable for a route handler; deferred to a possible future scraper pipeline) and **Meetup**'s REST API was retired in Feb 2025, with its GraphQL replacement requiring an OAuth consumer only paid Meetup Pro accounts can create. See `supabase/README.md`'s Events section for the full writeup.

## Project layout

```
app/
  (shell)/        # routes with the bottom nav (home, map, plan, roameo, profile, place, social, 90-minute-wins)
  onboarding/     # full-screen, no nav
  setup/          # full-screen, no nav
  plan/add|item|disruption/   # full-screen task routes
  roameo/translator/          # full-screen
components/ui/    # design-system primitives (Button, Chip, Card, Input, Slider, BottomSheet, …)
components/shell/ # BottomNav + AppShell
lib/              # supabase client, device id, ai/ (Claude), places/ (Mapbox+Google), disruption mock
lib/db/           # typed, device-scoped CRUD (one module per table)
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

Import the repo in Vercel, set all five environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `NEXT_PUBLIC_MAPBOX_TOKEN`, `GOOGLE_PLACES_API_KEY`), and deploy. Run `supabase/schema.sql` + `seed.sql` against your project first. Not deployed by default.

## Notes & limitations (v0)

- **No auth.** Data is scoped per-device by convention; RLS is enabled with a permissive policy. Harden RLS before any multi-user use.
- Clearing browser storage (or Profile → "Reset app data") issues a new `device_id`, giving you a fresh slate.
- AI chat, translation, map rendering, and place search are real integrations and require the credentials listed in [Prerequisites](#prerequisites)/[Setup](#setup) — the app will not work correctly without them. Only calendar connection remains mocked/UI-only (no external credentials needed for that one).
