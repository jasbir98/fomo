-- Fomo: "Happenings" — time-limited money/access opportunities (discounts,
-- free-entry days, concession deals, cheap recurring nights, free festival
-- strands). Same class as `places`/`experiences`/`country_practicalities`:
-- shared, pipeline-fed, read-only catalog data. See supabase/add_practicalities.sql
-- for the closest existing analogue (copy its RLS shape and header style).
--
-- WHY THIS IS ITS OWN TABLE AND NOT ROWS IN `events`:
--
-- The single most important reason: lib/events/getForDestination.ts:96-106
-- computes cache freshness by taking the MAX `fetched_at` across whatever the
-- cached read for a destination returned (`newestFetch`), and if that max is
-- under EVENTS_CACHE_TTL_MS (6h) old, it returns the cache as-is and skips
-- the live Skiddle/Ticketmaster fetch entirely. Happenings are hand-curated
-- and re-verified on a completely different cadence (weeks/months, not
-- hours) — if a curated happening lived in `events` with any kind of
-- recent-looking timestamp in that column, it would make the whole
-- destination's cache read as "fresh" and silently suppress the live event
-- fetch for up to 6 hours, for every user, with no error and no log line.
-- A separate table makes that interaction structurally impossible: nothing
-- here is ever read by getForDestination's cache-freshness calculation.
--
-- Secondary reasons happenings don't fit the `events` shape:
--   - Lifecycle differs. Events are provider-fetched and pruned by hand
--     (`delete from events where starts_at < now() - interval '7 days'`,
--     add_events.sql:63). Happenings are NEVER deleted — an expired annual
--     fixture (e.g. St Andrew's Day) is next year's row, so it needs its own
--     `status` lifecycle (live/dormant/retired) instead of falling out of a
--     date-windowed query.
--   - Content shape differs. `saving_label`/`saving_amount`/`promo_code`/
--     `redemption_note`/`eligibility`/`eligibility_note`/`allowance_note`/
--     `recurrence` have no equivalent on `events` — bolting them on there
--     would make every event-shaped read pay for happening-shaped columns.
--   - `scope` (venue/city/region/national) has no `events` equivalent either
--     — `events` is always venue/city-shaped. A national row (National
--     Cinema Weekend) or region-wide row (Doors Open Days) legitimately has
--     `city = null`, which `events`' city-keyed reads and dedupe were never
--     built to handle.
--
-- Idempotent — safe to re-run.

-- ============================================================================
-- HAPPENINGS — shared, pipeline-fed, read-only catalog. Writes are
-- service-role only (no write policy on this table at all).
-- ============================================================================
create table if not exists happenings (
  id uuid primary key default gen_random_uuid(),

  -- Stable on_conflict key for the promotion/upsert path, scope-prefixed:
  -- "uk-national-cinema-weekend-2026", "scotland-doors-open-days-2026",
  -- "edinburgh-mary-kings-close-standrews-2026".
  slug text not null,
  title text not null,          -- <= 8 words
  summary text,

  -- `kind` is three values, not five: deal | free_access | festival.
  -- `seasonal`/`one_off` would just duplicate what `recurrence` already
  -- encodes, and `free_entry` would duplicate the `is_free` boolean below.
  -- No CHECK — taxonomy columns in this repo are enforced in TypeScript
  -- unions, not the DB (see add_practicalities.sql:20-25).
  kind text not null,
  category text,                -- reuses the events chip vocabulary: music|nightlife|festival|
                                 -- arts|comedy|sports|food|family|museum|cinema|other
  -- `scope` is load-bearing, not decorative. National Cinema Weekend and
  -- Doors Open Days both have `city = null` (UK-wide / Scotland-wide). Any
  -- read path that only ORs `city ilike '%Edinburgh%' or address ilike
  -- '%Edinburgh%'` matches neither row and they silently never render for
  -- an Edinburgh page. The read path must additionally OR in a
  -- `region`/`scope = 'national'` match. venue | city | region | national.
  scope text not null default 'city',
  editorial_tag text,           -- curator's flourish, rendered as a badge:
                                 -- "St Andrew's Day Special", "Civic Highlight", "National Weekend"

  saving_label text,            -- display copy, the SOURCE's own figure: "£4 tickets", "2-for-1", "Free"
  saving_amount numeric,        -- numeric saving per person, when known: 21.00
  currency text default 'GBP',
  is_free boolean,              -- the filterable boolean; saving_label is display-only, never parsed
  promo_code text,              -- VERBATIM from source, exact case. Never constructed by us.
  redemption_note text,         -- "Apply code at checkout or quote at box office",
                                 -- "No code needed · auto applied", "Box office at door"

  eligibility text not null default 'anyone',
                                 -- anyone | local_resident | student | under_26 | over_60 | member | cardholder
  eligibility_note text,        -- "EH postcodes only. Proof of address required on the day."
  allowance_note text,          -- "Up to 2 complimentary tickets per verified resident household."

  starts_at timestamptz,        -- BOTH null for recurring (BrewDog Mondays) and always-on
  ends_at timestamptz,          -- rows (National Museum of Scotland, permanently free)
  recurrence jsonb not null default '{"type":"once"}'::jsonb,
  time_note text,                -- "10:00–17:00, tours every 15 min" — DISPLAY ONLY, never parsed

  venue_name text,
  address text,
  district text,                 -- "Old Town", "Leith Shore", "Southside" — shown on every card
  city text,                     -- null at region/national scope — see `scope` note above
  region text,                   -- "Scotland" when scope = 'region'
  country_code text not null,    -- ISO-2. No DEFAULT — every writer must set it explicitly,
                                  -- same reasoning as add_events.sql:25-29 (a default would be
                                  -- silently wrong for whichever scope didn't set it).
  lat double precision,          -- null for city-wide / multi-venue rows
  lng double precision,
  place_id uuid references places(id),

  image_url text,
  -- Defaults to 'thin' deliberately. lib/now/rank.ts's `heroEligible` requires
  -- 'ok', so a discount can never win the page's photo-hero slot. Intended —
  -- happenings are a value-prop chip, not a destination photo.
  image_quality text default 'thin',
  booking_url text,              -- where you redeem; DISTINCT from source_url
  cta_label text,                -- "Claim Offer", "View Screenings", "Explore 40+ Venues", "Guide Map"

  source_name text not null,     -- "Forever Edinburgh" — rendered on every card
  source_url text not null,      -- the page that states the terms
  verified_at timestamptz not null,
  confidence text default 'medium',      -- low | medium | high
  -- `status` is lifecycle ONLY (live | dormant | retired) — never a
  -- staleness flag. `dormant` = a dated window has passed but the row
  -- recurs, so it's already next year's row. `retired` = the offer
  -- genuinely doesn't exist any more. Staleness is derived from
  -- `verified_at` at READ time and never stored: there is no cron in this
  -- app, so a stored staleness flag would be wrong every time the sweep
  -- hadn't run yet.
  status text not null default 'live',
  priority int default 50,       -- ranking weight, 50 neutral
  created_at timestamptz default now(),
  updated_at timestamptz default now()

  -- Nothing ever deletes from this table. An expired annual fixture (Real
  -- Mary King's Close St Andrew's Day) is next year's row, not a dead one.
);

-- Plain (non-partial) unique index — the on_conflict target for the
-- pipeline's promotion upsert. A partial index here raises Postgres error
-- 42P10 on PostgREST's on_conflict, same trap as add_events.sql:40-45.
create unique index if not exists happenings_slug_key on happenings (slug);

create index if not exists happenings_city_status_idx on happenings (city, status);
create index if not exists happenings_country_scope_status_idx on happenings (country_code, scope, status);
create index if not exists happenings_dates_idx on happenings (starts_at, ends_at);
create index if not exists happenings_verified_at_idx on happenings (verified_at);
create index if not exists happenings_district_idx on happenings (district);

alter table happenings enable row level security;
drop policy if exists "read_all" on happenings;
create policy "read_all" on happenings for select to anon, authenticated using (true);
-- No write policy at all — writes go through the service role only (same
-- shape as country_practicalities: a shared hand/pipeline-curated catalog,
-- not a live-API cache an anon route needs to upsert into).

-- ============================================================================
-- HAPPENING SOURCES — per-field provenance, mirroring `place_sources`.
-- Read-only catalog data; no write policy (service role only).
-- ============================================================================
create table if not exists happening_sources (
  id uuid primary key default gen_random_uuid(),
  happening_id uuid references happenings(id) on delete cascade,
  staging_id uuid,
  field_name text not null,
  source_url text not null,
  extractor text,
  created_at timestamptz default now()
);

alter table happening_sources enable row level security;
drop policy if exists "read_all" on happening_sources;
create policy "read_all" on happening_sources for select to anon, authenticated using (true);
-- No write policy — same reasoning as happenings above.

create index if not exists happening_sources_happening_field_idx
  on happening_sources (happening_id, field_name);
create index if not exists happening_sources_staging_idx
  on happening_sources (staging_id);

-- ============================================================================
-- HAPPENINGS STAGING — pre-promotion review, mirroring `places_staging`.
-- The Python pipeline writes this table directly with the anon key, so
-- (unlike `happenings` itself) it DOES get an anon write policy.
-- ============================================================================
create table if not exists happenings_staging (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null,
  research_mode text,            -- calendar | offers | verify

  -- Every content column below mirrors `happenings` (same names/types), but
  -- NOT NULL is relaxed everywhere except slug/title — extraction fills
  -- these in incrementally and most fields are legitimately unknown until a
  -- later pass.
  slug text not null,
  title text not null,
  summary text,
  kind text,
  category text,
  scope text default 'city',
  editorial_tag text,
  saving_label text,
  saving_amount numeric,
  currency text default 'GBP',
  is_free boolean,
  promo_code text,
  redemption_note text,
  eligibility text default 'anyone',
  eligibility_note text,
  allowance_note text,
  starts_at timestamptz,
  ends_at timestamptz,
  recurrence jsonb default '{"type":"once"}'::jsonb,
  time_note text,
  venue_name text,
  address text,
  district text,
  city text,
  region text,
  country_code text,
  lat double precision,
  lng double precision,
  place_id uuid references places(id),
  image_url text,
  image_quality text default 'thin',
  booking_url text,
  cta_label text,
  source_name text,
  source_url text,
  verified_at timestamptz,
  confidence text default 'medium',
  status text default 'live',
  priority int default 50,

  -- Pipeline-only columns (no equivalent on `happenings`):
  source_urls text[] default '{}',
  field_sources jsonb default '{}'::jsonb,
  extraction_model text,
  -- The ONE exception to "no CHECK constraints on taxonomy columns" in this
  -- migration: this is a pipeline-internal state machine, not a
  -- user/content-facing taxonomy, matching city_foods_staging
  -- (add_japan_tokyo_pipeline.sql:71-72).
  extraction_status text default 'pending'
    check (extraction_status in ('pending', 'extracted', 'validated', 'approved', 'rejected', 'promoted')),
  validation_errors jsonb default '[]'::jsonb,
  approved boolean default false,
  rejected_reason text,
  happening_id uuid references happenings(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table happenings_staging enable row level security;
drop policy if exists "read_all" on happenings_staging;
create policy "read_all" on happenings_staging for select to anon, authenticated using (true);
drop policy if exists "anon_write" on happenings_staging;
create policy "anon_write" on happenings_staging for all to anon using (true) with check (true);

-- Plain (non-partial) unique index — the Python upserter's on_conflict
-- target. Same 42P10 trap as happenings_slug_key above.
create unique index if not exists happenings_staging_batch_slug_key
  on happenings_staging (batch_id, slug);
create index if not exists happenings_staging_status_idx
  on happenings_staging (batch_id, extraction_status, approved);
