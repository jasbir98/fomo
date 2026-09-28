# Analytics — PostHog

Product analytics, session replay and surveys, on top of the existing
Vercel Analytics (page views) and Vercel Speed Insights (performance). All
new: `instrumentation-client.ts` (init), `next.config.ts` (reverse proxy),
`components/analytics/*` (consent + identity), `lib/analytics/track.ts`
(the one call site every event goes through).

## How it's wired

- **Init**: `instrumentation-client.ts` — Next 15.3+'s convention, runs once
  before the rest of the client bundle. No-ops entirely (posthog-js is never
  even initialised) if `NEXT_PUBLIC_POSTHOG_KEY` is unset.
- **EU hosting + same-origin proxy**: `api_host: "/ingest"`,
  `ui_host: "https://eu.posthog.com"`. `next.config.ts` rewrites
  `/ingest/static/*` → `eu-assets.i.posthog.com` and `/ingest/*` →
  `eu.i.posthog.com`, so every capture/decide/flags/replay call is
  same-origin (no extra CSP entries needed — `connect-src 'self'` and
  `script-src 'self'` already cover it; `worker-src blob:` for session
  replay was already in the CSP). `skipTrailingSlashRedirect: true` stops
  Next's own trailing-slash redirect racing the rewrite.
- **Dev**: still initialises (so events are testable locally) but starts
  opted out via `opt_out_capturing_by_default`, unless
  `NEXT_PUBLIC_POSTHOG_DEBUG=1` is set in `.env.local`.
- **Consent (UK PECR)**: `components/analytics/ConsentBar.tsx`, mounted once
  in `AppShell` (so it's never shown on `/signin`/`/welcome`, which sit
  outside the shell). Before a choice, PostHog runs with
  `persistence: "memory"` — nothing written to cookies/localStorage, events
  still flow for the current page load. Tapping **OK** calls
  `posthog.set_config({ persistence: "localStorage+cookie" })`; **No
  thanks** leaves memory persistence in place. Either way the choice is
  remembered in `localStorage["fomo:consent"]` and the bar never asks again.
- **Identity**: `components/analytics/IdentifyUser.tsx`, also mounted once
  in `AppShell`. Watches `supabaseBrowserAuth().auth.onAuthStateChange`;
  on sign-in calls `posthog.identify(user.id, {...})` with
  `signin_method`, `fomo_status`, `who_groups`, `interests_count`, `budget`,
  `prefs_set` — **never the email address**. On sign-out, `posthog.reset()`.
  Also registers three super properties on every event: `signed_in`,
  `standalone` (installed PWA vs browser tab), `prefs_set`.
- **Events**: `lib/analytics/track.ts` exports `track(event, props)` — a
  safe no-op wrapper around `window.posthog?.capture`. Every call site below
  goes through this (or the shared `trackOutboundClicked`/`priceBand`
  helpers in the same file).

## Event taxonomy

| Event | Properties | Fired from |
|---|---|---|
| `card_opened` | `kind` (happening/event/place), `id`, `source` (happening's own kind, or "series"/"recurring"/"event"/"venue_group"), `surface`, `position`, `price_band` (free/paid/unknown) | `FeedListCard`, `FeedHero`/`HappeningHero`, `TodaysDealsStrip`, `BookEarlyCard`, `VenueDealCard` — everywhere a card navigates to a detail page |
| `outbound_clicked` | `kind`, `id`, `host`, `cta` | **The key metric.** Every ticket/"get deal"/source/directions link that leaves Fomo: happening/event/place detail pages' primary CTA, source link, directions; `HappeningHero`, `BookEarlyCard`, `FeedListCard`'s festival CTA |
| `save_added` / `save_removed` | `kind`, `id` | `components/ui/SaveButton.tsx` — the one shared bookmark toggle everywhere |
| `share_completed` | `method` (native/clipboard), `kind` | `components/ui/ShareButton.tsx` — the one shared share button |
| `calendar_added` | `type` (ics/google), `kind` | Happening/event detail pages' "Add to calendar" links |
| `tab_switched` | `from`, `to` | Home's Now/Coming up/Book early segmented control |
| `filter_used` | `filter`, `value`, `page` | Free only / For you / category / date pills on `/whats-on`; Free only on `/weekend`; WHAT/WHO on `/deals`; type/district on `/free`; timing/category/month on `/book-early` |
| `search_submitted` | `length` | Explore's search box, on picking a suggestion (On Fomo pin or a Google place) |
| `chat_message_sent` | `length` | Ask Fomo, on send |
| `subscribe_submitted` | `surface` (home/weekend/signup) | `SubscribeCard` ("Get Fomo Friday"), on success |
| `tip_submitted` | `type` (tip/feedback) | `/tip` page, on success |
| `prefs_completed` / `prefs_skipped` | — | `MakeFomoYours` — Save vs. Skip for now |
| `signin_completed` | `method` (email/google/apple) | `/signin`, once per real sign-in (see below) |
| `pwa_installed` | — | `AppShell`'s `appinstalled` listener |

Every event also carries the super properties `signed_in`, `standalone`,
`prefs_set` (see Identity above), plus whatever PostHog adds automatically
(`$current_url`, `$pathname`, UTM params, etc.).

### `signin_completed`'s "exactly once" trick

Every sign-in path (OTP verify, Google ID-token exchange, the OAuth
redirect fallback) ends in a full browser navigation — so there's no
in-memory state on the destination page to say "a sign-in just happened
here". `app/signin/page.tsx` writes the method to
`sessionStorage["fomo:pending_signin_method"]` right before that
navigation; `IdentifyUser` reads and clears it once, on mount, only firing
`signin_completed` when the flag is present. A returning visitor who's
already signed in never has the flag set, so it never fires for them.

## Verifying locally

With `NEXT_PUBLIC_POSTHOG_KEY` set and `NEXT_PUBLIC_POSTHOG_DEBUG=1` in
`.env.local`, restart the dev server and:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/ingest/decide
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/ingest/flags
```

Both should come back as a PostHog response (200, or PostHog's own 4xx for
a malformed request) — never Next's 404 page — confirming the rewrite is
live. Open the app in a browser, accept the cookie bar, and check the
Network tab for `POST /ingest/e/` (capture) — the same request should show
a `200` and, in the PostHog project's Activity tab, the event should land
within a few seconds.

## Owner setup (PostHog UI)

1. **Project**: create one on the EU cloud (eu.posthog.com), copy its
   Project API key into `NEXT_PUBLIC_POSTHOG_KEY` (`.env.local` and Vercel,
   all environments).
2. **Dashboard "Fomo v1"** — create these insights:
   - WAU / DAU (trend on `$pageview`, unique users, daily and weekly)
   - Stickiness (DAU/WAU ratio insight)
   - Retention on `card_opened` and separately on `outbound_clicked`
     (first-time vs. returning)
   - Median session duration (session insight, median aggregation)
   - Funnel: `$pageview` → `card_opened` → `outbound_clicked`
   - Breakdown of the above funnel by `utm_source` (PostHog captures UTM
     params automatically as event/person properties)
   - Installs: trend on `pwa_installed`
   - Saves/shares per WAU: trend on `save_added` + `share_completed`,
     divided by the WAU number (formula mode, or eyeball two panels)
3. **Surveys** (Surveys tab → New survey):
   - **2nd-visit prompt**: "What were you looking for that you didn't
     find?" — open text, trigger on "user has visited the site 2 times"
     (Recurrence/targeting → visited N times).
   - **Sean Ellis / PMF survey**: "How would you feel if you could no
     longer use Fomo?" (very disappointed / somewhat / not disappointed) —
     trigger after the 3rd session or 7 days since first seen, whichever
     the targeting UI supports (event-based trigger on the 3rd
     `$pageview` in a session count, or a "days since first seen ≥ 7"
     condition).
   - **Always-on feedback survey**: open text, manual trigger only (no
     display conditions) — copy its Survey ID into
     `NEXT_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID` (`.env.local` + Vercel).
     `components/ui/FeedbackLink.tsx` calls
     `posthog.displaySurvey(surveyId)` when that env var and
     `window.posthog` both exist, falling back to `/tip?type=feedback`
     otherwise.
4. **Session replay settings** (Project settings → Recordings): confirm
   input masking is on project-wide too (defence in depth alongside this
   app's own `maskAllInputs: true`), and set a sensible retention/sampling
   rate if replay volume gets expensive — nothing in the code depends on a
   specific sampling rate, so this is free to tune after launch.

## What the owner must still do

- Set `NEXT_PUBLIC_POSTHOG_KEY` in `.env.local` and Vercel (all
  environments) — analytics is entirely inert without it.
- Optionally set `NEXT_PUBLIC_POSTHOG_DEBUG=1` locally to see events while
  developing.
- Create the PostHog project, dashboard and surveys per the steps above,
  and set `NEXT_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID` once the always-on
  survey exists.
- Fill in the survey trigger conditions in the PostHog UI — the exact
  wording of "3rd session or 7 days" targeting depends on what that
  account's PostHog plan exposes in the survey targeting editor.
