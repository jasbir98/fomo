-- add_finds.sql — Finds: the small, hand-approved list of steals ("Fomo Finds"
-- on Instagram, shown in the app as "For you").
-- See docs/plans/2026-10-12-fomo-finds.md.
--
-- Run once, by hand, in the Supabase SQL editor. Idempotent — safe to re-run.
-- It can be run before or after the app deploy: until the table exists the app
-- (lib/db/finds.ts) treats "no finds table" as "no Finds" and the For you
-- page shows its empty state.
--
-- finds: one row per steal. A row points at either a provider event (`events`)
--   or a happening (`happenings`, which also holds deals) the same way
--   saved_items does (subject_type + subject_id, no FK because it's polymorphic).
--   why         one line on why it's a steal, in the Instagram "Fomo Finds" voice
--   fomo_level  1-5, the "Fomo level" meter from the IG slides
--   score       the suggest script's ranking score (lib/happenings/hero.ts), for audit
--   status      suggested -> live (approved by a person) -> retired (ended or
--               taken down). Nothing goes live without `scripts/finds.ts approve`.
--   week_of     the Friday of the week it was suggested for
--   Only unapproved drafts are ever deleted (`scripts/finds.ts clear-suggested`,
--   and `suggest` dropping drafts whose subject has ended), so a retired or
--   rejected subject is remembered and not suggested again.
--
-- RLS: only SIGNED-IN users (`authenticated`) can read LIVE rows (suggested/
-- retired rows are the curator's working set). `anon` has no policy and no
-- grant, so the full list can't be read with the public anon key that ships in
-- the browser. Signed-out visitors see a 2-pick teaser that the server reads
-- with the service role (lib/finds/load.ts, GET /api/finds) -- that is the only
-- door to the list for anyone not signed in. No insert/update/delete policy, so
-- only the service role (scripts/finds.ts, which bypasses RLS) can write.

create table if not exists finds (
  id           uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('event', 'happening')),
  subject_id   uuid not null,
  why          text not null,
  fomo_level   smallint not null check (fomo_level between 1 and 5),
  score        numeric,
  status       text not null default 'suggested' check (status in ('suggested', 'live', 'retired')),
  week_of      date,
  created_at   timestamptz default now(),
  approved_at  timestamptz,
  -- An item can be a Find once. Re-suggesting upserts this row rather than adding another.
  unique (subject_type, subject_id)
);

create index if not exists finds_status_idx on finds (status);

alter table finds enable row level security;

drop policy if exists "read_live" on finds;
create policy "read_live" on finds
  for select
  to authenticated
  using (status = 'live');

-- Verify (read-only): one policy, cmd SELECT, roles {authenticated}, qual
-- (status = 'live'). No policy lists anon.
-- select policyname, roles, cmd, qual from pg_policies
-- where schemaname = 'public' and tablename = 'finds';

-- Belt and braces, same as lock_pipeline_tables.sql: RLS already has no write
-- policy, and this also drops the default table grants, so only the service
-- role (scripts/finds.ts) can ever write. anon also loses SELECT outright, so
-- the signed-out door stays shut even if a policy is added by mistake.
revoke insert, update, delete on finds from anon, authenticated;
revoke select on finds from anon;
