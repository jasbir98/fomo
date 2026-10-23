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
  `ui_host: "https://eu.posthog.com"`. `proxy.ts` (`posthogRewrite`)
  forwards `/ingest/static/*` → `eu-assets.i.posthog.com` and `/ingest/*` →
  `eu.i.posthog.com` with the cookie header stripped, so every capture/decide/flags/replay call is
  same-origin (no extra CSP entries needed — `connect-src 'self'` and
  `script-src 'self'` already cover it; `worker-src blob:` for session
  replay was already in the CSP). `skipTrailingSlashRedirect: true` stops
  Next's own trailing-slash redirect racing the rewrite.
- **Dev**: not initialised at all unless `NEXT_PUBLIC_POSTHOG_DEBUG=1` is
  set in `.env.local`.
- **Consent (UK PECR) — cookieless until "OK"**: `cookieless_mode:
  "on_reject"` + `opt_out_capturing_by_default: true`. Until the visitor
  taps **OK** on `components/analytics/ConsentBar.tsx` (mounted once in
  `AppShell`, so never on `/signin`/`/welcome`), posthog-js captures in
  cookieless mode: nothing written to cookies/localStorage, every event
  sent with the `$posthog_cookieless` distinct_id, which PostHog's servers
  replace with `hash(project, daily salt, IP, user agent, host)`. **No
  thanks** calls `posthog.opt_out_capturing()` (stays cookieless, stores the
  refusal); **OK** calls `posthog.opt_in_capturing()` (normal cookie identity
  from then on). The bar also remembers the choice in
  `localStorage["fomo:consent"]` and never asks twice; visitors who chose
  before cookieless mode existed are carried over by
  `migrateLegacyConsent` in `instrumentation-client.ts`. Needs **Cookieless
  server hash mode** on in the PostHog project (Project settings → Web
  analytics). Replay and surveys only run after OK.
- **`consent_status` on every event** (`granted` / `pending` / `denied`),
  set in `before_send` so even the initial pageview has it. Every visitor
  metric splits on it — see "What each number means".
- **Identity**: `components/analytics/IdentifyUser.tsx`, also mounted once
  in `AppShell`. Watches `supabaseBrowserAuth().auth.onAuthStateChange`;
  on sign-in, **if the visitor tapped OK**, calls
  `posthog.identify(user.id, {...})` with `signin_method`, `fomo_status`,
  `who_groups`, `interests_count`, `budget`, `prefs_set` — **never the email
  address**. On sign-out (again only with consent), `posthog.reset()`.
  Without consent it never identifies: in cookieless mode that would merge
  every cookieless browser into one person. Also registers three super
  properties on every event: `signed_in`, `standalone` (installed PWA vs
  browser tab), `prefs_set`; and re-runs both after a cookie-bar choice
  (`fomo:consent-changed`), since opting in resets PostHog's identity.
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
| `share_completed` | `method` (native/clipboard), `kind` (happening/event/place/weekend/plan) | `components/ui/ShareButton.tsx` — the one shared share button |
| `plan_item_added` / `plan_item_removed` | `kind`, `id`, `surface` (weekend/happening_detail/event_detail), `count` (added only) | `components/plans/AddToPlanButton.tsx` — the "Plan" pill on /weekend cards and detail pages |
| `weekend_plan_created` | `id`, `count`, `total`, `total_from`, `unknown_prices`, `reused`, `source` | `components/plans/PlanBar.tsx`, when "Make link" returns a plan id (`reused` = same picks as an existing plan) |
| `weekend_plan_shared` | `id`, `method` (whatsapp/native/clipboard), `creator` | `/plan/<id>`'s "Send to the group" and Share buttons (`PlanShareActions`). WhatsApp counts on tap. |
| `plan_make_own_clicked` | `id`, `creator` | `/plan/<id>`'s "Make your own plan" / "Change picks" — the loop: a friend who got the link starts their own |
| `calendar_added` | `type` (ics/google), `kind` | Happening/event detail pages' "Add to calendar" links |
| `tab_switched` | `from`, `to` | Home's Now/Coming up/Book early segmented control |
| `filter_used` | `filter`, `value`, `page` | Free only / For you / category / date pills on `/whats-on`; Free only on `/weekend`; WHAT/WHO on `/deals`; type/district on `/free`; timing/category/month on `/book-early` |
| `search_submitted` | `length` | Explore's search box, on picking a suggestion (On Fomo pin or a Google place) |
| `chat_message_sent` | `length` | Ask Fomo, on send |
| `subscribe_submitted` | `surface` (home/weekend/signup/finds/plan) | `SubscribeCard` ("Get Fomo Friday"), on success |
| `tip_submitted` | `type` (tip/feedback) | `/tip` page, on success |
| `prefs_completed` / `prefs_skipped` | — | `MakeFomoYours` — Save vs. Skip for now |
| `kids_pref_set` | `on` | `MakeFomoYours` — on Save, when the "I've got kids" toggle changed |
| `kids_filter_toggled` | `surface` (whats_on/weekend/free/deals/explore), `on` | The "With kids" chip on `/whats-on`, `/weekend` and `/free`; the "Families" WHO chip on `/deals`; the "Kids" category chip on Explore |
| `signin_completed` | `method` (email/google/apple) | `/signin`, once per real sign-in (see below) |
| `pwa_installed` | — | `AppShell`'s `appinstalled` listener |
| `consent_choice` | `choice` (accepted/declined) | `ConsentBar`, on OK / No thanks |

Every event also carries `consent_status` and the super properties
`signed_in`, `standalone`, `prefs_set` (see above), plus whatever PostHog
adds automatically (`$current_url`, `$pathname`, UTM params, etc.).

## What each number means

Before 15 Oct 2026, visitors who hadn't tapped OK ran with in-memory
persistence, so **every full page load, new tab or return visit was a new
"user"**: users, WAU, retention and funnels from before then are inflated.
The dashboard is annotated at the switch and starts there.

Now there are two kinds of visitor:

| | Who | ID | Lasts |
|---|---|---|---|
| Cookie visitor | tapped **OK** | random ID in a first-party cookie | across visits |
| Cookieless visitor | never answered, or **No thanks** (most people) | PostHog's server-side hash | one day |

So:

- **Daily visitors — exact.** Cookie visitors by ID + cookieless by hash.
  The headline traffic number; compare it with Vercel Analytics visitors
  (also a daily hash) as a sanity check.
- **Weekly/monthly visitors — a range.** A cookieless visitor who comes on
  3 days counts 3 times. Low = cookie visitors + the busiest day's
  cookieless; high = cookie visitors + the sum of every day's cookieless.
- **Funnels, per-visitor rates (outbound clicks per visitor, saves +
  shares per visitor) — exact within a day**, so funnels use a 1-day window.
- **Retention, stickiness, session length — cookie visitors only.** Nobody
  else can be followed across days. Watch "Visitors with a cookie ID (%)" to
  know how big that sample is.
- **Signed-in accounts** — use Supabase (`scripts/weekly-metrics.mjs`), the
  source of truth; in PostHog, `signed_in = true` gives daily signed-in
  visitors.
- On the day someone taps OK they can be counted twice (once by hash, once
  by their new ID). One-off per visitor, small.
- Cookieless events get no GeoIP or bot detection (PostHog strips the IP
  before those run).

### `signin_completed`'s "exactly once" trick

Every sign-in path (OTP verify, Google ID-token exchange, the OAuth
redirect fallback) ends in a full browser navigation — so there's no
in-memory state on the destination page to say "a sign-in just happened
here". `app/signin/page.tsx` writes the method to
`sessionStorage["fomo:pending_signin_method"]` right before that
navigation; `IdentifyUser` reads and clears it once, on mount, only firing
`signin_completed` when the flag is present. A returning visitor who's
already signed in never has the flag set, so it never fires for them.

## Exceptions

PostHog Error tracking (Error tracking tab, or `$exception` events) gets
every error from the browser and the server, each with a readable message,
a stack that points at our source, the route, and context.

### Where they come from

| Path | Captured by | `mechanism` |
|---|---|---|
| Uncaught browser error, unhandled promise rejection | posthog-js `capture_exceptions` (`instrumentation-client.ts`) | `handled: false` |
| Render error caught by `app/error.tsx` / `app/global-error.tsx` | `reportError()` → `posthog.captureException` (`lib/analytics/report-error.ts`), with `boundary` and `digest` | `handled: true` |
| Uncaught server error (server component, route handler, server action, proxy) | `onRequestError` in `instrumentation.ts` → `captureServerException` | `type: onRequestError` |
| Route handler that catches an unexpected error and answers 5xx | `captureServerException(err, {route, handled: true, …})` in that catch | `type: route-catch` |

`console.error` is not captured (React and Next log recoverable noise
through it). A server component error reaches the browser as a generic
message plus `digest`; the server-side event carries the real message and
stack under the same `digest`, so filter on `digest` to pair them.

### What each event carries

- **Type and message.** Production React only sends codes ("Minified React
  error #418; visit …"); `lib/analytics/exceptions.ts` rewrites the common
  ones into words, e.g. "Hydration failed: the server-rendered text didn't
  match the client (React #418)", and sets `react_error_code`.
- **Stack.** Browser: `productionBrowserSourceMaps` serves a `.map` next to
  every chunk and PostHog fetches it through the chunk's `sourceMappingURL`,
  so frames resolve to `components/…/Foo.tsx:line`. This only works where
  PostHog can fetch the JS: askfomo.com, not localhost or SSO-protected
  previews (those show minified frames). Settings → Error tracking →
  Symbol sets lists each map and why any failed. The trade-off: the client
  source is readable to anyone who requests a map (it ships to every
  visitor minified anyway; no server code or secrets are in it).
  **Decision (23 Oct 2026): public maps for now.** Revisit if exposing the
  client source and its comments starts to matter, or if Symbol sets shows
  PostHog failing to fetch them. The alternative is uploading private maps
  at build time with `@posthog/nextjs-config` (needs a personal API key with
  error tracking write in Vercel) and turning `productionBrowserSourceMaps`
  off. Try it on a preview first and check: Turbopack support, that its
  delete-after-upload leaves `.next/server/**/*.map` alone (the server
  mapping above needs them), whether a failed upload fails the deploy, and
  that its release version matches `VERCEL_GIT_COMMIT_SHA`.
  Server: `experimental.serverSourceMaps` writes a map beside each server
  chunk; `scripts/trace-server-maps.mjs` (run by `npm run build`) adds each
  function's own chunk maps to its Vercel file trace (largest function: ~9 MB
  of maps); `lib/analytics/server-source-map.ts` maps frames to
  `app/…/page.tsx:line` before the event is sent.
- **Where.** `$current_url` / `$pathname`; server events add `route` (the
  route file pattern), `route_type`, `render_source`, `method`.
- **Context.** `app_release` (git SHA of the build, from
  `VERCEL_GIT_COMMIT_SHA`), `app_env` (production/preview/development),
  `signed_in`, `consent_status`, browser/OS, and on browser events
  `html_age_s`: how old the server-rendered HTML was (from the
  `fomo-rendered-at` meta in `app/layout.tsx`). A hydration error with a
  large `html_age_s` means time-dependent text rendered from a cached page.
- **Noise dropped** in `before_send`: "Error invoking postMessage: Java
  object is gone" (Facebook/Instagram's Android in-app browser). Add more to
  `NOISE` in `lib/analytics/exceptions.ts`.

Server events have `distinct_id` "fomo-server" and no person profile, and,
like the browser, only send when `NEXT_PUBLIC_POSTHOG_KEY` is set and, in
dev, `NEXT_PUBLIC_POSTHOG_DEBUG=1`.

### What the first look found (21 Oct)

55 `$exception` events over 30 days, 31 of them from askfomo.com. Message and URL were always there;
what was missing was everything else (no source maps, no release, no
context, React codes instead of words).

- **Production: 29 × React #418 (hydration mismatch)**: 24 on `/`, 3 on
  `/deals` (two of them the "HTML" variant), 1 on `/weekend`, 1 on a
  happening page. Cause: those pages
  are built on the server and cached (ISR), and cards worked out "Tonight",
  "On now · until 5pm", "Checked 2 days ago", today's deals and their order
  from `new Date()` at render, so the cached HTML disagreed with the client
  once the clock moved on. Fixed with `lib/useNow.tsx`: the first client
  render uses the server's render time, then switches to the real clock.
- **Production: 2 × "Error invoking postMessage: Java object is gone"** from
  Instagram/Facebook's Android in-app browser. Not ours; now dropped.
- **Localhost only (dev edits in progress):** `feedPending`/`windowControl`/
  `happeningCtaLabel`/`useGeolocation` ReferenceErrors and missing-module
  errors while files were mid-edit. All gone from the current code.

### Testing it

`/debug/errors` (404 in production) has one button per path: throw in
render (error boundary), throw uncaught, reject a promise, throw on the
server. Run it on a preview, or locally with `npm run build && npm start`
(or dev with `NEXT_PUBLIC_POSTHOG_DEBUG=1`), then look for "Fomo test:"
events in PostHog. Local events have `$host = localhost:…`, which the
dashboard's test-account filter already excludes.

## Verifying locally

With `NEXT_PUBLIC_POSTHOG_KEY` set and `NEXT_PUBLIC_POSTHOG_DEBUG=1` in
`.env.local`, restart the dev server and:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/ingest/decide
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/ingest/flags
```

Both should come back as a PostHog response (200, or PostHog's own 4xx for
a malformed request) — never Next's 404 page — confirming the rewrite is
live. Open the app in a fresh browser profile: before answering the cookie
bar, `posthog.get_distinct_id()` in the console is `$posthog_cookieless`,
`get_explicit_consent_status()` is `"pending"` and there are no `ph_*`
cookies or localStorage keys, while `POST /ingest/i/v0/e/` still returns
200. Tap OK: the ID becomes a UUID, a `ph_*` cookie appears, and it
survives a reload. Tap No thanks instead: status `"denied"`, still
cookieless.

## Owner setup (PostHog UI)

1. **Project**: EU cloud (eu.posthog.com), project 286067. Its Project API
   key is `NEXT_PUBLIC_POSTHOG_KEY` (`.env.local` and Vercel, all
   environments).
2. **Cookieless server hash mode**: Project settings → Web analytics → on.
   Must be on before the cookieless code ships.
3. **Dashboard** (980079) — managed by `scripts/posthog-dashboards.mjs`,
   not by hand. Needs a personal API key (Settings → Personal API keys;
   scopes `insight:write`, `dashboard:write`, `query:read`,
   `annotation:write`, `project:write`) in `.env.local` as
   `POSTHOG_PERSONAL_API_KEY`. Optional: `POSTHOG_PROJECT_ID` (default
   286067), `POSTHOG_HOST` (default https://eu.posthog.com).

   ```bash
   node --env-file=.env.local scripts/posthog-dashboards.mjs --dump      # what's there now
   node --env-file=.env.local scripts/posthog-dashboards.mjs --dry-run   # validate + plan
   node --env-file=.env.local scripts/posthog-dashboards.mjs --since 2026-10-15
   ```

   It fixes existing tiles in place (matched by name), creates missing
   ones, sets test-account filters to `$host = askfomo.com` (previews,
   staging and localhost share the key), and with `--since` annotates the
   switch and floors the dashboard's date range there.
   `--remove-unmanaged` takes tiles it doesn't manage off the dashboard
   (insights kept). The same key adds a Visitors block to
   `scripts/weekly-metrics.mjs`.
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
- Turn on Cookieless server hash mode, add `POSTHOG_PERSONAL_API_KEY`,
  run `scripts/posthog-dashboards.mjs`, create the surveys per the steps
  above, and set `NEXT_PUBLIC_POSTHOG_FEEDBACK_SURVEY_ID` once the
  always-on survey exists (it only shows to visitors who tapped OK; others
  get `/tip?type=feedback`).
- Fill in the survey trigger conditions in the PostHog UI — the exact
  wording of "3rd session or 7 days" targeting depends on what that
  account's PostHog plan exposes in the survey targeting editor.
