-- Roameo Japan Tokyo Pipeline extension.
-- Extends the Japan pipeline (add_japan_places_pipeline.sql) for the Tokyo run:
--   * multi-photo staging on places_staging (photos jsonb array)
--   * richer provenance columns on place_photos
--   * new city_foods + city_foods_staging tables for per-city famous dish metadata
--
-- Run after schema.sql, add_places_columns.sql, and add_japan_places_pipeline.sql.
-- Idempotent and safe to re-run.

-- ============================================================================
-- STAGING: multiple candidate photos per staged place
-- ============================================================================
alter table places_staging add column if not exists photos jsonb default '[]'::jsonb;

-- ============================================================================
-- PROMOTED place_photos: richer provenance for image review
-- ============================================================================
alter table place_photos add column if not exists provider text;
alter table place_photos add column if not exists is_exact_place boolean default true;
alter table place_photos add column if not exists width int;
alter table place_photos add column if not exists height int;
alter table place_photos add column if not exists attribution_required boolean default true;

-- Dedupe: same (place_id, url) should never be inserted twice.
create unique index if not exists place_photos_place_url_key
  on place_photos (place_id, url);

-- ============================================================================
-- CITY FOODS: promoted famous-dish records per city
-- ============================================================================
create table if not exists city_foods (
  id uuid primary key default gen_random_uuid(),
  country text not null default 'JP',
  prefecture text not null,
  city text not null,
  name text not null,
  description text,
  source_urls text[] default '{}',
  linked_places text[] default '{}',
  confidence text default 'medium'
    check (confidence in ('low','medium','high')),
  last_verified_at timestamptz,
  created_at timestamptz default now()
);

alter table city_foods enable row level security;
drop policy if exists "anon_select" on city_foods;
create policy "anon_select" on city_foods for select to anon using (true);
drop policy if exists "anon_write" on city_foods;
create policy "anon_write" on city_foods for all to anon using (true) with check (true);

create unique index if not exists city_foods_city_name_key
  on city_foods (country, prefecture, city, lower(name));
create index if not exists city_foods_city_idx
  on city_foods (country, prefecture, city);

-- ============================================================================
-- CITY FOODS STAGING: pre-promotion review of famous-dish claims
-- ============================================================================
create table if not exists city_foods_staging (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null,
  country text not null default 'JP',
  prefecture text not null,
  city text not null,
  name text not null,
  description text,
  source_urls text[] default '{}',
  linked_places text[] default '{}',
  extraction_model text,
  extraction_status text default 'pending'
    check (extraction_status in ('pending','extracted','validated','approved','rejected','promoted')),
  validation_errors jsonb default '[]'::jsonb,
  approved boolean default false,
  rejected_reason text,
  city_food_id uuid references city_foods(id) on delete set null,
  last_verified_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table city_foods_staging enable row level security;
drop policy if exists "anon_select" on city_foods_staging;
create policy "anon_select" on city_foods_staging for select to anon using (true);
drop policy if exists "anon_write" on city_foods_staging;
create policy "anon_write" on city_foods_staging for all to anon using (true) with check (true);

create unique index if not exists city_foods_staging_batch_city_name_key
  on city_foods_staging (batch_id, country, prefecture, city, lower(name));
create index if not exists city_foods_staging_status_idx
  on city_foods_staging (batch_id, extraction_status, approved);
