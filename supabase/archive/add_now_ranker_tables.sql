-- Roameo v1: "right now" pivot, part 3 — new tables for the ranker.
-- See plan-v1-home-pivot.md §10.3. Run after add_places_ranking_signals.sql.
--
-- Idempotent — safe to re-run.

-- ============================================================================
-- CARD SIGNALS — the ranker's only feedback channel (device-scoped)
-- ============================================================================
-- Every "shown" / "opened" / "dismissed" ("Nah") / "saved" / "planned" event
-- on a ranked card. `dismissed` feeds noveltyDecay (§9.4) so a card the user
-- said "Nah" to doesn't keep winning the hero slot; the full log also lets a
-- future pass tell which generators are actually earning their keep.
create table if not exists card_signals (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  trip_id uuid references trips(id) on delete cascade,
  card_type text not null,        -- generator name, e.g. 'closing_soon'
  subject_type text not null,     -- place | event | experience | itinerary_item | reel
  subject_id text not null,
  action text not null,           -- shown | opened | dismissed | saved | planned
  created_at timestamptz default now()
);

alter table card_signals enable row level security;
drop policy if exists "anon_all" on card_signals;
create policy "anon_all" on card_signals for all to anon using (true) with check (true);

create index if not exists card_signals_device_created_idx
  on card_signals (device_id, created_at desc);
create index if not exists card_signals_subject_idx
  on card_signals (device_id, subject_type, subject_id);

-- ============================================================================
-- SAVED ITEMS — the recall mechanism a ranked, ephemeral Home needs
-- ============================================================================
-- There is currently no "shortlist" concept anywhere in the app. Once Home
-- stops being a browsable dashboard, "Save" on the shared card action row
-- (plan-v1-home-pivot.md §8) is the only way to hang onto something you
-- saw once and want to find again.
create table if not exists saved_items (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  trip_id uuid references trips(id) on delete cascade,
  subject_type text not null,
  subject_id text not null,
  note text,
  created_at timestamptz default now()
);

alter table saved_items enable row level security;
drop policy if exists "anon_all" on saved_items;
create policy "anon_all" on saved_items for all to anon using (true) with check (true);

-- Plain (non-partial) unique index — same on_conflict-compatibility reasoning
-- as places_google_place_id_key / events_provider_event_key.
drop index if exists saved_items_unique;
create unique index saved_items_unique
  on saved_items (device_id, subject_type, subject_id);

-- ============================================================================
-- DEVICE LOCATION — coarse last-known location for graceful degradation
-- ============================================================================
-- Deliberately coarse (rounded to ~1.1km by the write path, not by this
-- table) and single-row-per-device. This is NOT a tracking table: it exists
-- so the ranker has something better than "no location" when the browser
-- hasn't re-granted a fresh reading yet (app just reopened, GPS still
-- acquiring), and so a v2 push job can target roughly the right city. The
-- write path (lib/now/) must delete this row when location permission is
-- revoked — see plan-v1-home-pivot.md §10.3.
create table if not exists device_location (
  device_id text primary key,
  lat double precision,
  lng double precision,
  updated_at timestamptz default now()
);

alter table device_location enable row level security;
drop policy if exists "anon_all" on device_location;
create policy "anon_all" on device_location for all to anon using (true) with check (true);

-- ============================================================================
-- ARRIVAL TIPS — shared, hand-authored, read-only (same class as `places`)
-- ============================================================================
-- Backs the cold-start hero (plan-v1-home-pivot.md §4.5): practical
-- just-landed advice keyed to country/city and hours-since-arrival. Small,
-- hand-authored set — Japan and Scotland only in v1 (see seed_arrival_tips.sql).
create table if not exists arrival_tips (
  id uuid primary key default gen_random_uuid(),
  country text not null,
  city text,
  headline text not null,
  detail text not null,
  applies_hours_from int default 0,
  applies_hours_to int default 12
);

alter table arrival_tips enable row level security;
drop policy if exists "anon_select" on arrival_tips;
create policy "anon_select" on arrival_tips for select to anon using (true);

create index if not exists arrival_tips_country_idx on arrival_tips (country, city);
