-- Fomo: IP-scoped rate limiting for routes with no session at all
-- (POST /api/subscribe, POST /api/tips) plus a site-wide shared-key backstop
-- (POST /api/chat's global daily cap). See lib/rate-limit.ts for the server
-- helpers that call this (consumeAnonRateLimit / consumeGlobalRateLimit) and
-- app/api/subscribe/route.ts, app/api/tips/route.ts, app/api/chat/route.ts
-- for the call sites.
--
-- supabase/add_rate_limits.sql's consume_rate_limit is scoped to
-- auth.uid() inside the function and raises when there's no session — it
-- cannot be reused for these routes, hence this separate table/function.
--
-- HOW TO RUN: paste this whole file into the Supabase SQL editor for this
-- project and run it. Idempotent — safe to re-run (create/replace + `if not
-- exists` throughout). The app fails OPEN (rate limiting is skipped, not
-- enforced) until this migration is applied — see lib/rate-limit.ts's file
-- header — so there's no ordering hazard with the app code deploy either
-- direction.
--
-- Shape: one row per (key, route, fixed window). `key` is NEVER a raw IP —
-- lib/rate-limit.ts's hashAnonKey computes SHA-256("<ip>:<salt>") in the
-- app before this table ever sees it, so a leak/dump of this table doesn't
-- leak any visitor's IP address. RLS is enabled with NO policies at all
-- (same "service-role/definer-function only" shape as api_rate_limits in
-- add_rate_limits.sql), and the function's EXECUTE grant is service_role
-- ONLY (explicitly revoked from anon/authenticated) — an anonymous or
-- signed-in client can never call this directly, only the server (via the
-- admin/service-role client, lib/supabase/admin.ts) can.

begin;

-- ============================================================================
-- TABLE — one row per key, per route, per fixed window.
-- ============================================================================
create table if not exists anon_rate_limits (
  key text not null,
  route text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, route, window_start)
);

alter table anon_rate_limits enable row level security;
-- No policies — direct client access is never needed or wanted; every read/
-- write goes through consume_anon_rate_limit() below, which only
-- service_role can execute.

create index if not exists anon_rate_limits_window_idx on anon_rate_limits (window_start);

-- ============================================================================
-- FUNCTION — atomically increments the counter for one (key, route, fixed
-- window) and reports whether this request is still within p_max.
--
-- Unlike consume_rate_limit (add_rate_limits.sql), this does NOT read
-- auth.uid() — the caller (server-side app code, via the admin client)
-- supplies p_key directly, already hashed. That's also why this is
-- `security definer` with EXECUTE revoked from anon/authenticated and
-- granted only to service_role: nothing about this function's access
-- control depends on the caller's own session, so the DB-level grant is
-- the only thing stopping a browser from calling it directly (e.g. to
-- reset someone else's counter by guessing their hashed key, or to churn
-- through the table). PostgREST would reject it from the client anyway
-- since only service_role has EXECUTE, but the explicit revoke makes that
-- an intentional, visible decision rather than an accident of PostgREST's
-- default schema exposure.
--
-- Fixed-window algorithm, same reasoning as consume_rate_limit: simple and
-- good enough for an abuse guard, not billing-grade precision.
-- ============================================================================
create or replace function public.consume_anon_rate_limit(
  p_key text,
  p_route text,
  p_window_seconds int,
  p_max int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count int;
begin
  if p_key is null or length(p_key) = 0 then
    raise exception 'consume_anon_rate_limit: p_key is required' using errcode = '22023';
  end if;
  if p_route is null or length(p_route) = 0 then
    raise exception 'consume_anon_rate_limit: p_route is required' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'consume_anon_rate_limit: p_window_seconds must be positive' using errcode = '22023';
  end if;
  if p_max is null or p_max < 0 then
    raise exception 'consume_anon_rate_limit: p_max must be >= 0' using errcode = '22023';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.anon_rate_limits as rl (key, route, window_start, count)
  values (p_key, p_route, v_window_start, 1)
  on conflict (key, route, window_start)
    do update set count = rl.count + 1
  returning rl.count into v_count;

  -- Opportunistic cleanup: drop this key's own rows once their window is
  -- over a day stale. Scoped to p_key so this stays a cheap per-call
  -- tidy-up, not a table-wide scan — no separate cron job needed for a
  -- table this small. (The "global" key's own history is capped the same
  -- way, since it goes through this same path.)
  delete from public.anon_rate_limits
  where key = p_key
    and window_start < clock_timestamp() - interval '1 day';

  return v_count <= p_max;
end;
$$;

revoke all on function public.consume_anon_rate_limit(text, text, int, int) from public;
revoke all on function public.consume_anon_rate_limit(text, text, int, int) from anon;
revoke all on function public.consume_anon_rate_limit(text, text, int, int) from authenticated;
grant execute on function public.consume_anon_rate_limit(text, text, int, int) to service_role;

commit;
