-- Roameo v0 Database Schema
-- RLS is intentionally permissive with per-device scoping by convention.
-- This should be hardened before any multi-user launch.
-- All domain tables are scoped by device_id (stored in localStorage).

-- Enable RLS extension
create extension if not exists pgcrypto;

-- ============================================================================
-- PROFILES TABLE
-- ============================================================================
create table if not exists profiles (
  device_id text primary key,
  display_name text,
  avatar_url text,
  membership_tier text,
  created_at timestamptz default now()
);

alter table profiles enable row level security;
drop policy if exists "anon_all" on profiles;
create policy "anon_all" on profiles for all to anon using (true) with check (true);

-- ============================================================================
-- TRAVEL PREFERENCES TABLE
-- ============================================================================
create table if not exists travel_preferences (
  device_id text primary key,
  luxury_backpacker int,
  planned_spontaneous int,
  foodie_utilitarian int,
  interests text[] default '{}',
  dietary text[] default '{}',
  mobility text[] default '{}',
  languages text[] default '{}'
);

alter table travel_preferences enable row level security;
drop policy if exists "anon_all" on travel_preferences;
create policy "anon_all" on travel_preferences for all to anon using (true) with check (true);

-- ============================================================================
-- ROAMEO RULES TABLE
-- ============================================================================
create table if not exists roameo_rules (
  device_id text primary key,
  rules_text text,
  quick_chips text[] default '{}'
);

alter table roameo_rules enable row level security;
drop policy if exists "anon_all" on roameo_rules;
create policy "anon_all" on roameo_rules for all to anon using (true) with check (true);

-- ============================================================================
-- TRIPS TABLE
-- ============================================================================
create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  name text,
  destination text,
  start_date date,
  end_date date,
  status text,
  cover_image_url text,
  created_at timestamptz default now()
);

alter table trips enable row level security;
drop policy if exists "anon_all" on trips;
create policy "anon_all" on trips for all to anon using (true) with check (true);
create index if not exists trips_device_id_idx on trips(device_id);

-- ============================================================================
-- ITINERARY ITEMS TABLE
-- ============================================================================
create table if not exists itinerary_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  device_id text not null,
  day_date date,
  time_label text,
  category text,
  title text,
  location text,
  weather_alert boolean default false,
  color_tag text,
  created_at timestamptz default now()
);

alter table itinerary_items enable row level security;
drop policy if exists "anon_all" on itinerary_items;
create policy "anon_all" on itinerary_items for all to anon using (true) with check (true);
create index if not exists itinerary_items_device_trip_date_idx on itinerary_items(device_id, trip_id, day_date);

-- ============================================================================
-- CHAT MESSAGES TABLE
-- ============================================================================
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  device_id text not null,
  role text,
  mode text,
  content jsonb,
  created_at timestamptz default now()
);

alter table chat_messages enable row level security;
drop policy if exists "anon_all" on chat_messages;
create policy "anon_all" on chat_messages for all to anon using (true) with check (true);
create index if not exists chat_messages_device_trip_created_idx on chat_messages(device_id, trip_id, created_at);

-- ============================================================================
-- PLACES TABLE (Shared read-only seed data, no device_id)
-- ============================================================================
create table if not exists places (
  id uuid primary key default gen_random_uuid(),
  name text,
  category text,
  rating numeric,
  image_url text,
  distance_label text,
  tips jsonb,
  reviews jsonb,
  hours text,
  station text,
  badges text[] default '{}'
);

alter table places enable row level security;
drop policy if exists "anon_select" on places;
create policy "anon_select" on places for select to anon using (true);

-- ============================================================================
-- SOCIAL POSTS TABLE (Shared read-only seed data, no device_id)
-- ============================================================================
create table if not exists social_posts (
  id uuid primary key default gen_random_uuid(),
  author_handle text,
  avatar_url text,
  image_url text,
  caption text,
  likes int,
  location text
);

alter table social_posts enable row level security;
drop policy if exists "anon_select" on social_posts;
create policy "anon_select" on social_posts for select to anon using (true);
