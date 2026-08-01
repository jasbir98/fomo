-- Roameo v1: "right now" pivot, part 1 — real itinerary timestamps.
--
-- `itinerary_items.time_label` is free text ("7:00 AM", "Morning", "after
-- lunch") and `day_date` is a bare date. Neither can be compared against a
-- clock, so nothing that needs to know "what's happening right now" or "how
-- long until the next thing" or "how big is this gap" can be computed from
-- the existing columns. This is the blocking migration for the whole v1
-- Home/Plan rebuild — see plan-v1-home-pivot.md §10.1.
--
-- Adds `starts_at` (nullable timestamptz) and `duration_minutes` (nullable
-- int), then best-effort backfills `starts_at` by parsing `time_label`
-- against `day_date` for existing rows. `time_label` is NOT removed or
-- deprecated — it stays as the source of user-facing display text (it can
-- say "Morning" or "After lunch", which a timestamp can't), and stays the
-- field the add/edit item forms write to. `starts_at` is a derived,
-- best-effort clock value for ranking/gap-math only.
--
-- No trip timezone is tracked anywhere in this app (destination is a free
-- text string). `starts_at` is therefore stored as the wall-clock time
-- interpreted as UTC — i.e. "7:00 AM" on day_date becomes
-- `<day_date>T07:00:00Z` regardless of the trip's real timezone. This is a
-- deliberate simplification consistent with how day_date/time_label already
-- work (no tz anywhere else in the schema either): every comparison the
-- ranker does (gap length, "is this now", "leave by") is relative to other
-- itinerary_items rows and to the device's own wall clock read the same way,
-- so the missing real-tz offset cancels out for same-trip comparisons. It
-- would only matter for cross-timezone features (none exist in v1).
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql has already been applied. Idempotent — safe to re-run (backfill
-- only touches rows where starts_at is still null).

alter table itinerary_items add column if not exists starts_at timestamptz;
alter table itinerary_items add column if not exists duration_minutes int;

create index if not exists itinerary_items_starts_at_idx
  on itinerary_items (device_id, trip_id, starts_at);

-- Best-effort backfill. Handles the two time_label shapes actually written
-- by this codebase today:
--   lib/db/items.ts seedTokyoItineraryItems -> "7:00 AM" / "12:30 PM" (12h)
--   app/plan/add (user-entered) -> whatever the <input type="time"> gives,
--     which browsers render as "HH:MM" (24h) once normalized, but users can
--     also free-type into older rows, hence the two-pattern attempt below.
-- Rows that match neither pattern are left with starts_at = null and are
-- treated by the ranker as unscheduled (they still render on the Plan day,
-- they just don't create or close a gap, and can't become "current
-- activity"). That is the correct, safe failure mode — never guess a time.
do $$
declare
  r record;
  parsed timestamp;
begin
  for r in
    select id, day_date, time_label
    from itinerary_items
    where starts_at is null
      and day_date is not null
      and time_label is not null
      and btrim(time_label) <> ''
  loop
    parsed := null;

    begin
      parsed := to_timestamp(
        r.day_date::text || ' ' || btrim(r.time_label),
        'YYYY-MM-DD HH12:MI AM'
      );
    exception when others then
      parsed := null;
    end;

    if parsed is null then
      begin
        parsed := to_timestamp(
          r.day_date::text || ' ' || btrim(r.time_label),
          'YYYY-MM-DD HH24:MI'
        );
      exception when others then
        parsed := null;
      end;
    end if;

    if parsed is not null then
      update itinerary_items
      set starts_at = parsed at time zone 'UTC'
      where id = r.id;
    end if;
  end loop;
end $$;
