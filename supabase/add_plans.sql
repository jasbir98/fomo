-- Shareable weekend plans (askfomo.com/plan/<id>) — docs/plans/2026-10-14-weekend-plan.md.
--
-- One row per distinct set of picks. `items` is a snapshot built by
-- POST /api/plans from the live happenings/events rows (never from client
-- text), so the landing page and its receipt OG image render from this one
-- row and stay correct after an event ends. `items_hash` (the sorted
-- kind:id:day refs) is unique, so the same picks always give the same link.
--
-- Service-role only: the API route inserts and the /plan page reads with the
-- service-role client. No anon/authenticated access at all, so nobody can
-- list every plan through PostgREST.
--
-- Safe to run before or after the app deploy (until it exists, "Make link"
-- says it couldn't make the link). Safe to re-run.

create table if not exists public.plans (
  id text primary key check (id ~ '^[A-Za-z0-9]{8}$'),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 4),
  items_hash text not null unique,
  created_at timestamptz not null default now()
);

alter table public.plans enable row level security;
revoke all on public.plans from anon, authenticated;
