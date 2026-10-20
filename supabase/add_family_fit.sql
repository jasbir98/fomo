-- add_family_fit.sql — the "with kids" lens: a `family_fit` column on every
-- content table. See docs/plans/2026-10-20-families-lens.md.
--
-- MUST BE RUN BY HAND in the Supabase SQL editor (nothing in the repo applies
-- migrations). Idempotent — safe to re-run. Safe to deploy the app BEFORE this
-- runs: the app reads every one of these tables with `select *`, so a missing
-- column just reads as undefined (treated as "unknown"). Run it before the
-- classification pipeline (scripts/ + scraper/) starts writing family_fit, or
-- those writes will fail on the missing column.
--
-- family_fit (text, nullable):
--   'kids'     aimed at children — Bookbug rhyme time, soft play, a kids'
--              workshop, "kids eat free".
--   'all_ages' good with kids but for anyone — free museums, the Botanics,
--              Christmas lights.
--   null       not for kids, or not yet classified.
-- Added to: happenings, happenings_staging, events, places, places_staging.
-- The app reads it only through lib/happenings/family.ts.
--
-- Nothing to do here for the new happenings eligibility value 'family' ("kids
-- eat free", "under-5s swim free"): there is no CHECK constraint on
-- happenings.eligibility (it is free text, enforced in code by the
-- HappeningEligibility union in lib/happenings/types.ts), so the value needs no
-- SQL.
--
-- Existing RLS on these tables already covers a new column (public-read on
-- happenings/events/places; staging tables stay service-role only).

-- 1. Columns
alter table public.happenings         add column if not exists family_fit text;
alter table public.happenings_staging add column if not exists family_fit text;
alter table public.events             add column if not exists family_fit text;
alter table public.places             add column if not exists family_fit text;
alter table public.places_staging     add column if not exists family_fit text;

-- 2. CHECK constraints (added only if missing, so re-runs don't error)
do $$
declare
  t text;
begin
  foreach t in array array['happenings', 'happenings_staging', 'events', 'places', 'places_staging']
  loop
    if not exists (
      select 1 from pg_constraint
      where conname = t || '_family_fit_check'
        and conrelid = ('public.' || t)::regclass
    ) then
      execute format(
        'alter table public.%I add constraint %I check (family_fit is null or family_fit in (''kids'', ''all_ages''))',
        t, t || '_family_fit_check'
      );
    end if;
  end loop;
end $$;

-- 3. Partial indexes — only the (small) classified subset is indexed
create index if not exists happenings_family_fit_idx on public.happenings (family_fit) where family_fit is not null;
create index if not exists events_family_fit_idx     on public.events (family_fit)     where family_fit is not null;
create index if not exists places_family_fit_idx     on public.places (family_fit)     where family_fit is not null;

-- 4. Verify: one row per table, all five should show has_family_fit = true,
--    has_check = true. (The SQL editor shows only the last statement's result,
--    hence a single result set.)
select
  t.table_name,
  exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'family_fit'
  ) as has_family_fit,
  exists (
    select 1 from pg_constraint k
    where k.conname = t.table_name || '_family_fit_check'
      and k.conrelid = ('public.' || t.table_name)::regclass
  ) as has_check
from (values ('happenings'), ('happenings_staging'), ('events'), ('places'), ('places_staging')) as t(table_name)
order by t.table_name;
