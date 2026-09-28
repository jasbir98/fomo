-- Roameo Japan Tokyo pilot promotion (jp-tokyo-2026-07-15)
-- Moves approved rows from `places_staging` / `city_foods_staging` into the
-- production `places`, `place_photos`, `place_sources`, and `city_foods` tables.
--
-- Prereqs (run in order first if not already applied):
--   supabase/schema.sql
--   supabase/add_places_columns.sql
--   supabase/add_japan_places_pipeline.sql
--   supabase/add_japan_tokyo_pipeline.sql
--   supabase/seed_japan_tokyo.sql   (loads the staging rows this script promotes)
--
-- Idempotent and re-runnable:
--   * Places are matched by (country, prefecture, city, lower(name)); existing
--     rows are re-linked, not duplicated.
--   * Photos dedupe on (place_id, url) via the unique index in add_japan_tokyo_pipeline.sql.
--   * Sources are re-inserted per run (they're append-only provenance and cheap).
--   * city_foods dedupe on (country, prefecture, city, lower(name)) via the
--     unique index in add_japan_tokyo_pipeline.sql.
--
-- After a successful run each promoted staging row has extraction_status = 'promoted'
-- and its place_id / city_food_id filled in, so subsequent runs are no-ops for
-- rows already promoted (they still resync photos/sources — cheap).

begin;

-- ============================================================================
-- 1. Promote places_staging -> places
-- ============================================================================
with approved as (
  select *
  from places_staging
  where batch_id = 'jp-tokyo-2026-07-15'
    and approved = true
    and extraction_status in ('approved', 'promoted')
),
existing as (
  -- Staging rows whose place already exists (idempotent re-run OR pre-existing seed).
  select a.id as staging_id, p.id as place_id
  from approved a
  join places p
    on  p.country = a.country
    and p.prefecture is not distinct from a.prefecture
    and p.city       is not distinct from a.city
    and lower(p.name) = lower(a.name)
),
to_insert as (
  select a.*
  from approved a
  left join existing e on e.staging_id = a.id
  where e.place_id is null
),
inserted as (
  insert into places (
    name, category, description, tips, hours, hours_status, station,
    lat, lng, address, image_url, badges,
    city, prefecture, country,
    last_verified_at, source
  )
  select
    name, category, description, coalesce(tips, '[]'::jsonb),
    hours, hours_status, station,
    lat, lng, address, image_url, coalesce(badges, '{}'::text[]),
    city, prefecture, country,
    last_verified_at,
    'seed:jp-tokyo-2026-07-15'
  from to_insert
  returning id, country, prefecture, city, name
),
inserted_map as (
  select ti.id as staging_id, i.id as place_id
  from to_insert ti
  join inserted i
    on  i.country   = ti.country
    and i.prefecture is not distinct from ti.prefecture
    and i.city       is not distinct from ti.city
    and lower(i.name) = lower(ti.name)
),
all_map as (
  select * from existing
  union all
  select * from inserted_map
)
update places_staging s
set place_id = m.place_id,
    extraction_status = 'promoted',
    updated_at = now()
from all_map m
where s.id = m.staging_id;

-- ============================================================================
-- 2. Backfill place_photos from staging.photos jsonb array
-- ============================================================================
with promoted as (
  select id as staging_id, place_id, photos
  from places_staging
  where batch_id = 'jp-tokyo-2026-07-15'
    and extraction_status = 'promoted'
    and place_id is not null
    and photos is not null
    and jsonb_typeof(photos) = 'array'
),
expanded as (
  select
    p.place_id,
    (photo ->> 'url')                                              as url,
    coalesce(photo ->> 'credit',     '')                           as credit,
    coalesce(photo ->> 'license',    '')                           as license,
    coalesce(photo ->> 'source_url', '')                           as source_url,
    coalesce((photo ->> 'is_exact_place')::boolean, true)          as is_exact_place,
    coalesce(photo ->> 'provider',   'wikimedia')                  as provider,
    ((row_number() over (partition by p.place_id order by ord)) - 1)::int
                                                                   as display_order
  from promoted p,
    lateral jsonb_array_elements(p.photos) with ordinality as t(photo, ord)
)
insert into place_photos (
  place_id, url, credit, license, source_url,
  is_exact_place, provider, display_order
)
select
  place_id, url, credit, license, source_url,
  is_exact_place, provider, display_order
from expanded
where url        <> ''
  and credit     <> ''
  and license    <> ''
  and source_url <> ''
on conflict (place_id, url) do update set
  credit         = excluded.credit,
  license        = excluded.license,
  source_url     = excluded.source_url,
  is_exact_place = excluded.is_exact_place,
  provider       = excluded.provider,
  display_order  = excluded.display_order;

-- ============================================================================
-- 3. Backfill place_sources from staging.field_sources jsonb object
--    (field_name -> source_url provenance for the review UI)
--    Delete prior rows for this batch's staging_ids first so re-runs stay clean.
-- ============================================================================
delete from place_sources ps
using places_staging s
where s.batch_id = 'jp-tokyo-2026-07-15'
  and s.extraction_status = 'promoted'
  and ps.staging_id = s.id;

with promoted as (
  select id as staging_id, place_id, field_sources, extraction_model
  from places_staging
  where batch_id = 'jp-tokyo-2026-07-15'
    and extraction_status = 'promoted'
    and place_id is not null
    and field_sources is not null
    and jsonb_typeof(field_sources) = 'object'
),
expanded as (
  select
    p.place_id,
    p.staging_id,
    p.extraction_model,
    kv.key   as field_name,
    kv.value as source_url
  from promoted p,
    lateral jsonb_each_text(p.field_sources) kv
)
insert into place_sources (place_id, staging_id, field_name, source_url, extractor)
select place_id, staging_id, field_name, source_url, extraction_model
from expanded
where source_url is not null and source_url <> '';

-- ============================================================================
-- 4. Promote city_foods_staging -> city_foods
-- ============================================================================
with approved_foods as (
  select *
  from city_foods_staging
  where batch_id = 'jp-tokyo-2026-07-15'
    and approved = true
    and extraction_status in ('approved', 'promoted')
),
upserted as (
  insert into city_foods (
    country, prefecture, city, name, description,
    source_urls, linked_places, last_verified_at, confidence
  )
  select
    country, prefecture, city, name, description,
    coalesce(source_urls,   '{}'::text[]),
    coalesce(linked_places, '{}'::text[]),
    last_verified_at,
    'high'
  from approved_foods
  on conflict (country, prefecture, city, lower(name)) do update set
    description      = excluded.description,
    source_urls      = excluded.source_urls,
    linked_places    = excluded.linked_places,
    last_verified_at = excluded.last_verified_at,
    confidence       = excluded.confidence
  returning id, country, prefecture, city, lower(name) as lname
)
update city_foods_staging s
set city_food_id      = u.id,
    extraction_status = 'promoted',
    updated_at        = now()
from upserted u
where s.batch_id   = 'jp-tokyo-2026-07-15'
  and s.country    = u.country
  and s.prefecture = u.prefecture
  and s.city       = u.city
  and lower(s.name) = u.lname;

commit;

-- ============================================================================
-- 5. Post-promotion counts (run separately to verify)
-- ============================================================================
-- select
--   (select count(*) from places_staging   where batch_id = 'jp-tokyo-2026-07-15' and extraction_status = 'promoted')  as places_promoted,
--   (select count(*) from places           where source   = 'seed:jp-tokyo-2026-07-15')                                as places_rows,
--   (select count(*) from place_photos pp  where exists (select 1 from places p where p.id = pp.place_id and p.source = 'seed:jp-tokyo-2026-07-15')) as photo_rows,
--   (select count(*) from place_sources ps where exists (select 1 from places p where p.id = ps.place_id and p.source = 'seed:jp-tokyo-2026-07-15')) as source_rows,
--   (select count(*) from city_foods_staging where batch_id = 'jp-tokyo-2026-07-15' and extraction_status = 'promoted') as foods_promoted,
--   (select count(*) from city_foods         where prefecture = 'Tokyo' and city in ('Shibuya','Shinjuku','Taito'))     as foods_rows;
