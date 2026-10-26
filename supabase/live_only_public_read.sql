-- live_only_public_read.sql — public read of happenings and events becomes live-only.
--
-- What: replaces the "read it all" select policies with ones that only expose
-- rows that are meant to be shown.
--   happenings  read_all (using true)  ->  read_live    (status = 'live')
--   events      anon_select / read_all ->  read_active  (status = 'active')
-- Both for select, to anon + authenticated. Writes stay service-role only
-- (no write policy, as before).
--
-- Why: the anon key ships in the browser, so until now anyone holding it could
-- list every dormant or retired happening and every expired, gone or cancelled
-- event straight from PostgREST. Those rows are hidden from the app on purpose
-- (soft-retired, see add_event_lifecycle.sql); they only need to stay reachable
-- BY ID for shared links, Saved items and weekend plans, which the app now does
-- on the server with the service role (supabaseAdmin(), bypasses RLS):
-- the happening page/API/.ics, the event page, GET /api/events/[id] and its
-- .ics, GET /api/saved (lib/cards/resolve.ts) and lib/plans/snapshot.ts.
--
-- Run by hand in the Supabase SQL editor AFTER this PR is deployed.
-- The order matters: once the code reads hidden rows through the service role,
-- tightening the policy breaks nothing. Run it BEFORE the deploy and ended
-- items opened from shared links and Saved would come back "not found"
-- (and the old browser-side event read would return null for non-active rows).
--
-- Idempotent — safe to re-run. Postgres ORs permissive policies together, so
-- every older permissive select policy on these tables is dropped here too
-- (names found in archive/add_happenings.sql, archive/add_events.sql and
-- archive/harden_rls.sql: "read_all", anon_select).

-- 1. happenings
alter table happenings enable row level security;
drop policy if exists "read_all" on happenings;
drop policy if exists "read_live" on happenings;
create policy "read_live" on happenings
  for select to anon, authenticated
  using (status = 'live');

-- 2. events
alter table events enable row level security;
drop policy if exists anon_select on events;
drop policy if exists "read_all" on events;
drop policy if exists "read_active" on events;
create policy "read_active" on events
  for select to anon, authenticated
  using (status = 'active');

-- Verify (read-only). Each table should list exactly one select policy, with
-- the status condition in qual, and no `true` / `anon_write` / `read_all` left:
--
--   select tablename, policyname, cmd, roles, qual
--   from pg_policies
--   where tablename in ('happenings','events')
--   order by tablename, policyname;
--
-- Expect:
--   events      | read_active | SELECT | {anon,authenticated} | (status = 'active'::text)
--   happenings  | read_live   | SELECT | {anon,authenticated} | (status = 'live'::text)
--
-- And as the anon key (REST: GET /rest/v1/happenings?select=id,status), no
-- row with status other than 'live' / events with status other than 'active'
-- should come back. Then run verify_security.sql.
