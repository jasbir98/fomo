-- Roameo v1.2 (Accounts) — Phase 7 "Practicalities". See
-- plan-v1.2-accounts.md §E.1 — READ THAT SECTION BEFORE TOUCHING THIS FILE.
--
-- Two new tables:
--   country_practicalities  — shared, hand-authored, read-only catalog data
--                              (same class as `places`/`arrival_tips`).
--   practicality_dismissals — user-scoped. "I already have a Japan eSIM"
--                              should survive into next year's Japan trip,
--                              so this is keyed on (user, country, topic) —
--                              deliberately NOT on trip.
--
-- `arrival_tips` folds into `country_practicalities` (§E.1/§E.4): its four
-- hand-written JP/GB rows are the same SIM/cash/konbini/pub-hours prose,
-- with `applies_hours_from/to` becoming `applies_from_days/to_days` at day
-- granularity. The OLD `arrival_tips` table and seed_arrival_tips.sql are
-- deliberately left in place (no drop migration here) — only the app code
-- (lib/now/generators.ts's `arrival` generator, lib/db/arrivalTips.ts) stops
-- reading them, per the plan's own "leave it for a later cleanup pass" call.
--
-- `topic` is a stable literal set (connectivity|money|transit|power|water|
-- tipping|safety) — it's the dismissal key, so it must never drift into free
-- text. Enforced in TypeScript as a union (see lib/types.ts's
-- PracticalityTopic), not a DB CHECK constraint, matching every other
-- taxonomy-shaped column in this codebase (see plan-v1.2-accounts.md §C.2's
-- "no CHECK constraints" rule).
--
-- LANDMINE RECORD (per the master plan's own §A.6 risk note, which calls
-- this out by name): `country_practicalities` needs the SAME catalog
-- re-grant treatment `harden_rls.sql` gave `places`/`arrival_tips`/
-- `experiences`/`place_photos`/`social_posts`/`events`/`city_foods` — i.e.
-- `to anon, authenticated`, never `to anon` alone — if this migration is
-- ever run on a project where `harden_rls.sql` already executed with its OLD
-- table list (`country_practicalities` didn't exist yet when that file was
-- written, so its own Section 1 comment explicitly flags the gap and says
-- "don't forget to add its re-grant when it lands"). THIS FILE IS NOT
-- ACTUALLY AFFECTED by that landmine on a fresh run, because the policy
-- below is written as `to anon, authenticated` from the start — there is no
-- intermediate `to anon`-only state for this table to fall into. The note is
-- here purely so a re-run of `harden_rls.sql` (or a future hardening pass
-- copy-pasted from it) doesn't accidentally re-narrow this policy back to
-- `anon` only.
--
-- Idempotent — safe to re-run.

-- ============================================================================
-- COUNTRY PRACTICALITIES — shared, hand-authored, read-only catalog data.
-- ============================================================================
create table if not exists country_practicalities (
  id uuid primary key default gen_random_uuid(),
  country_code text not null,        -- ISO-2, joins trips.country_code
  city text,                         -- null = country-wide
  topic text not null,               -- connectivity|money|transit|power|water|tipping|safety
  headline text not null,            -- <= 8 words
  detail text not null,
  chat_seed text,                    -- pre-seeds the "Ask Roameo" chat hand-off
  applies_from_days int default -14, -- relative to trip start_date; negative = before landing
  applies_to_days   int default 3,
  priority int default 50,
  review_by date,
  updated_at timestamptz default now()
);

drop index if exists country_practicalities_key;
create unique index country_practicalities_key
  on country_practicalities (country_code, coalesce(city,''), topic);

create index if not exists country_practicalities_country_idx
  on country_practicalities (country_code);

alter table country_practicalities enable row level security;
drop policy if exists "anon_select" on country_practicalities;
drop policy if exists "read_all" on country_practicalities;
create policy "read_all" on country_practicalities for select to anon, authenticated using (true);
-- No write policy — hand-authored catalog data, writes are service-role/
-- dashboard-only (mirrors arrival_tips: no route in the app writes this
-- table, unlike places/events/experiences' live-API-cache writers).

-- ============================================================================
-- PRACTICALITY DISMISSALS — user-scoped. "Already sorted" per topic.
-- ============================================================================
create table if not exists practicality_dismissals (
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  country_code text not null,
  topic text not null,
  dismissed_at timestamptz default now(),
  primary key (user_id, country_code, topic)
);

alter table practicality_dismissals enable row level security;
drop policy if exists "own_rows" on practicality_dismissals;
create policy "own_rows" on practicality_dismissals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
