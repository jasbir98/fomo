-- add_enrichment_columns.sql — columns for the Edinburgh data-enrichment pass.
-- See docs/plans/2026-10-07-data-enrichment.md.
--
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- places: facts read from Google Places (scripts/enrich-places-google.mjs).
--   Google's terms allow caching its data for at most 30 days, so every
--   Google-owned column below is refreshed monthly (the monthly-places-refresh
--   workflow) and `google_fetched_at` says when it was last read. The place ID
--   itself (`google_place_id`, already exists) may be kept indefinitely.
--   `google_summary` must only ever be shown with `google_summary_disclosure`.
-- happenings: price / inclusions extracted from each deal's own page, with the
--   evidence quote per field kept in `enrich_sources`.
--
-- Existing public-select RLS covers new columns; nothing else to grant.

-- 1. places
alter table places add column if not exists website text;
alter table places add column if not exists phone text;
alter table places add column if not exists google_rating_count int;
-- Google's price range as display text, e.g. "£10–20".
alter table places add column if not exists price_range text;
-- Google businessStatus: OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY.
alter table places add column if not exists business_status text;
alter table places add column if not exists google_maps_uri text;
alter table places add column if not exists google_summary text;
-- Attribution Google requires next to the summary, e.g. "Summarized with Gemini".
alter table places add column if not exists google_summary_disclosure text;
alter table places add column if not exists google_fetched_at timestamptz;

-- 2. happenings
-- Short price phrase as the page states it: "£20 for two", "From £15".
alter table happenings add column if not exists price_text text;
-- What the price covers: "Pizza or burger, a side and a drink each".
alter table happenings add column if not exists includes text;
-- Evidence per enriched field: { field: { url, quote } }.
alter table happenings add column if not exists enrich_sources jsonb;
alter table happenings add column if not exists enriched_at timestamptz;
