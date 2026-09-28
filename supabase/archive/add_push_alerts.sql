-- Fomo: Web push for "Book early" on-sale alerts.
--
-- Two triggers (see docs/push-notifications.md for the full flow):
--   (a) per-item opt-in — a user taps "Notify me" on a Book Early card whose
--       booking_opens_at is still in the future (supabase/add_happenings_booking.sql).
--   (b) automatic "Big on-sale alerts" — a per-user setting; when on, the
--       user gets pushed for any high sellout_risk happening opening now,
--       with no per-item opt-in required.
--
-- Depends on supabase/add_happenings_booking.sql having been run first (adds
-- `booking_opens_at` / `sellout_risk` / `sellout_note` to `happenings`) —
-- run that migration BEFORE this one. This file only adds new objects and
-- references `happenings(id)`, which already exists from add_happenings.sql
-- regardless of run order for that part.
--
-- Idempotent — safe to re-run.

-- ============================================================================
-- PUSH SUBSCRIPTIONS — one row per browser/device endpoint the user has
-- granted Notification permission on and registered a Service Worker
-- PushSubscription for. A user can have several (phone + laptop).
-- ============================================================================
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,

  -- The PushSubscription's own endpoint URL is globally unique per
  -- browser+device registration — this is the natural upsert key (re-
  -- subscribing the same device, e.g. after a permission re-grant, should
  -- replace the row, not duplicate it).
  endpoint text not null unique,
  p256dh text not null,   -- PushSubscription.toJSON().keys.p256dh
  auth text not null,     -- PushSubscription.toJSON().keys.auth
  user_agent text,

  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  -- Incremented on any send error that ISN'T a 404/410 (which instead
  -- deletes the row outright — see the onsale-alerts function). A rising
  -- failure_count with no last_success_at movement is a dead/misbehaving
  -- endpoint worth pruning by hand later; not auto-deleted on count alone
  -- since transient provider errors are expected.
  failure_count int not null default 0
);

alter table push_subscriptions enable row level security;
drop policy if exists "own_rows" on push_subscriptions;
create policy "own_rows" on push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

-- ============================================================================
-- ONSALE ALERTS — per-item opt-in. One row = "notify me when this
-- happening's booking opens." Deleted (not just flagged) on unsubscribe;
-- `notified_at` is set by the sender once the "opening now" push for this
-- row has actually gone out, so a re-run within the same 5-minute cadence
-- doesn't re-notify (see push_notification_log below for the real dedupe
-- guard — `notified_at` here is a fast, redundant skip-check for the
-- opt_in reason, not the source of truth).
-- ============================================================================
create table if not exists onsale_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  happening_id uuid not null references happenings(id) on delete cascade,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (user_id, happening_id)
);

alter table onsale_alerts enable row level security;
drop policy if exists "own_rows" on onsale_alerts;
create policy "own_rows" on onsale_alerts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists onsale_alerts_user_idx on onsale_alerts (user_id);
create index if not exists onsale_alerts_happening_idx on onsale_alerts (happening_id);

-- ============================================================================
-- PROFILES — "Big on-sale alerts" setting. A top-level boolean column, not
-- folded into the existing `notification_settings` jsonb
-- (supabase/add_profile_settings.sql): that jsonb is a fixed
-- TypeScript-union shape (NotificationSettings in lib/types.ts) owned by the
-- Profile settings sheet's existing merge-over-defaults logic, and this
-- toggle additionally drives a real side effect (ensuring a push
-- subscription exists) that the other three don't — keeping it a distinct
-- column makes that difference visible in the schema instead of buried in a
-- blob.
-- ============================================================================
alter table profiles
  add column if not exists big_onsale_alerts boolean not null default false;

-- ============================================================================
-- PUSH NOTIFICATION LOG — service-role only. The actual dedupe guard: the
-- sender INSERTs a row here first and only sends if the insert succeeded
-- (unique violation = already sent = skip), rather than checking-then-
-- sending (a check-then-act race across two cron ticks that overlap).
--
-- No RLS policies at all (RLS is enabled with zero policies, same shape as
-- `happening_sources`/`happenings_staging`'s "service role only" tables) —
-- a signed-in user has no reason to read or write their own send history
-- directly; the Profile page's permission-status line is derived from
-- `Notification.permission` client-side and from `push_subscriptions`
-- existing, not from this table.
-- ============================================================================
create table if not exists push_notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  happening_id uuid not null references happenings(id) on delete cascade,
  reason text not null check (reason in ('opt_in', 'big_alert', 'opt_in_24h')),
  sent_at timestamptz not null default now(),
  unique (user_id, happening_id, reason)
);

alter table push_notification_log enable row level security;
-- No policies — service role only (bypasses RLS). Matches happening_sources'
-- "no write policy at all" shape, plus no read policy either since nothing
-- client-side needs to query it.
