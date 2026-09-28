-- One-time fix: drop the profiles(device_id) foreign keys that schema.sql
-- originally added on travel_preferences/roameo_rules/trips/itinerary_items/
-- chat_messages. Nothing in the app ever inserts a `profiles` row (there's
-- no explicit "create profile" step in the v0 flow), so those FKs made every
-- write to those tables fail with a 23503 violation. device_id is meant to
-- be a plain per-device scoping column, not a relational FK.
--
-- Safe to run once against a project where schema.sql has already been
-- applied. No data loss — only removes the constraint, not the column.

alter table travel_preferences drop constraint if exists travel_preferences_device_id_fkey;
alter table roameo_rules drop constraint if exists roameo_rules_device_id_fkey;
alter table trips drop constraint if exists trips_device_id_fkey;
alter table itinerary_items drop constraint if exists itinerary_items_device_id_fkey;
alter table chat_messages drop constraint if exists chat_messages_device_id_fkey;
