# Supabase

## What's here

- **`archive/`** — every historical migration/seed file, already applied to
  production. Reference only for how the schema evolved — see
  `archive/README.md`'s warning before opening any of them. Never run one
  against prod.
- **`functions/onsale-alerts/`** — the Edge Function that sends "Book early"
  push notifications, invoked every 5 minutes by pg_cron (see
  `archive/schedule_onsale_alerts.sql`). Deployed separately via the Supabase
  CLI; not touched by anything below.
- **Pending migrations** (below) — not yet applied everywhere, or applied but
  still checked in until confirmed live across every environment.

## Pending (run in order)

1. **`tighten_public_inserts.sql`** — drops the `anon_insert` policies on
   `email_subscribers` and `tips`. `/api/subscribe` and `/api/tips` insert
   with the service-role client, so the policies only left a hole: anyone
   with the public anon key could POST rows straight to PostgREST, skipping
   the routes' rate limit, honeypot and validation. Safe to run now (the
   `/api/tips` switch is deployed). Safe to re-run.
2. **`harden_2026_09.sql`** — revokes EXECUTE on the trigger functions
   (`handle_new_user`, `rls_auto_enable`) from anon/authenticated; adds
   `email_events.svix_id` + unique index (webhook replay dedupe); a trigger
   that stops users setting/changing their own `profiles.membership_tier`.
   Safe to re-run.

3. **`lock_pipeline_2026_09.sql`** — drops the anon write policies still
   live on `happenings_staging`, `places_staging`, `place_sources` and
   `place_photos` (found by `verify_security.sql` on 2026-09-29), makes the
   staging/provenance tables service-role only, keeps `place_photos`
   read-only, and caps the `avatars` bucket at 5 MB / jpeg-png-webp.

4. **`add_finds.sql`** — creates the `finds` table (Fomo Finds, the
   hand-approved steals list) with RLS: anon/authenticated read `live` rows
   only, writes are service-role only (`scripts/finds.ts`). Safe to run before
   or after the app deploy (the app shows no Finds until it exists). Safe to
   re-run.

5. **`add_plans.sql`** — creates the `plans` table for shareable weekend
   plans (askfomo.com/plan/<id>). RLS on with no policies: service-role
   only (`POST /api/plans` writes, the /plan page reads). Until it runs,
   "Make link" says it couldn't make the link; nothing else breaks. Safe to
   re-run.

Then run **`verify_security.sql`** (read-only, one result set) and check it
shows no `no_rls`, `anon_write_policy`, `legacy_table` or
`anon_exec_definer_fn` rows.

Once a pending file has been confirmed applied in every environment that
matters, move it into `archive/` (see "How to add a migration" below).

## Current schema

Tables as they exist after `archive/drop_legacy.sql` (applied 2026-09-28). "RLS model":
`own_rows` = scoped to `auth.uid()`, only the signed-in owner; `read_all` =
`select` open to `anon, authenticated`, writes service-role only;
`service-role-only` = no client-side access at all, read or write.

| Table | Purpose | Written by | Read by | RLS model |
|---|---|---|---|---|
| `profiles` | User account row (avatar, settings, `big_onsale_alerts`) | User, via `lib/db/profile.ts` (`supabaseServer()`) + `handle_new_user` trigger on signup | User themselves | `own_rows` |
| `chat_messages` | "Ask Fomo" chat history, per user | User, via `lib/db/chat.ts` / `app/api/chat` | User themselves | `own_rows` |
| `saved_items` | The Saved-list shortlist (places/events/happenings) | User, via `lib/db/saved.ts` / `app/api/saved` | User themselves | `own_rows` |
| `push_subscriptions` | Web push subscription per device | User, via `lib/db/push.ts` / `app/api/push/subscribe` | Service role (`onsale-alerts` Edge Function sender) | `own_rows` |
| `onsale_alerts` | Per-happening "Notify me" opt-ins | User, via `lib/db/push.ts` / `app/api/alerts` | User themselves; service role (Edge Function) | `own_rows` |
| `push_notification_log` | Append-only send log for the alerts sender (dedupe source of truth) | Service role only (`onsale-alerts` Edge Function) | Service role only | service-role-only |
| `places` | Curated + Google-cached venue catalog | Pipeline: `scraper/upsert_places.py` → `places_staging` → `scripts/promote-places.mjs` (service role) | Everyone (place detail, Explore, Map, feed) | `read_all` |
| `place_photos` | Per-place photo carousel + list thumbnail, with provenance | Same pipeline (service role) | Everyone (`lib/db/places.ts`) | `read_all` |
| `place_sources` | Per-field citation provenance for promoted places | Same pipeline (service role) | Not read by the app today; kept readable for pipeline debugging | `read_all` |
| `places_staging` | Review queue for scraped/extracted places before promotion | `scraper/upsert_places.py` (service role) | `scripts/promote-places.mjs` (service role) | service-role-only |
| `events` | Skiddle + Ticketmaster event cache | `scripts/daily-sources.mjs` (GitHub Actions, service role; proactive crawl + API pull) | Everyone (`lib/db/events.ts` — feed/explore/chat) | `read_all` |
| `happenings` | "What's On" money/access deals catalog (discounts, free-entry days, Book Early offers) | Pipeline: `scraper/happenings_research.py` → `scraper/upsert_happenings.py` → `happenings_staging` → `scripts/promote-happenings.mjs` (service role) | Everyone (`lib/db/happenings.ts`) | `read_all` |
| `happening_sources` | Per-field citation provenance for promoted happenings | Same pipeline (service role) | Not read by the app today; kept readable, same as `place_sources` | `read_all` |
| `finds` | Fomo Finds: the hand-approved list of steals (a `why` line + 1-5 Fomo level pointing at an event or happening) | `scripts/finds.ts` (service role): `suggest` drafts, a person `approve`s | Everyone, `live` rows only (`lib/db/finds.ts`, `/finds`, `/api/finds`) | `read_all` for `status = 'live'` only; writes service-role only |
| `happenings_staging` | Review queue for scraped happenings before promotion | `scraper/upsert_happenings.py` (service role) | `scripts/promote-happenings.mjs`, `scripts/sweep-happenings.mjs` (service role) | service-role-only |
| `email_subscribers` | "Fomo Friday" weekly digest mailing list | Public, `POST /api/subscribe` (service-role insert; anon-insert policy still open until `tighten_public_inserts.sql` runs) | Service role only (`scripts/fomo-friday.mjs` send job, `/api/unsubscribe`, `/api/resend/webhook`) | write-only mailbox → service-role-only after `tighten_public_inserts.sql` |
| `email_events` | Append-only Resend webhook delivery log (sends/opens/clicks/bounces) | `app/api/resend/webhook` (service role) | Service role only (ad hoc, e.g. "did this subscriber get the email") | service-role-only |
| `tips` | User-submitted deal/event leads for review | Public, `POST /api/tips` (service-role insert; anon-insert policy still open until `tighten_public_inserts.sql` runs) | Service role only, ad hoc (no dedicated admin script yet) | write-only mailbox → service-role-only after `tighten_public_inserts.sql` |
| `plans` | Shareable weekend plans: 1–4 frozen picks (title, day, price, image) per short id | `POST /api/plans` (service role), built from live happenings/events rows | `/plan/[id]` page and its OG image (service role) | service-role-only |
| `api_rate_limits` | Per-user rate-limit counters (chat, translate) | `consume_rate_limit()` RPC only (security definer, `EXECUTE` granted to `authenticated`, revoked from `anon`) | Same RPC | RPC-only, no direct table policy |
| `anon_rate_limits` | IP-hashed / global rate-limit counters (subscribe, tips, chat's global cap) | `consume_anon_rate_limit()` RPC only (security definer, `EXECUTE` granted to `service_role` only) | Same RPC | RPC-only, no direct table policy |

## RPCs + trigger

- **`consume_rate_limit(p_route, p_limit, p_window_seconds)`** — per-user
  rate limiting, `security definer`, scopes every read/write to
  `auth.uid()` internally. `EXECUTE` granted to `authenticated` only. See
  `lib/rate-limit.ts`.
- **`consume_anon_rate_limit(p_key, p_route, p_window_seconds, p_max)`** —
  IP-hashed/global rate limiting, `security definer`. `EXECUTE` granted to
  `service_role` only — always called from server code via
  `supabaseAdmin()`, never reachable by an anon/authenticated client
  directly.
- **`rls_auto_enable`** — Supabase's own built-in auto-enable-RLS helper, not
  something this app added.
- **`handle_new_user()` + `on_auth_user_created` trigger** — on `auth.users`
  insert, creates the matching `profiles` row. Current definition lives in
  `archive/drop_device_id.sql` (the last file to redefine it).

## Storage

- **`avatars`** bucket (public). RLS on `storage.objects`: `avatars_own_folder`
  — `authenticated` only, scoped to `(storage.foldername(name))[1] =
  auth.uid()::text`. No anon policy.

## pg_cron

`archive/schedule_onsale_alerts.sql` sets up a pg_cron + pg_net job calling
the `onsale-alerts` Edge Function every 5 minutes. **The checked-in file has
a placeholder project ref** — it only actually schedules anything if someone
edited in the real ref and ran it by hand in the SQL editor. Don't assume the
cron job is live; verify with `select * from cron.job;` in the SQL editor
before relying on push alerts firing.

## Verify live policies

Read-only — paste into the Supabase SQL editor to audit the current state of
any project.

```sql
-- Tables with RLS on/off
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

-- Every policy, with its role/command/expression
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- Flag: any policy granting anon/public write access
select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  and (roles && array['anon', 'public']::name[]);

-- security definer functions in public, and whether anon can execute them
select
  p.proname,
  p.prosecdef as security_definer,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname;
```

Expect: no rows from the third query (nothing anon/public-writable). The
fourth query should show `consume_rate_limit` with `authenticated_can_execute
= true, anon_can_execute = false`, `consume_anon_rate_limit` with both false,
and `handle_new_user` (trigger function, not meant to be called directly) —
review anything else that shows up.

## How to add a migration

1. New `.sql` file directly in `supabase/` (not `archive/`).
2. Make it idempotent — `if not exists` / `if exists` / `on conflict` so a
   re-run is always safe.
3. Never re-create an `anon_write`/`anon_all`/permissive policy on a table
   this README lists as `read_all` or `service-role-only` — pipeline and
   mailbox writes go through the service-role client
   (`lib/supabase/admin.ts`'s `supabaseAdmin()`), not a client-facing policy.
4. Add it to the **Pending** list above with a one-line note on what it does
   and any run-order dependency.
5. Once it's confirmed applied everywhere that matters, `git mv` it into
   `archive/`, add its row to `archive/README.md` in applied-date order, and
   remove it from **Pending** here.
