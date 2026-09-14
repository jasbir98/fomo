-- Roameo v1.2 (Accounts) — Phase 8 "Cleanup". See plan-v1.2-accounts.md §C.2
-- ("Three sliders die and are not mourned") and §F's Phase 8 row.
--
-- DO NOT RUN THIS until:
--   1. supabase/add_person_persona.sql has been run AND its backfill
--      section (the second half of that file — luxury_backpacker ->
--      budget_band, mobility -> walk_tolerance, interests -> interest_tags)
--      has actually executed against this project's data.
--   2. You've verified the backfill landed, e.g.:
--      `select count(*) from travel_preferences
--       where budget_band is null and walk_tolerance is null
--         and (interest_tags is null or interest_tags = '{}')
--         and (luxury_backpacker is not null or mobility is not null
--              or (interests is not null and array_length(interests, 1) > 0));`
--      returns 0 — every row that had legacy data worth keeping has a
--      new-column equivalent (or the legacy value was genuinely unmappable,
--      e.g. luxury_backpacker = 3, and dropping it is correct).
--   3. The app has been redeployed with the code that reads the NEW columns
--      instead of these — app/api/chat/route.ts's "Travel DNA" prompt
--      builder and app/(shell)/profile/page.tsx's Travel DNA card both
--      switched from the five columns below to budget_band/walk_tolerance/
--      pace/day_rhythm/interest_tags in the same commit that adds this file.
--
-- This is genuinely destructive: it drops five columns that carry real
-- backfilled data from Phase 5's migration (supabase/add_person_persona.sql),
-- with no undo after commit.
--
-- `languages` is deliberately NOT one of the five — it has no replacement
-- column anywhere in this project and stays untouched.
--
-- Idempotent — safe to re-run (every statement is `drop column if exists`).

alter table travel_preferences drop column if exists luxury_backpacker;
alter table travel_preferences drop column if exists planned_spontaneous;
alter table travel_preferences drop column if exists foodie_utilitarian;
alter table travel_preferences drop column if exists mobility;
alter table travel_preferences drop column if exists interests;
