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

**Thursday ~5pm — email digest** (GitHub Actions `weekly-content.yml`, cron `7 16 * * 4` UTC: 17:07 BST, 16:07 GMT; the signup card promises "Thursday by 6pm", under £10)

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
`happenings`, `events`, or `email_subscribers`. Recommended: wire these two
as scheduled runs (cron / GitHub Actions, same as `scripts/daily-sources.mjs`
and `scripts/sweep-happenings.mjs` already are) once the env vars below are
set somewhere the scheduler can read them.

## Env vars needed

| Var | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | both | already set |
| `SUPABASE_SERVICE_ROLE_KEY` | both | already set; server-only, never `NEXT_PUBLIC_` |
| `RESEND_API_KEY` | `fomo-friday.mjs --send` / `--to` | from [resend.com](https://resend.com) — API key with send permission |
| `FOMO_FROM_EMAIL` | `fomo-friday.mjs --send` / `--to` | e.g. `Fomo <friday@askfomo.com>` — must be on a domain verified in Resend (see below) |
| `SENDER_ADDRESS` | `fomo-friday.mjs` (dry-run warns, `--send`/`--to` refuse without it) | a real physical postal address — legally required, see checklist below |

`ig-carousel.mjs` needs only the two Supabase vars.

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
- `scripts/ig-carousel.mjs` — renders the IG carousel PNGs + caption.
- `app/unsubscribe/page.tsx` + `app/api/unsubscribe/route.ts` — the
  unsubscribe landing page and its GET/RFC-8058-one-click-POST API route.
