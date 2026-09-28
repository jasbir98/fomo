-- Fomo: email capture for the weekly "Fomo Friday" digest — the retention
-- loop for the Edinburgh wedge, and deliberately account-free (POST
-- /api/subscribe, app/api/subscribe/route.ts, is public — see proxy.ts's
-- PUBLIC_POST_PREFIXES). No RLS-scoped `own_rows` shape here: an
-- anonymous visitor has no session to scope to, so this is a write-only
-- mailbox instead — anon/authenticated may INSERT, nobody may SELECT/UPDATE/
-- DELETE from the client (the weekly send job reads this table with the
-- service-role key, which bypasses RLS entirely).
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql has already been applied. Idempotent — safe to re-run.

create table if not exists email_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  -- Lowercased + trimmed copy of `email`, generated so the uniqueness check
  -- below can't drift from the stored value the way a separately-maintained
  -- column could (e.g. a future direct SQL edit of `email` alone).
  email_normalized text generated always as (lower(trim(email))) stored,
  -- Where the signup happened — 'weekend' | 'home' | 'signup' today (see
  -- SubscribeCard's callers); left as free text, not an enum, since new
  -- mount points are expected and shouldn't need a migration to add.
  source text,
  -- Optional deal-eligibility groups (e.g. student, over-60) this subscriber
  -- opted into, for a future targeted send. Null/empty means "everyone" —
  -- SubscribeCard doesn't collect this yet, so it's write-capacity for a
  -- later form, not something the current route populates.
  who text[],
  created_at timestamptz not null default now(),
  unsubscribed_at timestamptz,
  -- Unguessable token for a one-click unsubscribe link in the digest email —
  -- never the row's own `id`, so leaking one doesn't expose row enumeration
  -- order via sequential lookups (both are UUIDs here, but keeping them
  -- separate means rotating one scheme later doesn't touch the other).
  unsubscribe_token uuid not null default gen_random_uuid()
);

-- The real uniqueness guard — one row per normalized email, so re-submitting
-- the same address (any casing/whitespace) from a second source is a no-op,
-- not a duplicate row. /api/subscribe treats the resulting 23505 as success.
create unique index if not exists email_subscribers_email_normalized_key
  on email_subscribers (email_normalized);

create index if not exists email_subscribers_source_idx on email_subscribers (source);

alter table email_subscribers enable row level security;

-- Anyone (signed in or not) may add themselves to the list; nobody may read,
-- change, or remove a row from the client — same "write-only mailbox" shape
-- as social_posts' scrape-only paths, but inverted (insert-only here vs.
-- read-only there). The weekly digest job and any admin tooling use the
-- service-role key, which bypasses RLS, so no select policy is needed for
-- them.
drop policy if exists "anon_insert" on email_subscribers;
create policy "anon_insert" on email_subscribers for insert to anon, authenticated with check (true);
