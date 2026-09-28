-- Roameo v1: Social Reels (Workstream 4b) migration.
-- Adds TikTok/Instagram reel columns to the existing `social_posts` table so
-- the offline Playwright scraper (scraper/) can upsert real reels alongside
-- the seeded rows, and the Trending-on-Social feed + swipe viewer can read
-- video_url/thumbnail_url directly.
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql has already been applied. Idempotent — safe to re-run.

alter table social_posts add column if not exists platform text;
alter table social_posts add column if not exists video_url text;
alter table social_posts add column if not exists thumbnail_url text;
alter table social_posts add column if not exists destination text;
alter table social_posts add column if not exists place_id uuid references places(id);

create index if not exists social_posts_destination_idx on social_posts(destination);

-- Unique index on video_url so the scraper's upsert (on_conflict=video_url)
-- has a matching arbiter constraint — without this, PostgREST's
-- `Prefer: resolution=merge-duplicates` errors with 42P10. NULLs are treated
-- as distinct in Postgres, so the seed rows (video_url is null) don't collide.
create unique index if not exists social_posts_video_url_key on social_posts(video_url);

-- The v0 schema made `social_posts` read-only for anon (an `anon_select`
-- policy only), so the scraper's REST upsert would be blocked by RLS.
-- Grant anon write — mirroring the `anon_write`/anon-all pattern
-- `add_places_columns.sql` uses for `places` (this app is intentionally
-- no-auth / device-scoped; social posts are shared public seed/scrape data).
-- Keep the existing anon_select policy as-is.
drop policy if exists "anon_all" on social_posts;
create policy "anon_all" on social_posts for all to anon using (true) with check (true);
