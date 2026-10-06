# Fomo: pre-launch security review + legacy cleanup

## Context

Fomo v1 soft-launches Thu 1 Oct to friends. The codebase still carries the old trip-planner app (reels, Viator/GYG experiences, Japan pipeline, trips, practicalities). That's dead weight and attack surface: paid API calls on every Home load, an open media proxy, unauthenticated-ish paid endpoints. Three read-only surveys (DB inventory, legacy code, security surface) found:

- **Confirmed open redirect:** `lib/auth/safe-next.ts:21` lets `/%09/evil.com` through. I reproduced this in Node.
- **Critical advisories against Next 16.2.10** (`npm audit`): a proxy bypass (GHSA-6gpp-xcg3-4w24), remote code execution in image optimisation with AVIF (GHSA-2xp9-vwfh-vxw4), and SSRF. The fix is 16.3.6.
- **`/api/now`:** Home calls it only as a fallback hero, yet every call triggers live Viator/GetYourGuide lookups and service-role writes. It is also the only thing keeping 4 legacy tables alive.
- **Reels:** unreachable from the app's navigation, but still wired into Saved, the chat seed, the shared card component, the CSP and `/api/media-proxy`.

Decisions (2026-09-28):
- Remove `/api/now`.
- Keep the Edinburgh and generic parts of the places pipeline; delete what is Japan-only.
- Drop the legacy tables with a backup first: I export CSVs and write one `drop_legacy.sql`, which you run.

## Step 0 — push the dev fixes (immediately on approval)

Commit `app/layout.tsx` and `next.config.ts`: dev-only CSP additions (`unsafe-eval`, `va.vercel-scripts.com`) and inline scripts moved to `<head>` to fix the PostHog hydration mismatch. Push, then check the Vercel deploy status.

---

## Plan 1 — Legacy cleanup (do first: it shrinks what the security review has to cover)

Sonnet agents edit the code. A Haiku agent handles pure file deletions and docs. I review every diff, then run `tsc`, `lint`, `next build` and a browser smoke test.

### 1a. Remove `/api/now` (Sonnet)
- **Salvage the shared pieces into `lib/cards/`, then delete the rest of `lib/now/`:**
  - `types.ts`: `Candidate`, `CardKind`. Used by `components/fomo/Card.tsx`, `SavedList.tsx` and `/api/saved`.
  - `price.ts`: `priceSignalForEvent` and `WHATS_ON_PRICE_EXEMPT_CATEGORIES`. Used by `/api/feed` and `lib/happenings/hero.ts`.
  - From `generators.ts`: `placeImage`, `placeCoords`, `eventHeadline`, `venueLabel`. Used by `/api/saved`.
- **Delete:**
  - `app/api/now/route.ts`, the rest of `lib/now/*` (including the dead `discover.ts`)
  - `lib/db/preferences.ts`, `lib/db/location.ts`
  - `lib/db/signals.ts` (its only reader was the `/api/now` ranker)
- **Home (`app/(shell)/page.tsx`):**
  - Remove `fetchNowResponse`, `nowResult`, the `FomoCard` fallback hero (around lines 751–790) and the `rememberUserLocation` / `forgetUserLocation` writes.
  - Keep the on-device geolocation that drives the "near me" sort.
  - If `/api/feed` has no hero, show no hero.
- **Remove the signal writes** from `components/fomo/Card.tsx:96` and `ExploreSheet.tsx:59,126`.

### 1b. Remove Reels (Sonnet)
- **Delete:**
  - `app/(shell)/reels`, `app/(shell)/social/[id]`
  - `components/social/*`
  - `lib/social/*`, `lib/db/social.ts`
  - `app/api/media-proxy`
- **Edit:**
  - `lib/db/index.ts`
  - `/api/saved`: remove the reel branch.
  - `SavedList.tsx`: remove the Reels tab.
  - `Card.tsx`: remove the reel icon and link.
  - `lib/chat-seed.ts`, `fomo/page.tsx`
  - `welcome/page.tsx`: `DETAIL_PAGE_PREFIXES`.
  - `lib/types.ts`: `SocialPost`, and `"reel"` from `CardSubjectType`.
  - `proxy.ts:109`, `public/sw.js:54,62`
  - `lib/image/cdn.ts`: remove the TikTok, Instagram and Facebook hosts.
  - `next.config.ts`: `frame-src` becomes GIS only; tidy the comments.
- **Scraper (Haiku):** delete `scrape_instagram.py`, `scrape_tiktok.py`, `scrape_places_batch.py`, `browser_session.py`, `humanize.py` and `classify_reels.py`, plus the reels task in `scripts/enrich-places-data.mjs`. Tell you about the local-only `scraper/.pw-profile` (1.7 GB, holds logged-in cookies) and `scraper/.venv`.

### 1c. Remove Experiences (Sonnet)
- **Delete:**
  - `app/(shell)/experience/[id]`
  - `components/experiences/`
  - `lib/experiences/*`, `lib/db/experiences.ts`
- **Edit:**
  - `/api/saved`, `SavedList.tsx` (remove the Experiences tab)
  - `Card.tsx`, `chat-seed.ts`, `fomo/page.tsx`, `welcome/page.tsx`
  - `lib/taxonomy.ts` (`interestsForExperience`)
  - `lib/types.ts` (`Experience`)
  - `lib/image/cdn.ts`: remove the Viator and GYG hosts.
  - Keep the `/experiences` redirect in `next.config.ts`.
- **You:** remove the Viator and GetYourGuide env vars from Vercel and `.env.local`.

### 1d. Orphans and trip leftovers (Haiku, I review)
- **Routes to delete:** `app/api/geocode`, bare `app/api/places/route.ts` (keep `autocomplete`, `resolve` and `[id]/offers`), bare `app/api/events/route.ts` (keep `[id]/ics`), `app/api/practicalities`.
- **Libraries to delete:** `lib/db/practicalities.ts`, `lib/translator-data.ts`, `lib/ai/translate-types.ts`, `lib/image/downscale.ts`, `lib/language.ts`, `lib/places/label.ts`, `lib/uuid.ts`.
- **Components to delete:** `components/fomo/Language*Picker.tsx`, `components/events/`, and the unused `components/ui` exports `Textarea`, `Slider`, `ProgressBar` and `SectionHeader`.
- **Types and branches:** in `lib/types.ts`, remove `Trip*`, `ItineraryItem*`, `FomoRules`, `ArrivalTip` and the practicality types. Remove `itinerary_item` and `practicality` from `CardSubjectType`, along with their branches in `Card.tsx` and `chat-seed.ts`.
- **proxy.ts:** remove `/setup` and `/kit`, plus the now-deleted API routes from the public lists.
- **Scripts:** delete `scripts/backfill-trip-geo.mjs`.
- **Japan-only files:**
  - Repo root: `build_shibuya_json.py`, `plan-japan*.md`, `plan-scotland*.md`, `plan-v1-home-pivot.md`.
  - `scraper/`: `countries/japan.py`, `japan_place_*`, `*kanto*`, `upsert_japan_places.py`, `JAPAN_PLACES_PIPELINE.md`, and the data files `kanto_*` and `japan_cities.json`.
  - **Keep** `run_city_batch.py`, `discover_*`, `countries/{base,scotland}.py`, `geocode_osm.py`, `photos_wikimedia.py`, `enrich.py` and `promote-japan-places.mjs`. Rename the last one to `promote-places.mjs` and update `docs/daily-sources.md`.
- **Docs:** update `README.md`, `scraper/README.md`, `supabase/README.md`, and the reels mentions in `docs/launch/launch-kit.md` and `docs/plan-data-collection.md`.

### 1e. Database (me: read-only export; you: run the SQL)
1. **Back up.** Export every table to be dropped to CSV in the scratchpad, reading through PostgREST with the service key. Hand you the zip, which is not committed.
2. **Tables to drop** in `supabase/drop_legacy.sql` (one transaction):
   - Reels: `social_posts`, `scraped_reels`
   - Experiences: `experiences`
   - Japan pipeline: `places_staging`, `place_sources`, `city_foods`, `city_foods_staging`
   - Trips: `trips`, `itinerary_items`, `roameo_rules`, `travel_preferences`
   - Practicalities: `country_practicalities`, `practicality_dismissals`, `arrival_tips`
   - Old ranker: `card_signals`, `user_location`
3. **Clean up leftover data:**
   - Delete `saved_items` rows whose `subject_type` is `reel`, `experience`, `itinerary_item` or `practicality`.
   - Drop the `trip_id` columns on `chat_messages` and `saved_items`.
4. **Keep:** `places` and `place_photos` (the venue catalogue, still read by `/place/[id]` and Explore).
5. **Archive** every applied or legacy SQL file into `supabase/archive/`. Several would re-open anonymous write access if re-run (`schema.sql`, `add_events.sql`, `add_now_ranker_tables.sql` and others).
6. **New `supabase/README.md`:**
   - The current schema.
   - The pending files: `add_anon_rate_limits.sql`, `add_email_events.sql` and `drop_legacy.sql`.
   - A "verify live policies" query block.
7. **Prerequisite:** the code from 1a–1d must be deployed first, so nothing reads a dropped table.

---

## Plan 2 — Security review

### 2a. Urgent code fixes (before Thu 1 Oct; Sonnet builds, I verify)
| # | Fix | Where |
|---|---|---|
| S1 | Upgrade `next` to 16.3.6 (plus `eslint-config-next`) and re-run `npm audit`. Also fix `sharp`, `postcss` and `nanoid`. Check the build and the proxy on a Vercel preview. | `package.json` |
| S2 | **Open redirect:** in `safeNext`, strip or reject control characters, `%09`/`%0a`/`%0d` and anything with a backslash. Parse with `new URL(value, "https://x")` and require `origin === "https://x"`. Add unit tests with a crafted-input list. | `lib/auth/safe-next.ts` |
| S3 | **Chat `returnTo`:** validate it through `safeNext`. | `lib/chat-seed.ts:46`, `fomo/page.tsx:371` |
| S4 | **Chat global cap:** check the per-user limits *before* consuming the global cap, so one user can't burn everyone's quota. | `app/api/chat/route.ts:411-425` |
| S5 | **Outbound URLs:** add a shared `safeHttpUrl()`. Use it in every `window.open` and `href` built from pipeline data. In the ingest scripts, drop any `ticket_url` or `booking_url` that isn't http/https. | `happening/[id]/page.tsx:377,862`, `HappeningHero.tsx`, `event/[id]/page.tsx`, `scripts/daily-sources.mjs:642,1343` |
| S6 | **Subscribe via the database:** drop the anon insert policy on `email_subscribers` (the API route already uses the admin client). The same goes for `tips`, which also inserts through the API. SQL is added to the pending list. | new `supabase/tighten_public_inserts.sql` |
| S7 | **`/ingest` rewrite:** confirm with a request capture whether the Supabase auth cookies are forwarded to PostHog. If they are, strip them: skip `/ingest` in the `proxy.ts` matcher and remove the cookies. | `proxy.ts`, `next.config.ts` |
| S8 | **Rate limits:** once the SQL has run, rate limiting fails *closed* for chat in production (fail open only for subscribe and tips). | `lib/rate-limit.ts` |
| S9 | **GitHub Actions:** add `permissions: contents: read` to both workflows. | `.github/workflows/*.yml` |

### 2b. Hardening (week after launch)
- **Defence in depth:** add route-level auth checks to routes that currently rely on `proxy.ts` alone (`places/autocomplete`, `places/resolve`). Add per-user rate limits there too, since they make paid Google calls.
- **Webhook replay:** de-duplicate the Resend webhook on `svix-id` (unique index on `email_events`).
- **`profiles` table:** stop users updating `membership_tier`, via a column-level grant or a trigger.
- **Avatars bucket:** set a MIME allowlist and a 2 MB limit in the Supabase storage settings.
- **Push subscribe:** only accept push endpoints on known push-service hosts (FCM, Mozilla, Apple).
- **Chat:** mark the seed name and city in the system prompt as untrusted data.
- **Session replay:** also mask chat text (`data-ph-no-capture` or `maskTextSelector`).
- **CSP:** nonce-based `script-src` to drop `'unsafe-inline'`. This is bigger; do it later.

### 2c. Dashboard checklist (you, with me guiding; I run read-only SQL where I can)
- **Supabase:**
  - Run the live policy query (read-only; I'll run it through the service key).
  - Confirm the rate-limit functions exist.
  - Auth: exact redirect URLs, OTP and sign-up rate limits, CAPTCHA on email OTP.
  - Avatars bucket limits.
  - Confirm `onsale-alerts` JWT verification and the Vault secret.
- **Vercel:**
  - Deployment Protection on previews.
  - Make sure preview deployments don't get the production service-role key.
  - Spend limit, firewall and attack-challenge mode.
- **GitHub:**
  - Default workflow permissions set to read.
  - Branch protection on `main`.
  - Required reviewer on the `Production` environment (optional).
- **Keys:**
  - Mapbox public token: URL-restricted to askfomo.com and localhost.
  - Google Places key: API and referrer restrictions, plus a quota.
  - DeepSeek: billing cap.
  - Resend: DMARC record and webhook secret.
- **Data:** read-only `select` for any non-http(s) URLs already stored in `happenings` and `events`.

---

## Other launch to-dos (from the earlier plan)
- **You:**
  - Add the operator name to `/privacy` and `/terms`, and a real `SENDER_ADDRESS`.
  - Run `add_anon_rate_limits.sql` and `add_email_events.sql`.
  - Set `ANON_RATE_SALT` and `RESEND_WEBHOOK_SECRET` in Vercel.
  - Resend: turn on open and click tracking, and create the webhook.
  - Delete the PostHog `phx_` key.
  - Build the PostHog dashboard and surveys (per `docs/analytics.md`).
  - Instagram Creator account and posts; WhatsApp Insiders group.
  - Google OAuth branding and origins; delete the test tips row.
- **Me (should ship before 8 Oct):** PWA install hint plus manifest `id` and a maskable icon; `scripts/weekly-metrics.mjs`.

## Order
1. **Mon 28:** Step 0 push. S1–S4 and S9, which are small and urgent.
2. **Tue 29:** Plan 1a–1d code removal, then S5, S7 and S8. Deploy.
3. **Wed 30:** 1e backup and `drop_legacy.sql` (you run it, plus S6's SQL). 2c dashboard checklist. Full production smoke test on a phone.
4. **Thu 1 Oct:** soft launch. 2b hardening during launch week.

## Verification
- **Every batch:** `tsc --noEmit`, `eslint`, `next build`, and `npm audit --omit=dev` (critical and high must be 0).
- **Redirects:** a `safeNext` test table covering `/%09/x.com`, `/%0a/x.com`, `/\x`, `//x`, `https://x`, `/ok?a=1`. Then a browser check that `/signin?next=/%09/evil.com` signed in lands on `/`.
- **Browser at phone size:**
  - Pages: Home (with and without a hero), `/deals`, `/whats-on`, `/weekend`, `/saved` (no Reels or Experiences tabs), `/event/*`, `/happening/*`, `/place/*`, Explore search, and chat.
  - Old links: `/reels` and `/experience/x` return 404.
  - No console errors.
  - Network: no `/api/now` requests.
- **Prod after deploy:** curl smoke tests — 200s on the main routes; 404 for `/api/media-proxy`, `/api/geocode` and `/api/now`; `/api/events/[id]/ics` still 200.
- **After you run the SQL:** re-run the read-only policy and table listing to confirm the drops, and that Saved still loads for a signed-in user.
