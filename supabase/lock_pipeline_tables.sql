-- Roameo — lock down the pipeline tables the public anon key could write to.
--
-- SECURITY FINDING this migration closes: `places_staging`, `city_foods_staging`,
-- `happenings_staging`, `scraped_reels` (anon_all — read AND write in one
-- policy), plus `place_photos`, `place_sources`, `city_foods`, `social_posts`
-- (anon_write) were all writable by anyone holding the public anon key, which
-- ships to every browser. Staging rows get promoted into the live catalog
-- (see scripts/promote-japan-places.mjs, scripts/promote-happenings.mjs), so
-- a malicious anon write was a path to planting content in the app.
--
-- RUN ORDER:
--   1. Land the code changes that switch every pipeline WRITER of these 8
--      tables to SUPABASE_SERVICE_ROLE_KEY (scraper/upsert_supabase.py,
--      scraper/upsert_japan_places.py, scraper/upload_kanto_places.py,
--      scraper/photos_wikimedia.py, scripts/promote-japan-places.mjs — see
--      this change's PR/report for the full writer inventory) and confirm
--      SUPABASE_SERVICE_ROLE_KEY is actually available to those scripts
--      (scraper/.env or the repo-root .env.local).
--   2. THEN run this file in the Supabase SQL editor.
--   3. Run the verification queries at the bottom and confirm anon/
--      authenticated have no write access anywhere it shouldn't.
--
-- If this file runs BEFORE step 1's code is in use, every pipeline script
-- still on the anon key starts failing (401/403) the next time it writes —
-- by design (that's the anon key losing write access this migration exists
-- to enforce), but it means "run the code changes first" is a hard
-- prerequisite, not just tidiness. scripts/promote-happenings.mjs and
-- scraper/link_happenings_places.py already only ever used the service-role
-- key for `happenings_staging`, so they are unaffected either way.
--
-- This migration does not depend on supabase/harden_rls.sql having been run
-- first — every DROP below uses `if exists` and names every policy that
-- table has ever had (across schema.sql / add_*.sql / harden_rls.sql), so
-- this is safe to run whether or not harden_rls.sql has already landed.

begin;

-- ============================================================================
-- SECTION 1 — STAGING + RAW-SCRAPE TABLES: no anon/authenticated access at
-- all, read or write. Only the service-role key (which bypasses RLS
-- entirely) can touch these. Nothing here is ever read by the app.
-- ============================================================================

-- --- places_staging ----------------------------------------------------------
drop policy if exists "anon_select" on places_staging;
drop policy if exists "anon_write" on places_staging;
alter table places_staging enable row level security;

-- --- city_foods_staging -------------------------------------------------------
drop policy if exists "anon_select" on city_foods_staging;
drop policy if exists "anon_write" on city_foods_staging;
alter table city_foods_staging enable row level security;

-- --- happenings_staging --------------------------------------------------------
drop policy if exists "read_all" on happenings_staging;
drop policy if exists "anon_write" on happenings_staging;
alter table happenings_staging enable row level security;

-- --- scraped_reels ---------------------------------------------------------------
-- Had one combined "anon_all" policy (read AND write) — drop it entirely,
-- nothing recreated. classify_reels.py's fetch_unclassified()/fetch_approved()
-- already move to the service-role key alongside its writes.
drop policy if exists "anon_all" on scraped_reels;
alter table scraped_reels enable row level security;

-- ============================================================================
-- SECTION 2 — TABLES THE APP READS: keep/ensure a read-only `select` policy
-- for both anon and authenticated (so the app keeps working signed-out and
-- signed-in — see harden_rls.sql's landmine note), drop every anon WRITE
-- policy. Only the service-role key (pipeline promote/enrich scripts) can
-- write to these from here on.
-- ============================================================================

-- --- social_posts (Reels feed — lib/db/social.ts) -----------------------------
drop policy if exists "anon_select" on social_posts;
drop policy if exists "anon_all" on social_posts;
drop policy if exists "anon_write" on social_posts;
drop policy if exists "read_all" on social_posts;
create policy "read_all" on social_posts for select to anon, authenticated using (true);
alter table social_posts enable row level security;

-- --- place_photos (place detail carousel + list-view thumbnail — lib/db/places.ts) ---
drop policy if exists "anon_select" on place_photos;
drop policy if exists "anon_write" on place_photos;
drop policy if exists "read_all" on place_photos;
create policy "read_all" on place_photos for select to anon, authenticated using (true);
alter table place_photos enable row level security;

-- --- place_sources (per-field citation provenance) -----------------------------
-- Not read by any app route today, but kept readable (not just service-role)
-- per the pipeline's existing pattern for provenance tables — cheap to grant,
-- and matches place_photos/city_foods rather than being a special case.
drop policy if exists "anon_select" on place_sources;
drop policy if exists "anon_write" on place_sources;
drop policy if exists "read_all" on place_sources;
create policy "read_all" on place_sources for select to anon, authenticated using (true);
alter table place_sources enable row level security;

-- --- city_foods (Tokyo pipeline's food listings) --------------------------------
drop policy if exists "anon_select" on city_foods;
drop policy if exists "anon_write" on city_foods;
drop policy if exists "read_all" on city_foods;
create policy "read_all" on city_foods for select to anon, authenticated using (true);
alter table city_foods enable row level security;

-- ============================================================================
-- SECTION 3 — BELT AND SUSPENDERS: revoke the underlying table-level write
-- grants too, not just the RLS policies. Supabase grants anon/authenticated
-- broad table privileges by default; with RLS enabled and no matching
-- policy, an operation is already denied — this just means a write stays
-- denied even if RLS is ever disabled or a future migration re-grants
-- broadly, on any of these 8 tables. Service role bypasses both RLS and
-- table grants, so pipeline writes are unaffected.
-- ============================================================================

revoke insert, update, delete on places_staging from anon, authenticated;
revoke insert, update, delete on city_foods_staging from anon, authenticated;
revoke insert, update, delete on happenings_staging from anon, authenticated;
revoke insert, update, delete on scraped_reels from anon, authenticated;
revoke insert, update, delete on place_photos from anon, authenticated;
revoke insert, update, delete on place_sources from anon, authenticated;
revoke insert, update, delete on city_foods from anon, authenticated;
revoke insert, update, delete on social_posts from anon, authenticated;

commit;

-- ============================================================================
-- VERIFICATION — run these after commit. Expect:
--   * Section A: only "read_all" (select, anon+authenticated) on
--     social_posts/place_photos/place_sources/city_foods; ZERO rows for
--     places_staging/city_foods_staging/happenings_staging/scraped_reels.
--   * Section B: zero rows (no anon/authenticated insert/update/delete
--     table-level grant survives on any of the 8).
--   * Section C: avatars storage — only "avatars_own_folder" (authenticated,
--     own-folder-scoped); no anon policy at all.
--   * Section D: places/events/experiences already locked by harden_rls.sql —
--     the pg_policies query returns zero rows (no anon/authenticated write
--     policy on the live catalog). The grants query MAY still return rows:
--     Supabase grants anon/authenticated table privileges by default, and
--     RLS with no write policy is what actually denies the write. Only a
--     write policy showing up in the first query is a problem.
-- ============================================================================

-- -- Section A: policies left on the 8 pipeline tables
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_policies
-- where tablename in (
--   'places_staging', 'city_foods_staging', 'happenings_staging', 'scraped_reels',
--   'place_photos', 'place_sources', 'city_foods', 'social_posts'
-- )
-- order by tablename, policyname;

-- -- Section B: table-level grants surviving for anon/authenticated
-- select table_name, grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in (
--     'places_staging', 'city_foods_staging', 'happenings_staging', 'scraped_reels',
--     'place_photos', 'place_sources', 'city_foods', 'social_posts'
--   )
--   and grantee in ('anon', 'authenticated')
--   and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
-- order by table_name, grantee, privilege_type;

-- -- Section C: avatars storage bucket policies
-- select policyname, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'storage' and tablename = 'objects'
--   and (qual ilike '%avatars%' or with_check ilike '%avatars%');

-- -- Section D: catalog tables already locked by harden_rls.sql — confirm no
-- -- anon/authenticated write policy or grant survives.
-- select tablename, policyname, roles, cmd
-- from pg_policies
-- where tablename in ('places', 'events', 'experiences')
--   and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
--
-- select table_name, grantee, privilege_type
-- from information_schema.role_table_grants
-- where table_schema = 'public'
--   and table_name in ('places', 'events', 'experiences')
--   and grantee in ('anon', 'authenticated')
--   and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
