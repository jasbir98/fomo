-- Roameo v1.2 (Accounts) — Phase 2 "Identity + RLS", step 3 of 4.
-- See plan-v1.2-accounts.md §A.6 — READ THAT SECTION BEFORE TOUCHING THIS
-- FILE. The ordering inside this single transaction is not cosmetic: running
-- these three sections out of order is exactly the "first signed-in user
-- loses the catalog" outage the plan calls out.
--
-- DO NOT RUN THIS until:
--   1. supabase/add_auth_identity.sql has been run.
--   2. The app has been redeployed with the lib/db/* param swap + the 5
--      request-scoped routes + the /api/places, /api/events, /api/experiences
--      admin-client write paths (all Phase 2 app code).
--   3. You've confirmed a signed-in write lands with a non-null user_id.
--
-- Landmine this migration exists to fix: almost every existing catalog
-- policy is granted `to anon` EXPLICITLY (schema.sql's `places`/
-- `social_posts`, add_now_ranker_tables.sql's `arrival_tips`,
-- add_experiences.sql's `experiences`, add_japan_places_pipeline.sql's
-- `place_photos`, add_japan_tokyo_pipeline.sql's `city_foods`). The instant
-- the first user signs in and their role becomes `authenticated` instead of
-- `anon`, those policies stop applying and the catalog goes dark for that
-- request — before a single line of "hardening" below has even run. Section
-- 1 fixes this FIRST, before anything else in this file touches RLS.
--
-- Destructive step, called out again inline below: Section 3 DELETES any
-- user-table row that still has a null user_id (i.e. every pre-auth
-- device-scoped row) before setting user_id NOT NULL. Per the plan (§A.5):
-- "Don't migrate data. This is pre-launch with dev devices: add user_id,
-- delete anonymous rows, drop device_id." This is intentional and expected
-- to discard today's dev data. If you need to keep any of it, migrate it to
-- a real account BEFORE running this file — there is no undo after commit.

begin;

-- ============================================================================
-- SECTION 1 — CATALOG READS: re-grant to both `anon` and `authenticated`.
-- Must run before anything else in this file. Covers every shared,
-- read-mostly table the app reads regardless of sign-in state.
--
-- NOTE (flagged deviation from the literal Phase 2 task list, matches the
-- master plan's own §A.6 risk writeup instead): `arrival_tips` is included
-- here even though it wasn't named in this phase's file-writing checklist —
-- add_now_ranker_tables.sql:99 grants it `to anon` explicitly, which is
-- exactly the landmine shape this section exists to fix, and the master
-- plan's own risk list (§A.6) names `arrival_tips` alongside `places` and
-- `social_posts` as verified-vulnerable. Omitting it would leave the Home
-- cold-start hero dark for the first signed-in user. `country_practicalities`
-- is skipped, per instructions — that table doesn't exist until a later,
-- not-yet-built phase; don't forget to add its re-grant when it lands.
-- ============================================================================

drop policy if exists "anon_select" on places;
drop policy if exists "anon_write" on places;
create policy "read_all" on places for select to anon, authenticated using (true);

drop policy if exists "anon_select" on place_photos;
create policy "read_all" on place_photos for select to anon, authenticated using (true);
-- place_photos' anon_write policy is intentionally left untouched — the
-- Japan places pipeline scripts write to it directly with the anon key and
-- are out of scope for this phase's service-role migration.

drop policy if exists "anon_select" on social_posts;
drop policy if exists "anon_all" on social_posts;
create policy "read_all" on social_posts for select to anon, authenticated using (true);
-- social_posts' old "anon_all" policy did double duty (read AND write for
-- anon) — unlike place_photos/city_foods, it was never split into separate
-- select/write policies. Re-create the write half so the offline Playwright
-- reel scraper (scraper/) keeps working; only the read half is broadened.
create policy "anon_write" on social_posts for all to anon using (true) with check (true);

drop policy if exists anon_select on events;
drop policy if exists anon_write on events;
create policy "read_all" on events for select to anon, authenticated using (true);
-- events' write policy is NOT re-created — /api/events moves to the
-- service-role client in Section 2 below, so no anon/authenticated role
-- needs write access to this table anymore.

drop policy if exists "anon_select" on experiences;
drop policy if exists "anon_write" on experiences;
create policy "read_all" on experiences for select to anon, authenticated using (true);
-- Same as events: /api/experiences moves to service-role in Section 2, so no
-- anon/authenticated write policy is re-created here.

drop policy if exists "anon_select" on city_foods;
create policy "read_all" on city_foods for select to anon, authenticated using (true);
-- city_foods' anon_write policy is intentionally left untouched, same reason
-- as place_photos: the Tokyo pipeline's promotion scripts write to it
-- directly with the anon key.

drop policy if exists "anon_select" on arrival_tips;
create policy "read_all" on arrival_tips for select to anon, authenticated using (true);
-- arrival_tips has no write policy (read-only table) — nothing to preserve.

drop policy if exists "read_all" on happenings;
create policy "read_all" on happenings for select to anon, authenticated using (true);
-- happenings has no write policy (service-role only) — nothing to preserve.
-- (Not actually affected by the landmine this section fixes: add_happenings.sql
-- writes the policy as `to anon, authenticated` from the start, same as
-- country_practicalities. Re-grant kept here anyway, per this section's own
-- note above about not forgetting new catalog tables when they land.)

drop policy if exists "read_all" on happening_sources;
create policy "read_all" on happening_sources for select to anon, authenticated using (true);
-- happening_sources has no write policy (service-role only) — nothing to preserve.

-- ============================================================================
-- SECTION 2 — CATALOG WRITES: move places/events/experiences writes to the
-- service role. These are the three tables with an app-owned route handler
-- (/api/places, /api/events, /api/experiences) that writes live provider
-- results back into the cache. Once those routes are redeployed to use
-- lib/supabase/admin.ts's service-role client (which bypasses RLS entirely),
-- no anon/authenticated write policy is needed on these three tables at
-- all — the drops in Section 1 above already removed their anon_write
-- policies, so this section is confirming the end state, not doing new work.
-- Catalog becomes read-only to every non-service caller, which is the
-- correct end state per the plan.
-- ============================================================================
-- (No SQL here — the anon_write drops for places/events/experiences already
-- happened in Section 1, deliberately not re-created. This section exists so
-- the file's structure mirrors the plan's own §A.6 three-part sequence
-- exactly; see the app-code changes to app/api/{places,events,experiences}/
-- route.ts shipped alongside this migration.)

-- ============================================================================
-- SECTION 3 — USER TABLES: delete anonymous rows, require user_id, drop the
-- old anon_all policies, add owner-scoped policies for `authenticated` only.
-- Anon can no longer read or write any of these tables after this section —
-- there is no guest mode in this app (plan §"Decisions taken").
-- ============================================================================

-- --- profiles ---------------------------------------------------------------
delete from profiles where user_id is null;
alter table profiles alter column user_id set not null;
alter table profiles alter column user_id set default auth.uid();
drop policy if exists "anon_all" on profiles;
create policy "own_rows" on profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- travel_preferences ------------------------------------------------------
delete from travel_preferences where user_id is null;
alter table travel_preferences alter column user_id set not null;
alter table travel_preferences alter column user_id set default auth.uid();
drop policy if exists "anon_all" on travel_preferences;
create policy "own_rows" on travel_preferences for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- roameo_rules -------------------------------------------------------------
delete from roameo_rules where user_id is null;
alter table roameo_rules alter column user_id set not null;
alter table roameo_rules alter column user_id set default auth.uid();
drop policy if exists "anon_all" on roameo_rules;
create policy "own_rows" on roameo_rules for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- trips --------------------------------------------------------------------
delete from trips where user_id is null;
alter table trips alter column user_id set not null;
alter table trips alter column user_id set default auth.uid();
drop policy if exists "anon_all" on trips;
create policy "own_rows" on trips for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- itinerary_items ------------------------------------------------------------
delete from itinerary_items where user_id is null;
alter table itinerary_items alter column user_id set not null;
alter table itinerary_items alter column user_id set default auth.uid();
drop policy if exists "anon_all" on itinerary_items;
create policy "own_rows" on itinerary_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- chat_messages ---------------------------------------------------------------
delete from chat_messages where user_id is null;
alter table chat_messages alter column user_id set not null;
alter table chat_messages alter column user_id set default auth.uid();
drop policy if exists "anon_all" on chat_messages;
create policy "own_rows" on chat_messages for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- card_signals -------------------------------------------------------------------
delete from card_signals where user_id is null;
alter table card_signals alter column user_id set not null;
alter table card_signals alter column user_id set default auth.uid();
drop policy if exists "anon_all" on card_signals;
create policy "own_rows" on card_signals for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- saved_items ---------------------------------------------------------------------
delete from saved_items where user_id is null;
alter table saved_items alter column user_id set not null;
alter table saved_items alter column user_id set default auth.uid();
drop policy if exists "anon_all" on saved_items;
create policy "own_rows" on saved_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --- user_location (renamed from device_location in add_auth_identity.sql) -----------
delete from user_location where user_id is null;
alter table user_location alter column user_id set not null;
alter table user_location alter column user_id set default auth.uid();
drop policy if exists "anon_all" on user_location;
create policy "own_rows" on user_location for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
-- STORAGE: avatars bucket tightens from "any anon caller, any path" to
-- "only the authenticated owner of the path's first folder segment" — see
-- plan §A.5: `uploadAvatar` (lib/db/profile.ts) switches its storage key from
-- `${deviceId}/…` to `${userId}/…` in this phase's app deploy, so
-- `(storage.foldername(name))[1]` is a user id from here on.
-- ============================================================================
drop policy if exists "avatars_anon_all" on storage.objects;
create policy "avatars_own_folder" on storage.objects for all to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

commit;
