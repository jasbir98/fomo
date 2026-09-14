-- Fomo: per-user rate limiting for the paid LLM routes (chat, translate)
-- ahead of public deploy. See lib/rate-limit.ts for the server helper that
-- calls this, and app/api/chat/route.ts + app/api/translate/route.ts for
-- the call sites.
--
-- HOW TO RUN: paste this whole file into the Supabase SQL editor for this
-- project and run it. Idempotent — safe to re-run (create/replace + `if not
-- exists` throughout). The app fails OPEN (rate limiting is skipped, not
-- enforced) until this migration is applied — see lib/rate-limit.ts's doc
-- comment — so there's no ordering hazard with the app code deploy either
-- direction.
--
-- Shape: one row per (user, route, fixed window). `consume_rate_limit`
-- below is the only way in or out of this table — RLS is enabled with NO
-- policies at all (same "service-role/definer-function only" shape as
-- push_notification_log in add_push_alerts.sql), so a signed-in user can
-- never read or write another user's counters, or even their own, except
-- through the function, which is `security definer` and scopes every read/
-- write to `auth.uid()` itself.

begin;

-- ============================================================================
-- TABLE — one row per user, per route, per fixed window. `route` carries a
-- ":burst"/":day" (or similar) suffix from the caller so a short window and
-- a daily window for the same feature don't collide on this primary key —
-- see lib/rate-limit.ts.
-- ============================================================================
create table if not exists api_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  route text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (user_id, route, window_start)
);

alter table api_rate_limits enable row level security;
-- No policies — direct client access is never needed or wanted; every read/
-- write goes through consume_rate_limit() below.

create index if not exists api_rate_limits_window_idx on api_rate_limits (window_start);

-- ============================================================================
-- FUNCTION — atomically increments the caller's counter for one fixed
-- window and reports whether this request is still within `p_limit`.
--
-- Fixed-window algorithm: the window boundary is `p_window_seconds` wide and
-- aligned to the Unix epoch (not to the user's first request), so all users
-- sharing a route share the same window edges — simple and good enough for
-- an abuse guard (not billing-grade precision; a sliding window isn't worth
-- the extra complexity here).
--
-- `auth.uid()` is rejected when null so this can only ever be called with a
-- real signed-in session — matches every other RLS-scoped write in this
-- schema (see add_auth_identity.sql's `default auth.uid()` columns).
--
-- The upsert is a single atomic `insert ... on conflict ... returning`, so
-- concurrent requests from the same user (Vercel Hobby runs multiple
-- serverless instances — no shared in-memory counter would be reliable)
-- can't race past each other; Postgres' row lock on the conflicting key
-- serializes the increment.
-- ============================================================================
create or replace function public.consume_rate_limit(
  p_route text,
  p_limit int,
  p_window_seconds int
)
returns table(allowed boolean, remaining int, reset_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_window_start timestamptz;
  v_reset_at timestamptz;
  v_count int;
begin
  if v_user_id is null then
    raise exception 'consume_rate_limit: no authenticated user' using errcode = '28000';
  end if;

  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'consume_rate_limit: p_window_seconds must be positive' using errcode = '22023';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );
  v_reset_at := v_window_start + make_interval(secs => p_window_seconds);

  insert into public.api_rate_limits as rl (user_id, route, window_start, count)
  values (v_user_id, p_route, v_window_start, 1)
  on conflict (user_id, route, window_start)
    do update set count = rl.count + 1
  returning rl.count into v_count;

  -- Opportunistic cleanup: drop this user's own rows once their window is
  -- over a day stale. Scoped to v_user_id so this stays a cheap per-call
  -- tidy-up, not a table-wide scan — no separate cron job needed for a
  -- table this small.
  delete from public.api_rate_limits
  where user_id = v_user_id
    and window_start < clock_timestamp() - interval '1 day';

  return query select (v_count <= p_limit), greatest(p_limit - v_count, 0), v_reset_at;
end;
$$;

grant execute on function public.consume_rate_limit(text, int, int) to authenticated;
revoke execute on function public.consume_rate_limit(text, int, int) from anon;
revoke execute on function public.consume_rate_limit(text, int, int) from public;

commit;
