# Content loop — "the DB is the content"

Weekend email + Instagram carousel, both built from the exact same
weekly selection (`scripts/lib/weekly-picks.mjs`): live `happenings` +
upcoming `events` for the coming Fri 17:00 → Sun 23:59 Europe/London, plus
genuine deals. Nothing here is hand-curated — it's a read of the DB.

## Weekly run

**Wednesday — Instagram carousel**

```bash
node --env-file=.env.local scripts/ig-carousel.mjs
```

Writes `scripts/out/ig-<date>/00.png … NN.png` + `caption.txt` (1080×1350,
cover + one slide per pick + CTA). Upload the PNGs as an IG carousel post,
paste `caption.txt`'s contents as the caption.

**Thursday afternoon — email digest** (the signup card promises "Thursday by 6pm", under £10)

How it's triggered:

1. Vercel Cron (`vercel.json`, `0 15 * * 4`) calls `GET /api/cron/weekly-email`
   (`app/api/cron/weekly-email/route.ts`). On Hobby the call lands anywhere
   in 15:00–15:59 UTC: 16:00–16:59 BST, 15:00–15:59 GMT. Under 6pm all year,
   so nothing changes when the clocks do.
2. The route checks Vercel's `Authorization: Bearer $CRON_SECRET` header, then
   calls GitHub's workflow_dispatch API for `weekly-content.yml` with
   `action=email-send`.
3. The Actions `email` job runs `scripts/fomo-friday.mjs --send`. The email
   arrives a few minutes after step 1.

Why not an Actions `schedule`: scheduled runs on this repo started 4–7 hours
late (7, 9 and 14 Oct). A dispatch starts within a minute or two. The
Thursday schedule was removed, not kept as a fallback, so there's only one
trigger and no way to send twice. If the cron fails (Vercel → Settings →
Cron Jobs shows the log; the route returns 503 when an env var is missing,
502 when GitHub refuses), send by hand: Actions → Weekly content → Run
workflow → `email-send`, or `gh workflow run weekly-content.yml -f action=email-send`.

The Wednesday carousel still uses the Actions schedule (`7 16 * * 3`); a
late run doesn't matter there.

Running it locally:

```bash
# 1. Dry run first — always. Writes HTML/text to scripts/out/, prints the
#    subscriber count only (never an address).
node --env-file=.env.local scripts/fomo-friday.mjs

# 2. Eyeball scripts/out/fomo-friday-<date>.html in a browser.

# 3. Optional: send yourself a test copy first.
node --env-file=.env.local scripts/fomo-friday.mjs --to=you@example.com

# 4. Send to every subscriber.
node --env-file=.env.local scripts/fomo-friday.mjs --send
```

Both scripts are read-only against the DB — they never write to
`happenings`, `events`, or `email_subscribers`. Both run on a schedule via
`.github/workflows/weekly-content.yml` (see above for how each is triggered).

## Weekly radar step ("Under the radar")

One hand-picked lesser-known Edinburgh place a week, shown on `/under-the-radar`,
in the Explore Collections rail and on the place's own page. It also adds an
optional "Under the radar this week" block to the email and a line to the
Instagram caption, but only when a pick is featured for that week.

Before the Wednesday carousel and the Thursday email (any time that week):

```bash
npx tsx --env-file=.env.local scripts/radar.ts suggest            # numbered candidates, read-only
npx tsx --env-file=.env.local scripts/radar.ts approve 3 --why "A courtyard cafe most people walk past"
npx tsx --env-file=.env.local scripts/radar.ts feature <place id>   # defaults to this week
```

`feature --week YYYY-MM-DD` picks another week (any date, rounded to that
week's Monday); featuring a pick clears any other pick for the same week. No
AI is involved, and `approve`, `feature` and `retire` take `--dry-run`. One-off
setup: run `supabase/add_place_radar.sql` in the Supabase SQL editor first.

How the hook behaves: `getWeeklyPicks` (`scripts/lib/weekly-picks.mjs`) returns
`radar`, the place featured for the Monday of the send weekend, or `null`. With
no featured pick, or before the SQL has run, or if the lookup fails, `radar` is
`null`, nothing renders and the digest is exactly what it was without it. A
failed lookup is logged and never stops the send.

## Env vars needed

| Var | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | both | already set |
| `SUPABASE_SERVICE_ROLE_KEY` | both | already set; server-only, never `NEXT_PUBLIC_` |
| `RESEND_API_KEY` | `fomo-friday.mjs --send` / `--to` | from [resend.com](https://resend.com) — API key with send permission |
| `FOMO_FROM_EMAIL` | `fomo-friday.mjs --send` / `--to` | e.g. `Fomo <friday@askfomo.com>` — must be on a domain verified in Resend (see below) |
| `SENDER_ADDRESS` | `fomo-friday.mjs` (dry-run warns, `--send`/`--to` refuse without it) | a real physical postal address — legally required, see checklist below |

`ig-carousel.mjs` needs only the two Supabase vars. The email job reads
these from the GitHub `Production` environment's secrets/vars.

The trigger needs two more, in **Vercel production** env vars (not GitHub):

| Var | Used by | Notes |
|---|---|---|
| `CRON_SECRET` | `app/api/cron/weekly-email` | random string, 16+ characters (`openssl rand -hex 32`). Vercel sends it as `Authorization: Bearer …` on every cron call; the route 401s anything else |
| `GITHUB_DISPATCH_TOKEN` | `app/api/cron/weekly-email` | fine-grained GitHub token, repository access `jasbir98/fomo` only, permission **Actions: Read and write**. Renew it before it expires, or Thursday's email silently stops (the cron log shows a 502) |

Redeploy after adding them. Crons only run on production deployments.

### Domain verification in Resend

Before `--send`/`--to` will actually deliver mail:

1. Add `askfomo.com` (or the sending subdomain, e.g. `mail.askfomo.com`) as
   a domain in the Resend dashboard.
2. Add the SPF/DKIM/DMARC DNS records Resend gives you.
3. Wait for the domain to show "Verified" in Resend before sending — an
   unverified domain's sends will bounce or land in spam.
4. `FOMO_FROM_EMAIL` must use that verified domain.

## Legal checklist (UK PECR / GDPR)

- [ ] `SENDER_ADDRESS` is a real physical postal address — every marketing
      email legally needs one. The rendered footer has a `{{SENDER_ADDRESS}}`
      placeholder until this is set.
- [ ] Every send includes a working one-click unsubscribe link
      (`https://askfomo.com/unsubscribe?token=…`) — already wired: each
      subscriber gets their own `unsubscribe_token`
      (`email_subscribers.unsubscribe_token`), and `/unsubscribe` +
      `/api/unsubscribe` are public (no login needed to opt out).
- [ ] `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
      headers are set on every send — already wired in `fomo-friday.mjs`'s
      `buildMessage()`, satisfying Gmail/Yahoo's 2024 bulk-sender rules.
- [ ] Only people who opted in via `/api/subscribe` (the honeypot-guarded
      signup route) are on the list — this pipeline never adds a row itself.
- [ ] Unsubscribes take effect immediately: `/api/unsubscribe` sets
      `unsubscribed_at` synchronously, and `fomo-friday.mjs` always queries
      `unsubscribed_at is null` fresh at send time — no cached list.
- [ ] Confirm the sending domain's SPF/DKIM/DMARC are verified in Resend
      (see above) before the first real send, so the digest doesn't land in
      spam and doesn't damage `askfomo.com`'s sending reputation.

## Files

- `scripts/lib/weekly-picks.mjs` — shared selection (picks + deals), used by
  both scripts below. Ports (not imports — plain `.mjs` can't import the
  app's TS modules) `lib/happenings/occurrence.ts`'s recurrence expansion and
  `lib/happenings/groups.ts`'s `isGenuineDeal`. If either of those change,
  this file's copies need updating too.
- `scripts/fomo-friday.mjs` — renders + sends the email.
- `app/api/cron/weekly-email/route.ts` + `vercel.json` `crons` — Thursday's
  trigger (dispatches `.github/workflows/weekly-content.yml`).
- `scripts/ig-carousel.mjs` — renders the IG carousel PNGs + caption.
- `app/unsubscribe/page.tsx` + `app/api/unsubscribe/route.ts` — the
  unsubscribe landing page and its GET/RFC-8058-one-click-POST API route.
