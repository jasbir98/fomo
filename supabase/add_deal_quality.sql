-- add_deal_quality.sql — columns for the deal quality score and route
-- (scraper/deal_sources/quality.py, docs/plans/2026-11-02-daily-best-deals.md).
--
-- MUST BE RUN BY HAND in the Supabase SQL editor (nothing in the repo applies
-- migrations). Idempotent — safe to re-run. NOT RUN YET. The daily/weekly pipeline
-- (scraper/deal_routing.py) writes the three staging columns on every staged row; until this has
-- run, the upsert drops them with one warning and the report says so, so nothing breaks.
-- scripts/promote-happenings.mjs copies quality_score and quality_reasons onto the live row (it
-- only does so when the staging row has them, which needs this file run on both tables first).
--
--   quality_score    0-100, from quality.score_deal
--   quality_reasons  jsonb array of short human-readable reasons behind the score
--   quality_route    'publish' | 'digest' | 'drop' (staging only: where the row was routed; dropped
--                    rows are staged too, with their reasons)
alter table happenings_staging add column if not exists quality_score int;
alter table happenings_staging add column if not exists quality_reasons jsonb;
alter table happenings_staging add column if not exists quality_route text;
-- evidence_quote: the deal's main quote from its source page (the gate's evidence), so the digest can
-- show it and a stored row shows it passed the gate. Staged by the pipeline; not copied to happenings.
alter table happenings_staging add column if not exists evidence_quote text;

alter table happenings add column if not exists quality_score int;
alter table happenings add column if not exists quality_reasons jsonb;

-- The review digest and score_backlog.py read waiting rows by route.
create index if not exists happenings_staging_quality_route_idx
  on happenings_staging (quality_route, approved)
  where approved is not true;
