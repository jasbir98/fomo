# Web push for "Book early" on-sale alerts

Setup checklist for turning this feature on. Nothing here can be tested from
inside this session — no VAPID keys exist yet, the app isn't deployed over
HTTPS, and no one is signed in — so follow this in order and verify at the
end with a real test happening.

## 1. Generate a VAPID keypair

```
npx web-push generate-vapid-keys
```

This prints a public and a private key. **Never commit the private key or
paste it into a file in this repo.** Store it only in env vars (below).

## 2. Env vars

`.env.local` (and the same names in Vercel's project settings once deployed):

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<the public key>
```

That's the only one the Next.js app needs — it's inlined into the client
bundle at build time and is what turns `NOTIFY_ME_ENABLED`
(`lib/happenings/book-early.ts`) on. The private key never goes here; it only
goes into the Edge Function's own secrets (step 5).

## 3. Run the migrations, in this order

```
1. supabase/add_happenings_booking.sql   (adds booking_opens_at / sellout_risk / sellout_note)
2. supabase/add_push_alerts.sql          (push_subscriptions, onsale_alerts, push_notification_log,
                                           profiles.big_onsale_alerts)
```

Run each in the Supabase SQL editor (or via the CLI against your project).
Both are idempotent — safe to re-run if you're not sure they applied.

## 4. Deploy the app over HTTPS

Web Push (and Service Workers generally) require a secure context. Vercel's
default deploy gives you this for free — see the README's existing "Deploy"
section. Nothing push-related works against `http://localhost` on a phone;
`https://localhost` in desktop Chrome during dev is fine.

## 5. Deploy the Edge Function + secrets

```
supabase functions deploy onsale-alerts

supabase secrets set \
  VAPID_PUBLIC_KEY=<the public key from step 1> \
  VAPID_PRIVATE_KEY=<the private key from step 1 — never paste this into a repo file> \
  VAPID_SUBJECT=mailto:you@example.com \
  CRON_SECRET=<a long random string you generate yourself, e.g. `openssl rand -hex 32`>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already available to every
Edge Function automatically — don't set those yourself.

## 6. Schedule the sender

Open `supabase/schedule_onsale_alerts.sql`, replace
`https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/onsale-alerts` with your
project's real function URL, and run it. It uses Supabase Vault to store
`CRON_SECRET` server-side rather than inline — follow the one-time
`vault.create_secret(...)` step in that file's comment first, using the exact
same value you set as the function's `CRON_SECRET` secret in step 5.

## 7. iPhone-specific note

iOS Safari only supports Web Push once a site has been **Added to Home
Screen** (iOS 16.4+), and only from inside that installed app — a normal
Safari tab can't request notification permission at all. `lib/push/client.ts`
detects this case (`isIOSNotStandalone`) and the UI shows "Add Fomo to your
Home Screen to get alerts" instead of a broken permission prompt. Desktop
Chrome/Firefox/Edge and Android Chrome all support it directly, no install
step needed.

## How it works end to end

- **Per-item opt-in**: a Book Early card whose booking hasn't opened yet
  (tier 1 — `booking_opens_at` within 14 days) shows a "Notify me" button.
  Tapping it calls `ensurePushSubscribed()` (requests Notification
  permission, subscribes via the Service Worker, POSTs the subscription to
  `/api/push/subscribe`), then POSTs `{ happeningId }` to `/api/alerts`,
  which upserts a row in `onsale_alerts`. Same flow on the happening detail
  page (`app/(shell)/happening/[id]/page.tsx`) when `booking_opens_at` is in
  the future.
- **Big on-sale alerts**: a toggle in Profile → Notifications
  (`app/(shell)/profile/page.tsx`). Turning it on also calls
  `ensurePushSubscribed()` first (the setting is meaningless without a live
  subscription), then sets `profiles.big_onsale_alerts = true`.
- **Sender**: the `onsale-alerts` Edge Function runs every 5 minutes.
  - "Opening now" — any live happening whose `booking_opens_at` falls in the
    last 30 minutes: every user with an `onsale_alerts` row for it gets
    pushed (`reason: 'opt_in'`), and if `sellout_risk = 'high'`, every user
    with `big_onsale_alerts = true` also gets pushed (`reason: 'big_alert'`)
    — these are independent triggers, so a user who did both gets two
    notifications (the Service Worker's `tag` collapses them into one
    visible notification on the device).
  - "24h heads-up" — opt-in users only, ~24 hours before
    `booking_opens_at` (`reason: 'opt_in_24h'`).
  - Dedupe: the function inserts into `push_notification_log` (unique on
    `user_id, happening_id, reason`) **before** sending; if the insert hits
    the unique constraint, it skips — safe against overlapping/late cron
    runs.
  - A 404/410 from a push send deletes that `push_subscriptions` row (the
    endpoint is dead); any other error increments `failure_count`.
- **Notification tap**: `public/sw.js`'s `notificationclick` handler focuses
  an existing Fomo tab (navigating it to the happening) or opens a new one.

## Testing without a real deploy

You can't fully test push delivery without an HTTPS deploy, a signed-in
user, and real VAPID keys — none of which exist in this session. Once all of
the above is done:

1. In Supabase, set a real happening's `booking_opens_at` to ~2 minutes in
   the future (and `sellout_risk = 'high'` if you want to test the big-alert
   path too):
   ```sql
   update happenings
   set booking_opens_at = now() + interval '2 minutes', sellout_risk = 'high'
   where id = '<a real happening id>';
   ```
2. On your phone (or desktop), open the deployed app, sign in, tap "Notify
   me" on that happening's Book Early card (or turn on Big on-sale alerts in
   Profile).
3. Wait for `booking_opens_at` to be in the past, then invoke the function
   manually rather than waiting for the next cron tick:
   ```sh
   curl -X POST 'https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/onsale-alerts' \
     -H "Authorization: Bearer <YOUR-CRON-SECRET>"
   ```
4. You should get a push notification within seconds, and the function's
   JSON response reports `{ checked, candidates, sent, failed,
   deletedSubscriptions }`.

## What's implemented vs. what's untested

Everything above is implemented and type-checks. What has **not** been
exercised, because it requires the deploy this task explicitly avoids:

- Actually receiving a push notification on a real device.
- The Service Worker's `push`/`notificationclick` handlers running against a
  real push payload.
- The Edge Function running against a real Supabase project (`deno check`
  was run for static correctness — see the verification notes in this task's
  report — but `supabase functions deploy` / `serve` was not).
- `pg_cron` + `pg_net` actually firing the scheduled job.
- RLS behavior against a real authenticated session (reasoned through
  against `supabase/harden_rls.sql`'s existing `own_rows` pattern, not run).

The pure selection/dedupe logic in
`supabase/functions/onsale-alerts/select.ts` **was** unit-checked with
fixture data (opening-now window, big-alert rule, 24h heads-up, and dedupe
via `alreadyLogged`) — see the task report for the fixture script's output.
