-- Drop the trip-planner era tables (reels, experiences, Japan pipeline,
-- trips, practicalities, the /api/now ranker). Fomo no longer reads or
-- writes any of them once the 2026-09 cleanup commit is deployed.
--
-- RUN ONLY AFTER that deploy is live (otherwise Saved / chat would still
-- send trip_id and fail). A JSON backup of every table below was exported
-- on 2026-09-28 (fomo-legacy-backup-2026-09-28.zip).
--
-- Kept on purpose: places, place_photos (venue catalogue behind /place/[id]
-- and Explore), places_staging + place_sources (the venue re-seed pipeline:
-- scraper/upsert_places.py -> scripts/promote-places.mjs), saved_items,
-- chat_messages, everything email/tips/push/rate-limit.
--
-- Safe to re-run: every statement uses IF EXISTS.

begin;

-- 1. Saved rows pointing at subject types that no longer exist (3 rows at backup time).
delete from saved_items
where subject_type in ('reel', 'experience', 'itinerary_item', 'practicality');

-- 2. Unused trip_id columns. Drop the columns BEFORE the trips table so the
--    saved_items FK (on delete cascade) can never touch a row.
alter table saved_items   drop column if exists trip_id;
alter table chat_messages drop column if exists trip_id;

-- The only chat index included trip_id and goes with the column; chat is
-- read per user, newest first (lib/db/chat.ts).
create index if not exists chat_messages_user_created_idx
  on chat_messages (user_id, created_at);

-- 3. Legacy tables. CASCADE only removes dependent constraints/indexes/policies
--    between these tables (e.g. itinerary_items -> experiences), never rows of
--    kept tables.
drop table if exists card_signals            cascade;
drop table if exists user_location           cascade;
drop table if exists device_location         cascade;
drop table if exists travel_preferences      cascade;
drop table if exists itinerary_items         cascade;
drop table if exists roameo_rules            cascade;
drop table if exists trips                   cascade;
drop table if exists practicality_dismissals cascade;
drop table if exists country_practicalities  cascade;
drop table if exists arrival_tips            cascade;
drop table if exists experiences             cascade;
drop table if exists scraped_reels           cascade;
drop table if exists social_posts            cascade;
drop table if exists city_foods_staging      cascade;
drop table if exists city_foods              cascade;

commit;

-- Verify (read-only): should return no rows.
-- select table_name from information_schema.tables
-- where table_schema = 'public' and table_name in (
--   'card_signals','user_location','device_location','travel_preferences','itinerary_items',
--   'roameo_rules','trips','practicality_dismissals','country_practicalities','arrival_tips',
--   'experiences','scraped_reels','social_posts','city_foods_staging','city_foods');
