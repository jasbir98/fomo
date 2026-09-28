-- Fomo: user-submitted tips for deals/events we're missing — the community
-- feedback loop for curating the Edinburgh wedge. Tips are write-only from
-- the client (POST /api/tips, app/api/tips/route.ts, is public — see
-- proxy.ts's PUBLIC_POST_PREFIXES) and always go to review, never
-- auto-publish. Admin tooling uses the service-role key to read, approve/
-- reject with notes, and promote to social_posts.
--
-- Run this once in the Supabase SQL Editor against a project where
-- schema.sql has already been applied. Idempotent — safe to re-run.

create table if not exists tips (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text not null,
  url text,
  details text,
  when_text text,
  price_text text,
  submitter_kind text check (submitter_kind in ('student', 'local', 'venue', 'other')),
  contact_email text,
  user_id uuid references auth.users on delete set null,
  status text not null default 'new' check (status in ('new', 'approved', 'rejected', 'duplicate')),
  review_note text
);

-- Indices for admin queries — filtering/sorting by status, tracking submissions.
create index if not exists tips_status_idx on tips (status);
create index if not exists tips_created_at_idx on tips (created_at desc);
create index if not exists tips_user_id_idx on tips (user_id);

alter table tips enable row level security;

-- Anyone (signed in or not) may add a tip; nobody may read, change, or remove
-- a row from the client — write-only mailbox, same shape as email_subscribers.
-- The admin review job and tooling use the service-role key, which bypasses RLS.
drop policy if exists "anon_insert" on tips;
create policy "anon_insert" on tips for insert to anon, authenticated with check (
  status = 'new' and review_note is null
  -- no attributing a tip to someone else's account via the anon REST API
  and (user_id is null or user_id = auth.uid())
);
