-- Launch-week hardening (2026-09). Safe to re-run.
--
-- 1. Revoke EXECUTE on trigger/event-trigger functions from API roles.
--    Neither can do anything when called directly (a trigger function errors
--    outside a trigger), but they're SECURITY DEFINER and there's no reason
--    for anon/authenticated to hold the grant. Triggers keep firing: they run
--    with the owner's rights regardless of these grants.
-- 2. email_events.svix_id + unique index: the Resend webhook stores the
--    delivery id and treats a repeat as already processed (replay dedupe).
--    The route falls back to inserting without svix_id until this runs.
-- 3. profiles.membership_tier can't be set or changed by the user themselves.
--    The own_rows policy lets a user update every column of their row; this
--    trigger pins membership_tier for anon/authenticated requests so it can
--    only ever be changed with the service role.

-- 1 ---------------------------------------------------------------------------
revoke execute on function public.handle_new_user() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- 2 ---------------------------------------------------------------------------
alter table email_events add column if not exists svix_id text;
create unique index if not exists email_events_svix_id_key on email_events (svix_id);

-- 3 ---------------------------------------------------------------------------
create or replace function public.protect_profile_tier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      new.membership_tier := null;
    else
      new.membership_tier := old.membership_tier;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.protect_profile_tier() from public, anon, authenticated;

drop trigger if exists profiles_protect_tier on profiles;
create trigger profiles_protect_tier
  before insert or update on profiles
  for each row execute function public.protect_profile_tier();
