-- Roameo v1: raw reel staging table (Workstream 4c) migration.
--
-- Splits the reel pipeline in two: `scraped_reels` holds everything the
-- offline Playwright scraper (scraper/) finds, unfiltered. `social_posts`
-- stays the curated table the app's Trending-on-Social feed actually reads
-- (lib/db/social.ts listReels()) — a reel only lands there once
-- scraper/classify_reels.py has read its caption and decided it's genuinely
-- about the tourist destination it was searched under. Same shape as the
-- existing places_staging -> places pipeline (see
-- scraper/JAPAN_PLACES_PIPELINE.md), applied to reels.
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql and add_social_video_columns.sql have already been applied.
-- Idempotent — safe to re-run.

create table if not exists scraped_reels (
  id uuid primary key default gen_random_uuid(),
  platform text,
  video_url text,
  thumbnail_url text,
  caption text,
  author_handle text,
  likes int,
  location text,          -- the specific place name searched
  destination text,       -- trip destination tag (e.g. "Tokyo")
  place_id uuid references places(id),
  scraped_at timestamptz not null default now(),
  classified boolean not null default false,
  is_tourist_reel boolean,
  classification_reason text,
  classified_at timestamptz
);

alter table scraped_reels enable row level security;

-- Intentionally no-auth / device-scoped, same as social_posts and places —
-- see add_social_video_columns.sql for the identical anon_all rationale.
drop policy if exists "anon_all" on scraped_reels;
create policy "anon_all" on scraped_reels for all to anon using (true) with check (true);

-- Unique index so the scraper's upsert (on_conflict=video_url) has a
-- matching arbiter constraint, same reasoning as social_posts_video_url_key
-- in add_social_video_columns.sql.
create unique index if not exists scraped_reels_video_url_key on scraped_reels(video_url);

-- classify_reels.py selects `classified = false` every run.
create index if not exists scraped_reels_classified_idx on scraped_reels(classified);

-- One-time backfill: move any reels already scraped directly into
-- social_posts (from before this staging table existed) into scraped_reels
-- as unclassified, so the curated feed goes back to only showing reviewed
-- content until classify_reels.py runs. The NOT EXISTS guard means
-- re-running this file won't re-duplicate rows already staged.
insert into scraped_reels (platform, video_url, thumbnail_url, caption, author_handle, likes, location, destination, place_id)
select platform, video_url, thumbnail_url, caption, author_handle, likes, location, destination, place_id
from social_posts
where video_url is not null
  and not exists (select 1 from scraped_reels sr where sr.video_url = social_posts.video_url);

-- Only remove social_posts reel rows that are NOT a classifier-approved
-- promotion — i.e. still-unclassified or explicitly-rejected duplicates.
-- This keeps the file safely re-runnable: it won't wipe out rows
-- classify_reels.py has since promoted back into social_posts on a later
-- run (those have a scraped_reels counterpart with is_tourist_reel = true).
delete from social_posts sp
where sp.video_url is not null
  and exists (
    select 1 from scraped_reels sr
    where sr.video_url = sp.video_url
      and coalesce(sr.is_tourist_reel, false) = false
  );
