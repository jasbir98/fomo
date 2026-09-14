-- add_trip_persona.sql — Phase 3 (Trip geo capture) + Phase 4 (Onboarding +
-- the real gate) of plan-v1.2-accounts.md.
--
-- Phase 3 added the geo columns only. Phase 4 adds the trip-scoped persona
-- columns below (plan §C.2) because the onboarding screens `/onboarding/stage`
-- and `/onboarding/party` need somewhere to write their answers immediately —
-- the plan's own build-sequence table assigns these to Phase 5, but nothing
-- about them depends on Phase 5's ranker work, and onboarding cannot function
-- without them. See the Phase 4 report for the full reasoning.
--
-- Geo columns populated once at trip-creation time by POST /api/trips/resolve
-- (app/api/trips/resolve/route.ts) from the trip's `destination` string —
-- see lib/places/geocode.ts (country_code, via Mapbox feature context) and
-- lib/weather.ts (timezone, via Open-Meteo). All nullable: both providers
-- can fail per-destination and callers must treat these as optional.
alter table trips
  add column if not exists lat           double precision,
  add column if not exists lng           double precision,
  add column if not exists country_code  text,
  add column if not exists timezone      text,
  add column if not exists place_label   text;

-- Persona columns (Phase 4) — written by /onboarding/stage (plan_stage) and
-- /onboarding/party (party_type, party_size, kid_ages, first_time). `purpose`
-- and `pace_override` have no writer yet in this phase (no screen asks
-- "purpose" and pace_override is reserved for a future per-trip pace
-- override) — both stay nullable and unused until a later phase reads or
-- writes them. Nothing in lib/now/ reads any of these yet (Phase 6).
alter table trips
  add column if not exists plan_stage    text,   -- booked | rough | open
  add column if not exists purpose       text,   -- holiday | work | visiting | event
  add column if not exists party_type    text,   -- solo | couple | friends | family
  add column if not exists party_size    int,
  add column if not exists kid_ages      text[] default '{}',  -- under5 | 5to12 | teen
  add column if not exists first_time    boolean,
  add column if not exists pace_override text;

create index if not exists trips_country_idx on trips (country_code);

-- Backfill for trips created before this migration: this can't be done in
-- SQL alone (needs live Mapbox/Open-Meteo calls per row), so it's a
-- one-off Node script instead — see scripts/backfill-trip-geo.mjs. Run it
-- once after this migration + the Phase 3 app code are both deployed:
--
--   node --env-file=.env.local scripts/backfill-trip-geo.mjs
