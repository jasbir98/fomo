-- Roameo v1: Maps & Places (Phase 2) migration.
-- Adds Google Places (New) caching columns to the existing `places` table
-- so live-fetched results can be stored alongside the seeded rows and the
-- existing place/[id] detail page keeps working off the same table.
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql has already been applied. Idempotent — safe to re-run.

alter table places add column if not exists google_place_id text;
alter table places add column if not exists lat double precision;
alter table places add column if not exists lng double precision;
alter table places add column if not exists address text;
alter table places add column if not exists price_level int;
alter table places add column if not exists destination text;
alter table places add column if not exists source text default 'seed';
alter table places add column if not exists fetched_at timestamptz;

-- Plain (non-partial) unique index. Postgres treats NULLs as distinct, so the
-- seeded rows (google_place_id IS NULL) still coexist, while a full index —
-- unlike a partial one — is inferable by PostgREST's upsert `on_conflict`,
-- which the /api/places route relies on to dedupe cached Google results.
--
-- Drop-then-create (not `if not exists` alone): an earlier version of this
-- migration created a PARTIAL index under this same name
-- (`where google_place_id is not null`), which `on_conflict` cannot target
-- with a bare column reference (Postgres error 42P10). `if not exists` only
-- checks the index NAME, so on a DB that already has the old partial index
-- it would silently skip recreating it as the correct plain index.
drop index if exists places_google_place_id_key;
create unique index places_google_place_id_key
  on places (google_place_id);

-- The v0 schema made `places` read-only for anon (an `anon_select` policy
-- only), so the /api/places route's cache upsert was blocked by RLS. Phase 2
-- writes live Google results back into this table, so grant anon write —
-- mirroring the `anon_all` pattern the other tables use (this app is
-- intentionally no-auth / device-scoped; places are shared public POI data).
drop policy if exists "anon_write" on places;
create policy "anon_write" on places for all to anon using (true) with check (true);
