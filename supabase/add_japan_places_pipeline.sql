-- Roameo Japan Places Pipeline migration.
-- Adds the minimum metadata needed for prefecture-based Japan place ingestion,
-- plus staging/provenance tables so LLM extraction can be reviewed before a
-- record is promoted into the shared `places` table.
--
-- Run after schema.sql and add_places_columns.sql. Idempotent and safe to re-run.

alter table places add column if not exists city text;
alter table places add column if not exists prefecture text;
alter table places add column if not exists country text default 'JP';
alter table places add column if not exists description text;
alter table places add column if not exists last_verified_at timestamptz;
alter table places add column if not exists hours_status text default 'unknown'
  check (hours_status in ('known', 'unknown', 'stale'));

create index if not exists places_country_prefecture_city_idx
  on places (country, prefecture, city);

-- Dedupe for manually seeded / Google-invisible records. Google-resolved rows
-- should still use places_google_place_id_key from add_places_columns.sql.
create unique index if not exists places_name_destination_key
  on places (lower(name), destination)
  where google_place_id is null and name is not null and destination is not null;

create table if not exists place_photos (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references places(id) on delete cascade,
  url text not null,
  credit text not null,
  license text not null,
  source_url text not null,
  display_order int default 0,
  created_at timestamptz default now()
);

alter table place_photos enable row level security;
drop policy if exists "anon_select" on place_photos;
create policy "anon_select" on place_photos for select to anon using (true);
drop policy if exists "anon_write" on place_photos;
create policy "anon_write" on place_photos for all to anon using (true) with check (true);
create index if not exists place_photos_place_order_idx
  on place_photos (place_id, display_order);

create table if not exists place_sources (
  id uuid primary key default gen_random_uuid(),
  place_id uuid references places(id) on delete cascade,
  staging_id uuid,
  field_name text not null,
  source_url text not null,
  fetched_at timestamptz default now(),
  extractor text,
  created_at timestamptz default now()
);

alter table place_sources enable row level security;
drop policy if exists "anon_select" on place_sources;
create policy "anon_select" on place_sources for select to anon using (true);
drop policy if exists "anon_write" on place_sources;
create policy "anon_write" on place_sources for all to anon using (true) with check (true);
create index if not exists place_sources_place_field_idx
  on place_sources (place_id, field_name);
create index if not exists place_sources_staging_field_idx
  on place_sources (staging_id, field_name);

create table if not exists places_staging (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null,
  dedupe_key text not null,
  region text,
  prefecture text not null,
  city text,
  country text default 'JP',
  name text not null,
  category text,
  description text,
  tips jsonb default '[]'::jsonb,
  hours text,
  hours_status text default 'unknown'
    check (hours_status in ('known', 'unknown', 'stale')),
  station text,
  google_place_id text,
  lat double precision,
  lng double precision,
  address text,
  rating numeric,
  price_level int,
  image_url text,
  badges text[] default '{}',
  source_urls text[] default '{}',
  field_sources jsonb default '{}'::jsonb,
  photo jsonb,
  extraction_model text,
  extraction_status text default 'pending'
    check (extraction_status in ('pending', 'extracted', 'validated', 'approved', 'rejected', 'promoted')),
  validation_errors jsonb default '[]'::jsonb,
  approved boolean default false,
  rejected_reason text,
  place_id uuid references places(id) on delete set null,
  fetched_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table places_staging enable row level security;
drop policy if exists "anon_select" on places_staging;
create policy "anon_select" on places_staging for select to anon using (true);
drop policy if exists "anon_write" on places_staging;
create policy "anon_write" on places_staging for all to anon using (true) with check (true);

create unique index if not exists places_staging_batch_google_place_id_key
  on places_staging (batch_id, google_place_id)
  where google_place_id is not null;
create unique index if not exists places_staging_batch_dedupe_key_key
  on places_staging (batch_id, dedupe_key);
create index if not exists places_staging_status_idx
  on places_staging (batch_id, extraction_status, approved);
