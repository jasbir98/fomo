-- Roameo v1.2 (Accounts) — Phase 2 "Identity + RLS", step 1 of 4.
-- See plan-v1.2-accounts.md §A.5, §A.6 (sequencing table) and §F (build
-- sequence, Phase 2 row).
--
-- SAFE TO RUN NOW, before any app code changes. Every `user_id` column added
-- here is NULLABLE and every existing anon_all/anon_select RLS policy is left
-- completely untouched — this migration only adds columns, defaults,
-- indexes, and a trigger. The app keeps working exactly as it does today
-- (device_id-scoped, wide-open anon RLS) until the NEXT deploy lands the
-- lib/db/* param swap + the 5 request-scoped routes.
--
-- Run this FIRST, in this exact order relative to the rest of Phase 2:
--   1. Run this file.
--   2. Deploy the app code (lib/db/* param swap, request-scoped routes,
--      updated call sites).
--   3. Verify: sign in, create/edit something, then confirm
--      `select user_id from trips order by created_at desc limit 1;`
--      (or any other user table) returns a non-null uuid.
--   4. Only then run supabase/harden_rls.sql.
--   5. Only then run supabase/drop_device_id.sql.
--
-- Idempotent — safe to re-run.

begin;

-- ============================================================================
-- device_location -> user_location (plan §A.5: "it is per-user now, and the
-- old name becomes actively misleading"). Renamed here, in the SAME
-- migration that adds user_id, so there is never a window where the table
-- exists under the old name with the new column, or under the new name with
-- only the old column. `lib/db/location.ts`'s `.from("device_location")`
-- call must change to `.from("user_location")` in the app deploy that
-- follows this file — flagged prominently in this phase's report.
-- ============================================================================
alter table if exists device_location rename to user_location;

-- ============================================================================
-- USER_ID COLUMNS — nullable for now. `default auth.uid()` means an
-- authenticated insert that omits user_id (every lib/db/* insert helper,
-- once the param-swap deploy lands) gets it filled in automatically by
-- PostgREST from the request's JWT; an anon (no-JWT) insert still gets null,
-- identical to today's behaviour. `on delete cascade` mirrors trips'
-- existing cascade-on-trip-delete pattern (schema.sql) — deleting an
-- auth.users row cleans up everything it owns.
-- ============================================================================
alter table profiles
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table profiles alter column user_id set default auth.uid();

alter table travel_preferences
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table travel_preferences alter column user_id set default auth.uid();

alter table roameo_rules
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table roameo_rules alter column user_id set default auth.uid();

alter table trips
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table trips alter column user_id set default auth.uid();

alter table itinerary_items
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table itinerary_items alter column user_id set default auth.uid();

alter table chat_messages
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table chat_messages alter column user_id set default auth.uid();

alter table card_signals
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table card_signals alter column user_id set default auth.uid();

alter table saved_items
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table saved_items alter column user_id set default auth.uid();

alter table user_location
  add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table user_location alter column user_id set default auth.uid();

-- ============================================================================
-- INDEXES — user_id-leading, mirroring/superseding the device_id-leading ones
-- from schema.sql / add_now_ranker_tables.sql. The old device_id indexes are
-- left in place here (dropped in drop_device_id.sql, alongside the column
-- itself) so nothing regresses before this migration's code deploy lands.
--
-- All of these are safe to create now even though user_id is mostly NULL:
-- Postgres treats NULL as distinct in a unique index, so many NULL-user_id
-- rows coexist without conflicting — the same reasoning already used by
-- saved_items_unique (add_now_ranker_tables.sql) and
-- places_google_place_id_key (add_places_columns.sql).
-- ============================================================================
create index if not exists trips_user_id_idx on trips(user_id);
create index if not exists itinerary_items_user_trip_date_idx
  on itinerary_items(user_id, trip_id, day_date);
create index if not exists itinerary_items_user_trip_starts_idx
  on itinerary_items(user_id, trip_id, starts_at);
create index if not exists chat_messages_user_trip_created_idx
  on chat_messages(user_id, trip_id, created_at);
create index if not exists card_signals_user_created_idx
  on card_signals(user_id, created_at desc);
create index if not exists card_signals_user_subject_idx
  on card_signals(user_id, subject_type, subject_id);

-- Plain (non-partial) unique index — on_conflict-compatibility reasoning
-- mirrors saved_items_unique / places_google_place_id_key /
-- experiences_provider_product_key elsewhere in this folder: PostgREST's
-- upsert on_conflict needs a full index, not a partial one.
create unique index if not exists saved_items_user_unique
  on saved_items(user_id, subject_type, subject_id);

-- profiles / travel_preferences / roameo_rules / user_location are still
-- keyed by their old device_id PK at this point in the sequence — these
-- unique indexes are what upsertProfile/upsertPreferences/upsertRules/
-- upsertUserLocation switch their `onConflict` target to once the code
-- deploys, and what drop_device_id.sql later promotes into the real primary
-- key once device_id is gone.
create unique index if not exists profiles_user_id_key on profiles(user_id);
create unique index if not exists travel_preferences_user_id_key on travel_preferences(user_id);
create unique index if not exists roameo_rules_user_id_key on roameo_rules(user_id);
create unique index if not exists user_location_user_id_key on user_location(user_id);

-- ============================================================================
-- PROFILE-ON-SIGNUP TRIGGER — every auth.users row gets a matching
-- `profiles` row automatically, so getProfile/upsertProfile always have
-- something to work with post-cutover (today NOTHING ever creates a
-- `profiles` row at all — see fix_profile_fk.sql's comment for the history
-- of that gap). `device_id` is still `not null primary key` at this point in
-- the sequence, so this synthesizes a harmless, never-read placeholder
-- (`'auth:' || new.id`) rather than leaving it null. drop_device_id.sql
-- redefines this function to drop the placeholder once the column is gone.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (device_id, user_id)
  values ('auth:' || new.id::text, new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

commit;
