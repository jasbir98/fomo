-- add_deal_source_columns.sql — columns and ledger table for the page-grounded
-- deal-source pipeline (scraper/deal_sources/, docs/plans/2026-10-08-event-and-deal-coverage.md §7).
--
-- MUST BE RUN BY HAND in the Supabase SQL editor (nothing in the repo applies
-- migrations). Idempotent — safe to re-run. Run it before the first
-- `weekly_edinburgh.py --stage` that includes a live deal source, and before
-- deploying the promote-happenings.mjs change that carries these columns
-- (promote would fail on a `happenings` table missing them).
--
-- 1. happenings_staging: three display/lifecycle columns the deal extractor
--    fills (each backed by a verbatim page quote). Types match `happenings`.
--      price_text        short price phrase as the page states it ("£35.00 per person")
--      includes          what the price covers ("1 large brunch dish and 5 drinks")
--      season_valid_until last date the offer is valid; the lifecycle sweep
--                        (scripts/sweep-happenings.mjs) moves the row to dormant after it
--    `happenings` already has price_text/includes (add_enrichment_columns.sql) and
--    season_valid_until (archive/add_season_valid_until.sql); the matching
--    `add column if not exists` lines below only make this file self-sufficient.
alter table happenings_staging add column if not exists price_text text;
alter table happenings_staging add column if not exists includes text;
alter table happenings_staging add column if not exists season_valid_until date;

alter table happenings add column if not exists price_text text;
alter table happenings add column if not exists includes text;
alter table happenings add column if not exists season_valid_until date;

-- 2. source_pages: page-change ledger shared by every source that sends a page
--    to the LLM. If a page's normalised text hash is unchanged since the last
--    successful extraction, the extraction is skipped.
--      url              the page URL (primary key)
--      source_id        which source config fetched it (e.g. 'forever-edinburgh-offers')
--      content_hash     sha256 of the normalised page text
--      last_fetched_at  last time the page was fetched
--      last_changed_at  last time the hash changed
--      last_status      HTTP status (or pipeline status code) of the last fetch
create table if not exists source_pages (
  url text primary key,
  source_id text not null,
  content_hash text not null,
  last_fetched_at timestamptz not null default now(),
  last_changed_at timestamptz,
  last_status int
);

create index if not exists source_pages_source_id_idx on source_pages (source_id);

-- Service role only: RLS on with no policies, so the anon and authenticated
-- roles can neither read nor write it. The pipeline uses the service-role key
-- (bypasses RLS). Same pattern as lock_pipeline_2026_09.sql.
alter table source_pages enable row level security;
