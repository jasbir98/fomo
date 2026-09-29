-- Read-only security check. Paste into the Supabase SQL editor and run as ONE
-- statement: the editor only shows the last statement's result, so every
-- check is folded into a single result set. Each row is something to look at;
-- `ok_*` rows are expected and listed for context.
--
-- Expected after all pending migrations: no `no_rls`, `anon_write_policy`,
-- `legacy_table` or `anon_exec_definer_fn` rows. `authenticated_write_policy`
-- rows should all be own-row policies (auth.uid() in using/check).

select 'no_rls' as check, c.relname::text as object, null::text as detail
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity

union all
select 'anon_write_policy', tablename::text,
       policyname || ' ' || cmd || ' roles=' || array_to_string(roles, ',')
from pg_policies
where schemaname = 'public'
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and roles && array['anon', 'public']::name[]

union all
select 'authenticated_write_policy', tablename::text,
       policyname || ' ' || cmd || ' using=' || coalesce(qual, '-') || ' check=' || coalesce(with_check, '-')
from pg_policies
where schemaname = 'public'
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and 'authenticated' = any(roles)

union all
select 'ok_read_policy', tablename::text, policyname || ' roles=' || array_to_string(roles, ',')
from pg_policies
where schemaname = 'public' and cmd = 'SELECT'

union all
select 'legacy_table', table_name::text, 'drop_legacy.sql not applied'
from information_schema.tables
where table_schema = 'public' and table_name in (
  'card_signals', 'user_location', 'device_location', 'travel_preferences', 'itinerary_items',
  'roameo_rules', 'trips', 'practicality_dismissals', 'country_practicalities', 'arrival_tips',
  'experiences', 'scraped_reels', 'social_posts', 'city_foods_staging', 'city_foods')

union all
select case when has_function_privilege('anon', p.oid, 'execute') then 'anon_exec_definer_fn'
            else 'ok_definer_fn' end,
       p.proname::text,
       'authenticated=' || has_function_privilege('authenticated', p.oid, 'execute')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef

union all
select 'storage_bucket', id::text,
       'public=' || public || ' size_limit=' || coalesce(file_size_limit::text, 'none')
       || ' mime=' || coalesce(array_to_string(allowed_mime_types, ','), 'any')
from storage.buckets

order by 1, 2;
