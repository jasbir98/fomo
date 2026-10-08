-- add_event_lifecycle.sql — event lifecycle (soft-retire) + per-source run log.
-- See docs/plans/2026-10-08-event-and-deal-coverage.md (Phases 1-2).
--
-- Run once, by hand, in the Supabase SQL editor BEFORE deploying the app change
-- that filters the feed on events.status. Idempotent — safe to re-run.
--
-- events:
--   last_seen_at  stamped on every upsert by scripts/daily-sources.mjs.
--   status        active | cancelled | gone | expired. Nothing is ever deleted:
--                 expired = the event is over; gone = a healthy source stopped
--                 listing a future event; cancelled = the source says so. A row
--                 that reappears in its source is flipped back to active by the
--                 next upsert. The feed shows only 'active'; detail pages and
--                 saved items still resolve every status.
--   enriched_at   when venue/photo enrichment last looked at the row.
-- event_source_runs: one row per adapter per --write run (service role only);
--   feeds the retirement health gate and the "Source health" summary.
--
-- Existing RLS on events (read_all for anon + authenticated, no write policy)
-- already covers the new columns; events stays public-read.

-- 1. events columns
alter table events add column if not exists last_seen_at timestamptz;
alter table events add column if not exists status text not null default 'active';
alter table events add column if not exists enriched_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_status_check' and conrelid = 'events'::regclass
  ) then
    alter table events
      add constraint events_status_check check (status in ('active', 'cancelled', 'gone', 'expired'));
  end if;
end $$;

create index if not exists events_status_starts_idx on events (status, starts_at);

-- 2. Backfill. Rows already in the table were last seen when fetched; anything
--    already over is expired.
update events set last_seen_at = fetched_at where last_seen_at is null;
update events
   set status = 'expired'
 where status = 'active'
   and coalesce(ends_at, starts_at) < now();

-- 3. Run log
create table if not exists event_source_runs (
  id          bigserial primary key,
  run_id      text not null,
  provider    text not null,
  started_at  timestamptz not null default now(),
  ok          boolean not null,
  status      text,            -- 'live' | 'shadow'
  fetched     int,
  kept        int,
  inserted    int,
  updated     int,
  rejected    jsonb,           -- { reason: count }, incl. image_broken
  error       text
);

create index if not exists event_source_runs_provider_started_idx
  on event_source_runs (provider, started_at desc);

-- Service role only: RLS on, deliberately no policies.
alter table event_source_runs enable row level security;
