-- Roameo v1: itinerary items ↔ places link-back.
-- Adds a nullable `place_id` FK to `itinerary_items` so the item detail view
-- (app/plan/item/[id]) can look up the underlying `places` row and render
-- its photo + description, instead of only the title/category/date/time/
-- location fields itinerary_items itself stores.
--
-- Nullable, not required: manually-created itinerary items (the "Add Note" /
-- "Add Reservation" / blank "Find a Spot" form at app/plan/item/[id] with
-- id === "new" and no upstream place lookup) have no underlying `places` row
-- to reference, and must keep working with place_id left null.
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql has already been applied. Idempotent — safe to re-run.

alter table itinerary_items add column if not exists place_id uuid references places(id);

create index if not exists itinerary_items_place_id_idx on itinerary_items(place_id);
