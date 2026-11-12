-- add_place_radar.sql - "Under the radar": a small, hand-approved layer of
-- lesser-known Edinburgh places worth knowing (a courtyard cafe, a free
-- viewpoint locals use, a tiny bookshop), one new featured pick a week.
-- Curated with scripts/radar.ts; nothing is shown until you `approve` it.
--
-- Run once, by hand, in the Supabase SQL editor. Idempotent: safe to re-run.
-- It can be run before or after the app deploy: until the columns exist the
-- app (lib/db/radar.ts) treats "no such column" as "no picks" and every
-- surface (Explore chip, /under-the-radar, place badge, weekly email) stays
-- empty or hidden.
--
-- New nullable columns on `places` (null for every existing row):
--   radar_why            the one-line reason it is worth knowing
--   radar_picked_at      when you approved it. Non-null = it is an approved pick.
--   radar_featured_week  the Monday (Europe/London) of the week it is featured.
--                        scripts/radar.ts keeps at most one pick per week.
--
-- RLS: nothing to add. `places` is already readable by anon and authenticated
-- (the public catalogue, see supabase/archive/harden_rls.sql) and has no
-- insert/update/delete policy for them, so the new columns are public to read
-- and only the service role (scripts/radar.ts) can write them. Do not put
-- anything private in these columns.

alter table places add column if not exists radar_why text;
alter table places add column if not exists radar_picked_at timestamptz;
alter table places add column if not exists radar_featured_week date;

-- Partial index: the list is tiny (50-150 rows) against ~3,500 places.
create index if not exists places_radar_idx
  on places (radar_picked_at)
  where radar_picked_at is not null;

-- Verify (read-only). Expect three rows: radar_featured_week, radar_picked_at,
-- radar_why; then the index; then the places policies (a SELECT policy that
-- includes anon or public, and no write policy for them).
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'places' and column_name like 'radar\_%'
order by column_name;

select indexname from pg_indexes
where schemaname = 'public' and tablename = 'places' and indexname = 'places_radar_idx';

select policyname, roles, cmd from pg_policies
where schemaname = 'public' and tablename = 'places';
