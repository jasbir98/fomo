-- Fomo: event log for Resend webhook deliveries (app/api/resend/webhook/
-- route.ts) — sends, deliveries, opens, clicks, bounces, complaints, for
-- every email this account sends (not just Fomo Friday). Plain append-only
-- log today, no reads from any other route — a place to look when a
-- subscriber says "I never got the email" or when deliverability needs
-- investigating, and the source the webhook route reads `data.bounce.type`
-- / `data.click.link` from before deciding whether to unsubscribe someone.
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql has already been applied. Idempotent — safe to re-run.

create table if not exists email_events (
  id uuid primary key default gen_random_uuid(),
  -- Resend's own id for the email this event is about (`data.email_id` in
  -- the webhook payload). Nullable — not every event type is guaranteed to
  -- carry one, and a missing id shouldn't block logging the rest of the
  -- event.
  resend_email_id text,
  -- e.g. "email.sent" | "email.delivered" | "email.opened" | "email.clicked"
  -- | "email.bounced" | "email.complained" | "email.delivery_delayed" — free
  -- text, not an enum, since Resend can add event types without this schema
  -- needing a migration to accept them.
  type text not null,
  recipient text,
  -- Only set for "email.clicked" events — the URL that was clicked.
  clicked_link text,
  -- The full webhook payload, for anything not promoted to its own column
  -- above (bounce type/subtype, click user agent, etc.) without needing a
  -- schema change every time Resend adds a field.
  raw jsonb,
  created_at timestamptz not null default now()
);

alter table email_events enable row level security;
-- No policies — this is a server-only write-and-read log: the webhook
-- route writes with the service-role client (bypasses RLS), and nothing
-- reads it from the browser today. Same "service-role only" shape as
-- api_rate_limits/anon_rate_limits.

create index if not exists email_events_type_idx on email_events (type);
create index if not exists email_events_recipient_idx on email_events (recipient);
create index if not exists email_events_resend_email_id_idx on email_events (resend_email_id);
create index if not exists email_events_created_at_idx on email_events (created_at);
