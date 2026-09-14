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
| 20 | `add_auth_identity.sql` | Roameo v1.2 (Accounts) Phase 2, step 1 of 4. Adds a nullable `user_id uuid references auth.users(id)` to every domain table (default `auth.uid()`), renames `device_location` → `user_location`, adds `user_id`-leading indexes, and creates the `handle_new_user` trigger that auto-inserts a `profiles` row on signup. Every existing `anon_all`/`anon_select` policy is left untouched, so the app keeps working device_id-scoped until the next deploy — safe to run immediately. **After running this file: deploy the app's Phase 2 code (the `lib/db/*` `deviceId` → `db` param swap, the 5 request-scoped routes, `/api/{places,events,experiences}`'s admin-client writes) and confirm a signed-in write lands with a non-null `user_id` before running row 21.** Idempotent. |
| 21 | `harden_rls.sql` | Roameo v1.2 (Accounts) Phase 2, step 3 of 4. One transaction, order-sensitive (see the file's own header): **(1)** re-grants every catalog read policy (`places`, `place_photos`, `social_posts`, `events`, `experiences`, `city_foods`, `arrival_tips`) to `anon, authenticated` — fixes the "first signed-in user loses the catalog" outage that would otherwise happen the instant anyone signs in, since several of those policies were granted `to anon` explicitly; **(2)** confirms `places`/`events`/`experiences` writes move to the service-role client, dropping their `anon_write` policies for good; **(3)** on every user table, deletes any row still missing a `user_id` (discards pre-auth device-scoped dev data — no undo), sets `user_id not null`, drops `anon_all`, and adds an `own_rows` policy scoped to `auth.uid()`; also tightens the `avatars` storage policy to the authenticated owner's folder. Only run after row 20's app deploy is verified. |
| 22 | `drop_device_id.sql` | Roameo v1.2 (Accounts) Phase 2, step 4 of 4 (final). Redefines `handle_new_user` to stop inserting a `device_id` placeholder, then drops the `device_id` column from every user table and promotes each table's `user_id` unique index into its real primary key. Not easily revertible — only run after `harden_rls.sql` has run successfully and you've confirmed the app still works signed-in via RLS alone. |
| 23 | `add_trip_persona.sql` | Roameo v1.2 (Accounts) Phase 3 + Phase 4. Adds geo columns to `trips` (`lat`, `lng`, `country_code`, `timezone`, `place_label` — populated by `POST /api/trips/resolve` at trip-creation time) plus trip-scoped persona columns (`plan_stage`, `purpose`, `party_type`, `party_size`, `kid_ages[]`, `first_time`, `pace_override` — written by `/onboarding/stage` and `/onboarding/party`). Existing trips need a one-off backfill for the geo columns: `node --env-file=.env.local scripts/backfill-trip-geo.mjs`, run once after this migration and the Phase 3 app code are both deployed. |
| 24 | `add_person_persona.sql` | Roameo v1.2 (Accounts) Phase 4/5. Adds person-scoped persona columns to `travel_preferences` (`budget_band`, `walk_tolerance`, `interest_tags[]`, `cuisine_tags[]`, `day_rhythm`, `pace` — written by `/onboarding/taste` and `/onboarding/rhythm`), then backfills them from the legacy `luxury_backpacker`/`mobility`/`interests` columns wherever a value maps cleanly (documented label-by-label in the file's own header). The legacy columns are left in place, untouched, until Phase 8 drops them (row 27). |
| 25 | `add_practicalities.sql` | Roameo v1.2 (Accounts) Phase 7. Creates `country_practicalities` (shared, hand-authored catalog — connectivity/money/transit/power/water/tipping/safety topics per country/city, read-only, granted `to anon, authenticated` from the start) and `practicality_dismissals` (user-scoped "Already sorted" state, keyed on `(user_id, country_code, topic)` — deliberately not on trip, so a dismissal survives into next year's trip to the same country). |
| 26 | `seed_country_practicalities.sql` | Roameo v1.2 (Accounts) Phase 7 seed data. Seeds `country_practicalities` for Japan and the UK (the same two curated-coverage countries as `seed_arrival_tips.sql`, which this table replaces as the app's read path — `arrival_tips`' old JP/GB rows are folded in, not duplicated). Delete+insert per country. Run after row 25. |
| 27 | `drop_legacy_preferences.sql` | Roameo v1.2 (Accounts) Phase 8 "Cleanup". Drops the five `travel_preferences` columns Phase 5 replaced — `luxury_backpacker`, `planned_spontaneous`, `foodie_utilitarian`, `mobility`, `interests` (`languages` has no replacement and is untouched). Genuinely destructive, no undo — only run once row 24's backfill has been verified on this project's data **and** the app has been redeployed reading `budget_band`/`walk_tolerance`/`pace`/`day_rhythm`/`interest_tags` instead (see the file's own header for the exact verification query). |

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

This describes the **current, post-`harden_rls.sql`/`drop_device_id.sql` state** (rows 20–22 above) — the original v0 device-scoped design this section used to describe no longer exists in a project that has run the full migration list.

Every user table (`profiles`, `travel_preferences`, `roameo_rules`, `trips`, `itinerary_items`, `chat_messages`, `card_signals`, `saved_items`, `user_location`) is keyed by `user_id uuid` and scoped by an `own_rows` RLS policy: `using (user_id = auth.uid())`. There is no anon access and no client-supplied id — the database itself enforces that a caller only ever sees their own rows.

Shared catalog tables (`places`, `place_photos`, `social_posts`, `events`, `experiences`, `city_foods`, `arrival_tips`, `country_practicalities`) allow `select` to both `anon` and `authenticated` (read-only to every non-service caller); writes to the live-cache tables (`places`, `events`, `experiences`) go through the service-role client only.

## Accounts & Auth (Supabase Auth)

This project requires Supabase Auth (email OTP + Google/Apple OAuth) to be configured in the **Dashboard** before sign-in works end to end — see `plan-v1.2-accounts.md` §A for the full design. Two things a migration file can't do for you:

- **Email OTP** — Authentication → Email Templates → Magic Link: edit the template to include `{{ .Token }}` (the default only has `{{ .ConfirmationURL }}`), or users get a link with no code to type into the app. Default resend rate limit is 1 email/60s.
- **OAuth apps** — Authentication → Providers: enable Google and Apple, each backed by its own app registered in that provider's developer console. Apple additionally needs a Services ID (the OAuth `client_id`), a `.p8` key, and an ES256 client secret that **expires within a maximum of 6 months and must be rotated** — calendar it.

Also worth enabling: asymmetric (ECC P-256) JWT signing keys (Authentication → JWT Signing Keys), so `proxy.ts` can verify sessions locally with `auth.getClaims()` instead of a network round-trip on every navigation.

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
