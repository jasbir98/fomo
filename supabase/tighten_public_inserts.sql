-- Close direct inserts into email_subscribers and tips via the public anon key.
--
-- Both tables had an "anon_insert" policy, so anyone holding the public
-- NEXT_PUBLIC_SUPABASE_ANON_KEY could POST rows straight to PostgREST,
-- skipping the API routes' per-IP rate limit, honeypot and validation (and,
-- for email_subscribers, probe whether an address is subscribed via the
-- unique-index 409). /api/subscribe and /api/tips now insert with the
-- service role, so no client-side policy is needed.
--
-- RUN AFTER the deploy where /api/tips switched to supabaseAdmin() —
-- otherwise tips submissions fail until it's live.
--
-- Safe to re-run.

drop policy if exists "anon_insert" on email_subscribers;
drop policy if exists "anon_insert" on tips;

-- RLS stays enabled with no policies: anon/authenticated can't read or write
-- either table; the service role bypasses RLS.
alter table email_subscribers enable row level security;
alter table tips enable row level security;

-- Verify (read-only): should return no rows.
-- select tablename, policyname from pg_policies
-- where schemaname = 'public' and tablename in ('email_subscribers', 'tips');
