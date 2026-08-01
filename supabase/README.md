# Supabase Setup

Follow these exact steps to set up Roameo's database.

## 1. Open Supabase SQL Editor

Navigate to your Supabase project dashboard and go to **SQL Editor**.

## 2. Run the migrations, in order

This is the full list of `.sql` files in `supabase/`, in the order they must be run. Use this as a checklist both for a **fresh project** (run every row) and for **auditing an existing project** (check off what's already been applied by looking for the tables/columns each one adds).

Copy each file's entire contents into a new SQL Editor query and click **Run**, one file at a time, in this order:

| # | File | What it does |
|---|------|---------------|
| 1 | `schema.sql` | Base v0 schema. Creates `profiles`, `travel_preferences`, `roameo_rules`, `trips`, `itinerary_items`, `chat_messages`, `places`, `social_posts` with RLS enabled and permissive device-scoped (`anon_all`) policies; `places`/`social_posts` are anon-`select`-only. |
| 2 | `seed.sql` | Seeds `places` with 8 Tokyo attractions and `social_posts` with 3 sample posts (@tokyo_vibes, @sakura_adventures, @japan_wanderer). Idempotent via `ON CONFLICT DO NOTHING`. |
| 3 | `fix_profile_fk.sql` | **Conditional, one-time.** Only needed if you ran an old copy of `schema.sql` (pre-2026-07-13) that added FKs from `*_device_id` columns to `profiles(device_id)`. Since nothing in the app ever creates a `profiles` row, those FKs made every write fail with `23503`. Drops the stale constraints. Skip entirely on a fresh project. |
| 4 | `fix_broken_images.sql` | **Conditional, one-time.** Only needed if you ran an old copy of `seed.sql` (pre-2026-07-13) whose Hedgehog Cafe / Mega Don Quijote / `@japan_wanderer` avatar Unsplash URLs have since 404'd. Patches those 3 rows in place. Skip entirely on a fresh project (current `seed.sql` already has the fixed URLs). |
| 5 | `add_places_columns.sql` | Roameo v1 Phase 2 (Maps). Adds Google Places (New) cache columns to `places` (`google_place_id`, `lat`, `lng`, `address`, `price_level`, `destination`, `source`, `fetched_at`), a unique index on `google_place_id` (for upsert `on_conflict`), and an `anon_write` policy so the `/api/places` route can cache live results. |
| 6 | `add_social_video_columns.sql` | Roameo v1 Phase 4b (Social Reels). Adds `platform`, `video_url`, `thumbnail_url`, `destination`, `place_id` to `social_posts`, a unique index on `video_url` (for the scraper's upsert), and widens the RLS policy to `anon_all` so the offline Playwright scraper can write. Needed before the reels scraper can push rows. |
| 7 | `add_japan_places_pipeline.sql` | Japan places pipeline, part 1. Adds `city`, `prefecture`, `country`, `description`, `last_verified_at`, `hours_status` to `places`, plus a name+destination dedupe index. Creates the staging/provenance tables: `place_photos`, `place_sources`, `places_staging` (the `extraction_status` review workflow: pending → extracted → validated → approved/rejected → promoted). Run after `schema.sql` and `add_places_columns.sql`. |
| 8 | `add_japan_tokyo_pipeline.sql` | Japan places pipeline, part 2 (Tokyo extension). Adds multi-photo `photos` jsonb staging column to `places_staging`; adds richer provenance columns to `place_photos` plus a `(place_id, url)` dedupe index; creates `city_foods` and `city_foods_staging` (per-city famous-dish metadata, same approve/promote workflow). Run after `add_japan_places_pipeline.sql`. |
| 9 | `seed_japan_pilot.sql` | Loads 19 Kanto-region places (batch_id `jp-kanto-pilot-2026-07-14`) into `places_staging` only — **not** into live `places`. Re-runnable via `on conflict (batch_id, dedupe_key)` update. |
| 10 | `seed_japan_tokyo.sql` | Loads 54 Tokyo-core places + 3 city foods (batch_id `jp-tokyo-2026-07-15`) into `places_staging` and `city_foods_staging` only — **not** into live tables. Re-runnable the same way. |
| 11 | `promote_japan_tokyo.sql` | Promotes **only** the `jp-tokyo-2026-07-15` batch from staging into production: `places`, `place_photos`, `place_sources`, `city_foods`. Matches/dedupes on `(country, prefecture, city, lower(name))` so re-runs don't duplicate rows; marks promoted staging rows `extraction_status = 'promoted'`. Wrapped in a single transaction. |
| 12 | `add_profile_settings.sql` | Profile screen's Notifications / Privacy & Visibility toggles. Adds `notification_settings` and `privacy_settings` jsonb columns to `profiles`, each with a sensible default so existing rows don't need backfill. |
| 13 | `add_avatars_storage.sql` | Profile screen's avatar upload. Creates a public `avatars` Storage bucket and a permissive RLS policy on `storage.objects` so the device-scoped anon client can upload/read its own avatar. |
| 14 | `add_itinerary_place_id.sql` | Itinerary item detail view (`/plan/item/[id]`) photo/description. Adds a nullable `place_id` FK from `itinerary_items` to `places(id)` so items created from a real place (chat rich-card, map pin, place detail page, social reel) can look that place back up; manually-created items keep `place_id` null. |
| 15 | `add_events.sql` | Roameo v1 "What's On Nearby" (Events, Phase 1). Creates the shared `events` table (Skiddle + Ticketmaster cache, no device_id), a **plain** unique index on `(provider, provider_event_id)` for upsert `on_conflict`, `starts_at`/destination/geo indexes, and anon read+write RLS policies so `/api/events` can cache live results. `country` has **no column default** — see the trap note at the top of the file. |
| 16 | `add_itinerary_times.sql` | Roameo v1 "right now" pivot (Home/Plan rebuild). Adds `starts_at`/`duration_minutes` to `itinerary_items` and best-effort backfills `starts_at` by parsing `time_label` against `day_date`. Blocking migration — the ranker (`lib/now/`) can't compute gaps, leave-by times, or "current activity" without it. See `plan-v1-home-pivot.md` §10.1. |
| 17 | `add_places_ranking_signals.sql` | Adds `opening_hours` (structured, powers the `closing_soon` generator), `mention_count`/`mention_sources` (v1's reel-mention Best-of floor), `detail_line` (cached per-place one-liner), and `image_quality` (hero-eligibility gate) to `places`. See §10.2, §11. |
| 18 | `add_now_ranker_tables.sql` | Creates `card_signals` (dismiss/save/plan feedback — the ranker's only learning signal), `saved_items` (the shortlist "Save" writes to — closes the recall gap a ranked, ephemeral Home creates), `device_location` (coarse last-known location), and `arrival_tips` (shared, hand-authored cold-start copy). See §10.3. |
| 19 | `seed_arrival_tips.sql` | Seeds `arrival_tips` for Japan and Scotland (v1's two curated-coverage countries). Delete+insert per country — safe to re-run after hand-editing the copy. |

### ⚠️ Known gap: no promotion script for the Kanto pilot batch

The 19 places loaded by `seed_japan_pilot.sql` (batch `jp-kanto-pilot-2026-07-14`) have **no corresponding promotion script** — there is no `promote_japan_pilot.sql`. Those rows are sitting in `places_staging` with `extraction_status = 'approved'` but will never reach the live `places` table until one is written.

**TODO:** write `promote_japan_pilot.sql`, mirroring `promote_japan_tokyo.sql`'s pattern (steps 1–4 in that file), but targeting `batch_id = 'jp-kanto-pilot-2026-07-14'` and `places_staging` only (no `city_foods_staging` — the Kanto pilot batch never populated that table). Do not assume this has been done; check `places_staging where batch_id = 'jp-kanto-pilot-2026-07-14' and extraction_status = 'promoted'` to confirm before treating the gap as closed.

## 3. Add Supabase Credentials to .env.local

In the root of your Next.js project, create or update `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

Copy both values from your Supabase project's **API** settings page (Settings > API > Project URL and anon key).

## Notes on RLS

All domain tables (`profiles`, `travel_preferences`, `roameo_rules`, `trips`, `itinerary_items`, `chat_messages`) have **permissive RLS policies**. Device scoping is enforced by **convention** (app-side, via `device_id` in localStorage).

This is suitable for v0 (single-device, local development). **Before multi-user launch**, harden RLS with actual user authentication and row-level access controls.

Shared tables (`places`, `social_posts`) allow anon `select` only (read-only).

## Verification

After running `schema.sql` and `seed.sql` (files 1–2):

1. Check **Table Editor** in Supabase — you should see 8 `places` and 3 `social_posts`.
2. Run `npm run dev` and verify the app connects (no auth errors).
3. Confirm that placing items on the trip persists to Supabase (visible in Table Editor).

If you've also run the full pipeline (files 5–11):

4. `places_staging` should have 19 rows for `batch_id = 'jp-kanto-pilot-2026-07-14'` (all still `extraction_status = 'approved'` — see the known gap above) and 54 rows for `batch_id = 'jp-tokyo-2026-07-15'` (`extraction_status = 'promoted'` once step 11 has run).
5. `places` should contain the original 8 seed rows plus the promoted Tokyo batch; `city_foods` should have 3 rows for `jp-tokyo-2026-07-15`.

## Events (Skiddle + Ticketmaster)

`add_events.sql` (file 15) adds the `events` table for the "What's On Nearby" feature. After running it:

- Run `\d events` in the SQL editor and confirm `events_provider_event_key` shows up as a **plain** unique index, not a partial one — a partial index can't be a PostgREST upsert `on_conflict` arbiter (Postgres error 42P10), which would silently break `/api/events`'s caching.
- Add `SKIDDLE_API_KEY` and `TICKETMASTER_API_KEY` to `.env.local` (see the root `README.md` and `.env.example`) to get live results; without either key set, `/api/events` still returns 200 with `degraded: "no-event-keys"` and whatever's cached.

**Sources deliberately excluded:** Eventbrite has no public venue-search endpoint (venue lookups 403 for anyone but the token owner, and there's no cross-reference from a lat/lng to an Eventbrite venue id) — its only working geo route is an undocumented, CSRF/session-gated internal endpoint, which makes it scraper-pipeline work rather than a route handler; deferred. Meetup's REST API was retired in Feb 2025 and its GraphQL API needs an OAuth consumer only paid Meetup Pro accounts can create — out of scope entirely.
