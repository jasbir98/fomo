-- add_deal_quality.sql — columns for the deal quality score and route
-- (scraper/deal_sources/quality.py, docs/plans/2026-11-02-daily-best-deals.md).
--
-- MUST BE RUN BY HAND in the Supabase SQL editor (nothing in the repo applies
-- migrations). Idempotent — safe to re-run. NOT RUN YET, and no code needs these
-- columns yet: auto-publish is off and the pipeline only reports scores.
--
--   quality_score    0-100, from quality.score_deal
--   quality_reasons  jsonb array of short human-readable reasons behind the score
--   quality_route    'publish' | 'digest' | 'drop' (staging only: what the score would do)
alter table happenings_staging add column if not exists quality_score int;
alter table happenings_staging add column if not exists quality_reasons jsonb;
alter table happenings_staging add column if not exists quality_route text;

alter table happenings add column if not exists quality_score int;
alter table happenings add column if not exists quality_reasons jsonb;
