-- Roameo v1.2 (Accounts) — Phase 2 "Identity + RLS", step 4 of 4 (final).
-- See plan-v1.2-accounts.md §A.6, step 4: "separate file so step 3
-- [harden_rls.sql] stays revertible without also losing the old column."
--
-- DO NOT RUN THIS until supabase/harden_rls.sql has been run successfully
-- and you've confirmed the app still works signed-in (RLS own_rows policies
-- are doing the scoping, not device_id). This file is NOT easily revertible:
-- once device_id is dropped, recovering it means restoring from a backup.
--
-- Idempotent — safe to re-run (every statement is `if exists`).

begin;

-- ============================================================================
-- Redefine the profile-on-signup trigger FIRST, before dropping
-- profiles.device_id below — the version created in add_auth_identity.sql
-- still inserts a synthetic `device_id` placeholder on every new signup, and
-- would start failing on the very next signup after that column is gone if
-- this isn't updated in the same transaction.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ============================================================================
-- DROP device_id from every user-scoped table. Postgres auto-drops any
-- constraint/index defined on a dropped column (including the old
-- device_id-based PRIMARY KEY on profiles/travel_preferences/roameo_rules/
-- user_location) as part of the same statement.
-- ============================================================================
alter table profiles drop column if exists device_id;
alter table travel_preferences drop column if exists device_id;
alter table roameo_rules drop column if exists device_id;
alter table trips drop column if exists device_id;
alter table itinerary_items drop column if exists device_id;
alter table chat_messages drop column if exists device_id;
alter table card_signals drop column if exists device_id;
alter table saved_items drop column if exists device_id;
alter table user_location drop column if exists device_id;

-- ============================================================================
-- profiles / travel_preferences / roameo_rules / user_location lost their
-- primary key along with device_id above (it was defined on that column).
-- Promote the unique index add_auth_identity.sql already created on user_id
-- into the real primary key — `user_id` is guaranteed NOT NULL by
-- harden_rls.sql at this point, so this is a plain, non-rewriting promotion.
-- ============================================================================
alter table profiles add constraint profiles_pkey primary key using index profiles_user_id_key;
alter table travel_preferences add constraint travel_preferences_pkey primary key using index travel_preferences_user_id_key;
alter table roameo_rules add constraint roameo_rules_pkey primary key using index roameo_rules_user_id_key;
alter table user_location add constraint user_location_pkey primary key using index user_location_user_id_key;

-- ============================================================================
-- Drop the now-dead device_id-leading indexes. Most of these were already
-- auto-dropped by Postgres as a side effect of the column drops above (an
-- index can't survive its underlying column disappearing) — these are kept
-- explicit, guarded by `if exists`, purely as documentation of what
-- add_auth_identity.sql's user_id-leading indexes superseded.
-- ============================================================================
drop index if exists trips_device_id_idx;
drop index if exists itinerary_items_device_trip_date_idx;
drop index if exists itinerary_items_starts_at_idx; -- was (device_id, trip_id, starts_at)
drop index if exists chat_messages_device_trip_created_idx;
drop index if exists card_signals_device_created_idx;
drop index if exists card_signals_subject_idx; -- was (device_id, subject_type, subject_id)
drop index if exists saved_items_unique; -- was (device_id, subject_type, subject_id), superseded by saved_items_user_unique

commit;
