-- Roameo v1: Events ("What's On Nearby"). Adds the shared `events` table,
-- cached from live provider APIs (Skiddle, Ticketmaster) by the /api/events
-- route. Same class as `places` / `experiences`: shared public data, no
-- device_id, anon read+write RLS.
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql has already been applied. Idempotent — safe to re-run.

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                -- 'skiddle' | 'ticketmaster'
  provider_event_id text not null,
  name text not null,
  description text,
  category text,                         -- normalized Roameo slug (see lib/events/categories.ts)
  image_url text,
  ticket_url text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  venue_name text,
  address text,
  lat double precision,
  lng double precision,
  city text,
  -- NO DEFAULT. `places.country default 'JP'` silently mistagged every live
  -- Google row (see the comment at lib/places/google.ts:172-182) — every
  -- events provider must set this column explicitly instead of relying on a
  -- default that would be wrong for most rows.
  country text,
  is_free boolean,
  price_from numeric,
  currency text,
  destination text,                      -- the query string this row was fetched for
  place_id uuid references places(id),   -- optional link to a curated venue
  source text default 'api',
  fetched_at timestamptz,
  created_at timestamptz default now()
);

-- Plain (non-partial) unique index. A partial index (e.g.
-- `where provider_event_id is not null`) cannot be targeted by PostgREST's
-- upsert `on_conflict` — Postgres error 42P10 — the same trap documented in
-- supabase/add_places_columns.sql for places_google_place_id_key.
create unique index if not exists events_provider_event_key
  on events (provider, provider_event_id);

create index if not exists events_starts_at_idx on events (starts_at);
create index if not exists events_destination_starts_idx on events (destination, starts_at);
create index if not exists events_geo_idx on events (lat, lng);

alter table events enable row level security;

-- Shared public cache, same policy shape as `places`/`experiences`: anon can
-- read everything and the /api/events route (anon client, no auth) needs to
-- write the upsert cache too.
drop policy if exists anon_select on events;
create policy anon_select on events for select using (true);
drop policy if exists anon_write on events;
create policy anon_write on events for all using (true) with check (true);

-- Manual purge of stale rows — not automated (no cron in this app). Run by
-- hand in the SQL editor when the table needs tidying:
-- delete from events where starts_at < now() - interval '7 days';
