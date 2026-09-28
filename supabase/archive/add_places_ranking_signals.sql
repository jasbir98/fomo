-- Roameo v1: "right now" pivot, part 2 — ranking signals on `places`.
-- See plan-v1-home-pivot.md §10.2. Run after add_itinerary_times.sql.
--
-- Idempotent — safe to re-run.

-- Structured hours, so `closing_soon` (one of the highest-value ranker
-- generators — "shutters go down at five") can compare against a clock.
-- The existing `hours` text column stays untouched (still used for display);
-- this is additive. Shape mirrors Google Places (New)'s
-- regularOpeningHours.periods: an array of
-- { day: 0-6 (0=Sunday), open: "HH:MM", close: "HH:MM" }. A place open past
-- midnight or with split hours (lunch/dinner) can have multiple entries for
-- the same day. Null/empty = unknown, same as hours_status = 'unknown'.
alter table places add column if not exists opening_hours jsonb;

-- v1's "Best of the City" floor (deferred full editorial layer to v2, see
-- plan-v1-home-pivot.md §0): curated places ranked by how often they're
-- independently mentioned across the reels/social corpus. Populated by the
-- mention-crossref script (§10.4), not hand-edited.
alter table places add column if not exists mention_count int default 0;
alter table places add column if not exists mention_sources jsonb;

-- Cached, pipeline-written one-line opinion used by the Home hero/rail tiles
-- and Plan gap cards ("Queue starts at nine", "Empty on a weekday"). Written
-- once per place at pipeline/authoring time, never generated per request —
-- this is what keeps a Home open cheap and fast (see §9.7: templates first,
-- LLM second, and the LLM part is pre-computed).
alter table places add column if not exists detail_line text;

-- Hero eligibility gate (§11). 'ok' = confirmed >=800px wide, loads, not a
-- placeholder; 'thin' = small or low-confidence; 'none' = no usable image.
-- Null = not yet validated. The Home ranker requires 'ok' to render the
-- photo hero; anything else falls back to the typographic card.
alter table places add column if not exists image_quality text
  check (image_quality is null or image_quality in ('ok', 'thin', 'none'));

create index if not exists places_mention_count_idx
  on places (mention_count desc);
