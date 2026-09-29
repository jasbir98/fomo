# Archive — history only, already applied

**Every file in this folder has already been run against the production database.
Do not run any of them again.**

Several re-open anon write access that later migrations closed
(`harden_rls.sql` re-creates `anon_write` on a handful of catalog tables mid-way
through the timeline below; `add_scraped_reels_staging.sql` / `add_social_video_columns.sql`
/ `add_places_columns.sql` etc. predate `harden_rls.sql` and `lock_pipeline_tables.sql`,
which permanently closed the anon-write holes those files opened). Some would
also error outright on a fresh run — several depend on the `device_id` columns
`drop_device_id.sql` removed, and later files assume tables/columns earlier
files already dropped or renamed.

These are kept purely as a record of how the schema evolved from the original
device-scoped "Roameo" trip planner (v0) through the "v1.2 Accounts" identity
migration to the current "Fomo" Edinburgh app. If you need to stand up a new
project from scratch, do not replay this folder — build a fresh, idempotent
schema from the **Current schema** section of `supabase/README.md` instead.

Order below is applied-date order, inferred from `git log --diff-filter=A`
(two squash commits — 2026-08-01 and 2026-09-14 — each bundle a run of files
committed together, so within those two batches the finer order comes from
the files' on-disk modification timestamps, which predate the squashes and
still reflect the order they were originally written in).

## v0 — original device-scoped trip planner

| File | Purpose |
|---|---|
| `schema.sql` | Base v0 schema: `profiles`, `travel_preferences`, `roameo_rules`, `trips`, `itinerary_items`, `chat_messages`, `places`, `social_posts`. Permissive device-scoped (`anon_all`) RLS. |
| `fix_profile_fk.sql` | One-time: drops stale `profiles(device_id)` FKs that made every write 23503 (nothing ever inserted a `profiles` row in v0). |
| `seed.sql` | Seeds 8 Tokyo `places` + 3 sample `social_posts`. |
| `fix_broken_images.sql` | One-time: patches 3 rows' 404'd Unsplash URLs from the original `seed.sql`. |
| `add_places_columns.sql` | v1 Phase 2 (Maps). Google Places cache columns on `places`, `anon_write` policy for live caching. |
| `add_social_video_columns.sql` | v1 Phase 4b (Reels). Reel columns on `social_posts` for the offline scraper; widened to `anon_all`. |
| `add_japan_places_pipeline.sql` | Japan places pipeline pt.1. City/prefecture columns on `places`; creates `place_photos`, `place_sources`, `places_staging` staging/provenance tables. |
| `seed_japan_pilot.sql` | Loads 19 Kanto places into `places_staging` only (batch `jp-kanto-pilot-2026-07-14`). Never promoted — no corresponding promote script exists. |
| `add_japan_tokyo_pipeline.sql` | Japan places pipeline pt.2. Multi-photo staging column; creates `city_foods` / `city_foods_staging`. |
| `seed_japan_tokyo.sql` | Loads 54 Tokyo places + 3 city foods into staging (batch `jp-tokyo-2026-07-15`). |
| `promote_japan_tokyo.sql` | Promotes the `jp-tokyo-2026-07-15` batch from staging into live `places` / `place_photos` / `place_sources` / `city_foods`. |
| `add_scraped_reels_staging.sql` | Splits the reel pipeline: raw `scraped_reels` staging table feeding the curated `social_posts`. |
| `add_profile_settings.sql` | `notification_settings` / `privacy_settings` jsonb columns on `profiles`. |
| `add_avatars_storage.sql` | Public `avatars` Storage bucket, permissive device-scoped policy. |
| `add_itinerary_place_id.sql` | Nullable `place_id` FK from `itinerary_items` to `places`. |
| `add_experiences.sql` | Creates `experiences` (Viator/GetYourGuide cache) — **dropped** by `drop_legacy.sql`. |
| `add_events.sql` | Creates the shared `events` table (Skiddle/Ticketmaster cache) — still live today. |
| `add_itinerary_times.sql` | `starts_at` / `duration_minutes` on `itinerary_items`, backfilled from `time_label`. |
| `add_places_ranking_signals.sql` | `opening_hours`, `mention_count`, `detail_line`, `image_quality` on `places` for the "right now" ranker. |
| `add_now_ranker_tables.sql` | Creates `card_signals`, `saved_items`, `device_location`, `arrival_tips` for the ranker — `card_signals`/`device_location`/`arrival_tips` later **dropped** by `drop_legacy.sql`; `saved_items` still live. |
| `seed_arrival_tips.sql` | Seeds `arrival_tips` for Japan/Scotland — table later dropped (superseded by `country_practicalities`). |

## v1.2 (Accounts) — identity + RLS migration

| File | Purpose |
|---|---|
| `add_auth_identity.sql` | Phase 2 step 1/4. Adds `user_id uuid references auth.users` to every domain table; renames `device_location` → `user_location`; creates the `handle_new_user` signup trigger. Old device-scoped policies left in place (dual-write period). |
| `harden_rls.sql` | Phase 2 step 3/4. Re-grants catalog read policies to `anon, authenticated`; moves `places`/`events`/`experiences` writes to the service-role client; on every user table, drops rows still missing `user_id`, then replaces `anon_all` with an `own_rows` policy scoped to `auth.uid()`. |
| `drop_device_id.sql` | Phase 2 step 4/4 (final). Redefines `handle_new_user` to stop inserting a `device_id` placeholder; drops `device_id` from every user table; promotes `user_id`'s unique index to primary key. |
| `add_trip_persona.sql` | Phase 3 (trip geo columns) + Phase 4 (trip-scoped persona columns) on `trips` — table later **dropped** by `drop_legacy.sql`. |
| `add_person_persona.sql` | Phase 4/5. Persona columns (`budget_band`, `walk_tolerance`, `interest_tags[]`, etc.) on `travel_preferences`, backfilled from the legacy sliders — table later **dropped** by `drop_legacy.sql`. |
| `add_practicalities.sql` | Phase 7. Creates `country_practicalities` + `practicality_dismissals` — both later **dropped** by `drop_legacy.sql`. |
| `seed_country_practicalities.sql` | Phase 7 seed data for Japan/UK, replacing `arrival_tips` as the read path. |
| `drop_legacy_preferences.sql` | Phase 8 cleanup. Drops the 5 `travel_preferences` slider columns Phase 5 replaced (`languages` untouched). |

## Fomo pivot — Edinburgh, happenings, accounts hardening

| File | Purpose |
|---|---|
| `add_happenings.sql` | Creates `happenings` + `happening_sources` (money/access deals catalog) + `happenings_staging`. |
| `decouple_chat_from_trips.sql` | Drops `chat_messages.trip_id`'s NOT NULL + FK to `trips` — chat is no longer trip-scoped. |
| `add_happenings_booking.sql` | `booking_opens_at` / `sellout_risk` / `sellout_note` on `happenings` for the "Book early" feature. |
| `add_push_alerts.sql` | Creates `push_subscriptions`, `onsale_alerts`, `push_notification_log` for web push on-sale alerts; `own_rows` RLS. |
| `schedule_onsale_alerts.sql` | pg_cron + pg_net job calling the `onsale-alerts` Edge Function every 5 minutes. **As committed, this file has a placeholder project ref** — it only actually schedules anything if someone edited in the real ref and ran it by hand; treat the cron job as unconfirmed unless verified live (see `supabase/README.md`'s pg_cron note). |
| `add_rate_limits.sql` | Per-user rate limiting: `api_rate_limits` table + `consume_rate_limit()` RPC (security definer, `EXECUTE` granted to `authenticated` only). |
| `lock_pipeline_tables.sql` | Security fix: closes the anon-key write hole on `places_staging`, `city_foods_staging`, `happenings_staging`, `scraped_reels`, `place_photos`, `place_sources`, `city_foods`, `social_posts` — all pipeline writes move to the service-role key. |
| `add_season_valid_until.sql` | Optional `season_valid_until` reverify-by date on `happenings`. |
| `add_email_subscribers.sql` | Creates `email_subscribers` for the "Fomo Friday" digest — write-only mailbox (anon insert, service-role-only read). |
| `add_tips.sql` | Creates `tips` for user-submitted deal/event leads — write-only mailbox, same shape as `email_subscribers`. |
| `add_anon_rate_limits.sql` | IP-scoped rate limiting: `anon_rate_limits` table + `consume_anon_rate_limit()` RPC (security definer, `EXECUTE` granted to `service_role` only). |
| `add_email_events.sql` | Creates `email_events`, an append-only log of Resend webhook deliveries. |

---

Superseded/legacy tables this archive's files created, later dropped by
`drop_legacy.sql` (2026-09-28 cleanup, applied): `card_signals`, `user_location`,
`device_location`, `travel_preferences`, `itinerary_items`, `roameo_rules`,
`trips`, `practicality_dismissals`, `country_practicalities`, `arrival_tips`,
`experiences`, `scraped_reels`, `social_posts`, `city_foods_staging`,
`city_foods`.
