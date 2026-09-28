-- Roameo v1: Experiences (bookable tours/activities) migration.
-- Adds a new `experiences` table caching Viator/GetYourGuide product results
-- (shared read cache, no device_id — same shape as `places`), and lets an
-- itinerary item reference an experience the same way it can already
-- reference a place.
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql (and add_places_columns.sql) has already been applied.
-- Idempotent — safe to re-run.

create table if not exists experiences (
  id uuid primary key default gen_random_uuid(),
  provider text,
  provider_product_id text,
  title text,
  category text,
  rating numeric,
  review_count int,
  price_from numeric,
  currency text,
  duration_label text,
  image_url text,
  description text,
  destination text,
  city text,
  country text,
  lat double precision,
  lng double precision,
  booking_url text,
  source text default 'live',
  fetched_at timestamptz,
  created_at timestamptz default now()
);

-- Drop-then-create (not `if not exists` alone): `if not exists` only checks
-- the index NAME, not its definition, so if this migration is ever re-run
-- after a shape change to the dedup key it would silently keep the stale
-- index. Mirrors add_places_columns.sql's places_google_place_id_key.
drop index if exists experiences_provider_product_key;
create unique index experiences_provider_product_key
  on experiences (provider, provider_product_id);

-- Shared public cache table, same RLS shape as `places`: anon can read
-- freely, and anon can also write since the (no-auth) app's own
-- /api/experiences-style route is what populates/upserts this cache
-- (mirrors the anon_write policy add_places_columns.sql grants on `places`).
alter table experiences enable row level security;
drop policy if exists "anon_select" on experiences;
create policy "anon_select" on experiences for select to anon using (true);
drop policy if exists "anon_write" on experiences;
create policy "anon_write" on experiences for all to anon using (true) with check (true);

-- Let an itinerary item point at either a place or an experience.
alter table itinerary_items add column if not exists experience_id uuid references experiences(id);
