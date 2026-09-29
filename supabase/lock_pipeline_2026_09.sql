-- Close public (anon-key) access to the pipeline tables. Safe to re-run.
--
-- verify_security.sql on 2026-09-29 showed `anon_write` (FOR ALL, role anon)
-- still live on happenings_staging, places_staging, place_sources and
-- place_photos: anyone holding the public NEXT_PUBLIC_SUPABASE_ANON_KEY could
-- insert/edit/delete staging rows (which promote into the live catalogue)
-- and venue photos. archive/lock_pipeline_tables.sql was meant to close this
-- but evidently never ran against prod.
--
-- Every writer of these tables uses SUPABASE_SERVICE_ROLE_KEY (checked:
-- scraper/upsert_{places,happenings}.py, weekly_edinburgh.py,
-- photos_wikimedia.py, photos_happenings_og.py, link_happenings_places.py,
-- scripts/promote-{places,happenings}.mjs, both GitHub workflows), which
-- bypasses RLS, so nothing breaks.
--
-- After this:
--   place_photos      read-only for anon/authenticated (lib/db/places.ts reads it)
--   happenings_staging, places_staging, place_sources, happening_sources
--                     service-role only (no app code reads them)

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['happenings_staging', 'places_staging', 'place_sources', 'happening_sources', 'place_photos'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy "read_all" on place_photos for select to anon, authenticated using (true);

-- Avatars bucket: public read stays (profile photos render via public URL),
-- but cap uploads at 5 MB and the image types the picker accepts — the same
-- limits lib/db/profile.ts checks client-side, now enforced server-side.
update storage.buckets
set file_size_limit = 5 * 1024 * 1024,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'avatars';
