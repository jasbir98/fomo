# Accurate visitor metrics in PostHog (cookieless counting + managed dashboard)

## Context

PostHog user counts are wrong, and the cause is the consent setup, not a missing login. `instrumentation-client.ts` starts every visitor with `persistence: "memory"`. Most visitors never tap the cookie bar, so every full page load, new tab and return visit creates a **new random distinct_id and a new person**. DAU, WAU, retention, funnels and sessions all inflate, and returning-visitor metrics show nothing.

The fix is PostHog's own consent-aware **cookieless mode** (posthog-js 1.434.15 supports it; checked in `node_modules/posthog-js/lib/src/consent.js` and `posthog-core.js`):

- `cookieless_mode: "on_reject"` plus `opt_out_capturing_by_default: true`: the SDK treats "pending" as "rejected" (`ConsentManager.isRejected()`). Visitors who haven't answered, and visitors who tap "No thanks", are captured with distinct_id `$posthog_cookieless`. PostHog's servers replace that with `hash(team, daily_salt, ip, user_agent, host)`. Nothing is stored on the device, so this is PECR-safe. Daily uniques become accurate.
- "OK" → `posthog.opt_in_capturing()` switches to a normal cookie identity that persists across visits, so retention and multi-day metrics are accurate for that group.
- Every cookieless event carries `$cookieless_mode: true`, so dashboards can split the two groups.

These limits come from PostHog itself and can't be engineered around without consent:

- A cookieless visitor counts as a new user each day. Weekly and monthly uniques for them are a range, not an exact number.
- Replay and surveys only run after "OK".
- Cookieless events get no GeoIP or bot detection.

The dashboard reports exactly what is true: accurate daily numbers, a weekly range, and retention for persistent users only.

User decisions: cookieless hash for non-answerers (not strict drop). Dashboards are created by an idempotent script using a personal API key.

## Prerequisites (user, before deploy — order matters)

1. PostHog → Project settings → Web analytics → enable **"Cookieless server hash mode"**. This must be on before the code ships, or cookieless events have no server-side hash.
2. Create a personal API key with scopes `insight:write`, `dashboard:write`, `query:read`, `project:write`. Add it to `.env.local` as `POSTHOG_PERSONAL_API_KEY`, alongside `POSTHOG_PROJECT_ID=286067` and `POSTHOG_HOST=https://eu.posthog.com`.

## Code changes (new branch `analytics-cookieless` off `main`)

### 1. `instrumentation-client.ts`
- Config: drop `persistence: "memory"` and use the default `localStorage+cookie`. Add `cookieless_mode: "on_reject"` and `opt_out_capturing_by_default: true`. Persistence then stays disabled automatically while the visitor is pending or rejected (`_is_persistence_disabled()`). Keep `person_profiles: "always"`, autocapture, replay and other settings unchanged.
- Dev without `NEXT_PUBLIC_POSTHOG_DEBUG=1`: **don't init at all**. `opt_out_capturing_by_default` now means "capture cookieless", so it can no longer double as the dev mute. Every caller already no-ops when `window.posthog` is unset.
- **Legacy-choice migration**, before `posthog.init`: if `localStorage["fomo:consent"]` is `accepted` or `declined` and `__ph_opt_in_out_<key>` is unset, write `"1"` or `"0"` to that key. posthog-js stores consent as JSON in localStorage (`consent.js` `_storage`). Visitors who already tapped OK then keep their existing cookie identity; calling opt-in after init would reset it.
- Rewrite the doc comment for the new model.

### 2. `components/analytics/ConsentBar.tsx`
- `choose()`: replace `set_config({persistence})` with `opt_in_capturing({ captureEventName: false })` or `opt_out_capturing()`. Then `track("consent_choice", { choice })`. Then `window.dispatchEvent(new Event("fomo:consent-changed"))` so `IdentifyUser` can re-identify, because opt-in resets identity and super properties.
- Keep `fomo:consent` as the bar's own "never ask again" memory, unchanged.

### 3. `components/analytics/IdentifyUser.tsx`
- Call `identify()`/`reset()` **only when `posthog.get_explicit_consent_status?.() === "granted"`**. In cookieless mode, identify would send `$anon_distinct_id: "$posthog_cookieless"`. posthog-js warns this collapses every browser into one person (`posthog-core.js` around line 455). Signed-in visitors without consent are still counted by hash and tagged `signed_in: true`.
- Listen for `fomo:consent-changed`. On grant, re-run identify for the current session and re-register super properties.

### 4. `lib/analytics/report-error.ts` (`PosthogLike` type)
- Add `opt_in_capturing`, `opt_out_capturing` and `get_explicit_consent_status`. Remove `set_config`, which has no other callers.

### 5. `components/ui/FeedbackLink.tsx`
- Surveys don't run in cookieless mode, so use `displaySurvey` only when consent is granted. Otherwise fall back to `/tip?type=feedback`.

### 6. `app/privacy/page.tsx`
- Analytics paragraph and Cookies section: describe the new behaviour.
  - Until you tap OK, PostHog counts visits with an anonymous daily hash computed on its servers, and nothing is stored on your device.
  - Recordings, surveys and links to your account status happen only after OK.

### 7. `scripts/posthog-dashboards.mjs` (new; plain Node ESM, global fetch, same style as `scripts/weekly-metrics.mjs`)
- **Works on the existing dashboard 980079**, not a new one. The first step of implementation is `GET /api/projects/286067/dashboards/980079/` to dump its current tiles and queries, so I can see exactly what each one computes. Each tile then gets one of three treatments:
  - **Fix in place**, keeping the insight ID: add a `$cookieless_mode` split, restrict to persistent users, or shorten the funnel window.
  - **Replace**: build an accurate version, e.g. WAU becomes the weekly range.
  - **Remove from the dashboard**: tiles that can't be made accurate. The insight itself is kept, never deleted.
- Likely mapping, based on the tiles `docs/analytics.md` told the owner to build:
  - DAU: keep, with a `$cookieless_mode` split.
  - WAU: becomes the weekly range.
  - Stickiness, retention and median session duration: restricted to persistent users.
  - Funnel: 1-day window.
  - Saves/shares per WAU: becomes per DAU.
  - UTM breakdown and installs: keep.
- Adds a PostHog **annotation** at the deploy date ("cookieless counting on"). Data before it is inflated by the memory-persistence bug, so the dashboard's default date range starts there.
- Idempotent: upserts insights by name (tagged `fomo-managed`). Supports `--dry-run`, which prints the per-tile diff before anything is written.
- Sets the project's **test-account filters** (`PATCH /api/projects/286067/`):
  - `$host` exactly `askfomo.com`, which excludes Vercel previews, staging and localhost because every environment shares the key.
  - Exclude the owner's identified person.
- All insights use `filterTestAccounts: true`.
- Target tile set for dashboard 980079:

  | Insight | Definition | Accuracy |
  |---|---|---|
  | Daily visitors | `$pageview` DAU, daily, stacked by `$cookieless_mode` | Accurate |
  | Daily visitors, 7-day avg | Same, rolling average | Accurate |
  | Weekly visitors (range) | HogQL per week: persistent WAU; est. low = persistent + max daily cookieless; est. high = persistent + sum daily cookieless | Honest range |
  | Consent rate | `consent_choice` broken down by `choice`, plus % of daily visitors with cookie IDs | Accurate |
  | Signed-in active users | DAU/WAU where `signed_in = true` and consent granted | Accurate (consented) |
  | New sign-ups | `signin_completed` where `is_new_user = true` | Accurate |
  | Key funnel (same day) | `$pageview → card_opened → outbound_clicked`, 1-day window | Accurate |
  | Outbound clicks per visitor | `outbound_clicked` total ÷ DAU (formula) | Accurate |
  | Outbound clicks by host | Last 30 days, bar | Accurate |
  | Acquisition | Daily visitors by `$referring_domain` / `utm_source` | Accurate |
  | Top pages | `$pageview` by `$pathname` | Accurate |
  | Retention (persistent users) | Weekly `$pageview` retention, `$cookieless_mode` not set | Consented + signed-in only (labelled) |

### 8. `scripts/weekly-metrics.mjs`
- Add an optional PostHog block when `POSTHOG_PERSONAL_API_KEY` is set. It runs HogQL via `/api/projects/:id/query` and reports avg daily visitors, the weekly visitor range, outbound clicks and consent rate, week over week.

### 9. Docs
- `docs/analytics.md`: rewrite the Consent and Identity sections. Add a "What each number means" section (accurate vs range). Add `consent_choice` to the taxonomy. Replace the hand-built dashboard steps with the script. Add the server-hash prerequisite.
- `docs/README.md`: add the two prerequisites as open to-dos.
- Save this plan to `docs/plans/2026-10-14-posthog-accurate-metrics.md` and add an index row.

## Verification

1. `npx tsc --noEmit` and `npm run lint`.
2. Local, with `NEXT_PUBLIC_POSTHOG_DEBUG=1`, via `preview_start`, starting from a fresh profile with cleared storage:
   - Pending state: `POST /ingest/e/` payloads have `distinct_id: "$posthog_cookieless"` and `$cookieless_mode: true`. `document.cookie` and `localStorage` hold no `ph_*` entries.
   - Click **OK**: the distinct_id becomes a uuid and a `ph_*` cookie appears. After a reload the id is the same. `consent_choice` fires.
   - Clear storage and click **No thanks**: `__ph_opt_in_out_<key>` is `0` and events stay cookieless.
   - Migration: set `fomo:consent=accepted` and reload. Consent reads `granted` and the cookie identity is preserved.
   - Signed in while pending: no `$identify` request. Click OK and `$identify` fires with the user id.
3. Script: `node --env-file=.env.local scripts/posthog-dashboards.mjs --dry-run`, then a real run, then run again to confirm no duplicates. Check the dashboard renders.
4. Proxy IP check, which is critical because the hash uses the client IP:
   - After deploy, run a HogQL query on cookieless events. Expect many distinct daily hashes, not one giant "person" (that would mean `proxy.ts` sends Vercel's IP).
   - Also compare with consented events' `$geoip_city_name`, which should be varied and mostly Edinburgh.
5. After 2–3 days in production, PostHog daily visitors should land close to Vercel Analytics visitors. Both use a daily hash, so this is the sanity check.
