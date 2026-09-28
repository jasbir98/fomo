-- Fomo — decouple `chat_messages` from `trips`.
--
-- WHY
-- Fomo is removing the trip-planning layer: there are no trips, no
-- destinations and no itineraries, just one city (Edinburgh). Chat survives
-- the pivot — "Ask Fomo" is reachable from every card and answers exactly the
-- questions a deal raises ("do I need a code?", "am I actually eligible?",
-- "is this still on?").
--
-- But `chat_messages.trip_id` is `uuid NOT NULL references trips(id)`
-- (schema.sql:102). Once nothing creates trips, there is no trip id to supply,
-- and every chat insert fails. There is no code-only way around a NOT NULL
-- column — you cannot insert null into it — so this has to be a migration.
--
-- WHAT CHANGES
-- Chat becomes **user-scoped** instead of trip-scoped, which is what it
-- actually is now: one ongoing conversation per person about one city.
-- `trip_id` is relaxed rather than dropped, so this migration stays
-- non-destructive and reversible on its own.
--
-- SAFETY
-- This is deliberately NOT the same class of change as dropping `trips` /
-- `itinerary_items`, which is being held back until the code removal has
-- shipped and been verified (see supabase/remove_trips.sql, not yet written).
-- Relaxing a NOT NULL and dropping a foreign key destroys no data and can be
-- reverted by re-adding both. Verified before writing this: `chat_messages`
-- currently holds **0 rows**, so there is also nothing to backfill or orphan.
--
-- `trip_id` itself is left in place, unused and nullable. It gets dropped
-- later alongside `saved_items.trip_id` and `card_signals.trip_id` in the
-- eventual remove_trips.sql, so that every column-drop lands in one reviewed
-- migration rather than being scattered.
--
-- Run once in the Supabase SQL Editor. Idempotent — safe to re-run.

-- 1. Allow inserts that carry no trip.
alter table chat_messages alter column trip_id drop not null;

-- 2. Drop the FK so the column can outlive the `trips` table it points at.
--    Named constraint first (Postgres' default name), then a catch-all for
--    projects where it was created under a different name.
alter table chat_messages drop constraint if exists chat_messages_trip_id_fkey;

do $$
declare
  c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'chat_messages'::regclass
    and contype = 'f'
    and pg_get_constraintdef(oid) ilike '%references trips%';
  if c is not null then
    execute format('alter table chat_messages drop constraint %I', c);
  end if;
end $$;

-- 3. Chat now lists by user, not by trip. The old composite index
--    (device_id, trip_id, created_at) predates both the auth migration that
--    replaced device_id with user_id and this change, so it can no longer
--    serve the read path. Left in place rather than dropped — it is harmless
--    on an empty table and removing it belongs with the other cleanup.
create index if not exists chat_messages_user_created_idx
  on chat_messages (user_id, created_at);
