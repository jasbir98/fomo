/**
 * PostHog client init — Next.js 15.3+'s `instrumentation-client.ts`
 * convention (runs once, before the rest of the app's client code, no
 * "use client" needed: this isn't a React module). EU-hosted, proxied
 * same-origin through /ingest (see proxy.ts — this file never talks to
 * posthog.com directly, so it isn't a third-party request and needs no
 * separate CSP connect-src entry beyond 'self').
 *
 * CONSENT (UK PECR — see components/analytics/ConsentBar.tsx) uses
 * PostHog's own cookieless mode, `cookieless_mode: "on_reject"` with
 * `opt_out_capturing_by_default: true`:
 * - Until the visitor taps "OK" (no answer yet, or "No thanks"), posthog-js
 *   treats them as rejected and captures in cookieless mode: nothing is
 *   written to cookies/localStorage, every event goes out with the
 *   `$posthog_cookieless` sentinel distinct_id and `$cookieless_mode: true`,
 *   and PostHog's servers swap the sentinel for
 *   hash(project, daily salt, IP, user agent, host). That makes daily
 *   unique visitors accurate without consent; the same person shows up as
 *   a new visitor each day. Requires "Cookieless server hash mode" on in
 *   the PostHog project (Project settings → Web analytics).
 * - "OK" → `posthog.opt_in_capturing()` switches to a normal cookie
 *   identity that persists across visits (retention, multi-day metrics,
 *   replay, surveys, identify — all of which are off in cookieless mode).
 *
 * The old setup (`persistence: "memory"` until consent) minted a fresh
 * random distinct_id on every full page load, so one visitor became many
 * "users" — see docs/analytics.md, "What each number means".
 *
 * DEV: never initialised unless NEXT_PUBLIC_POSTHOG_DEBUG=1 —
 * `opt_out_capturing_by_default` now means "capture cookieless", so it can't
 * double as the dev mute any more. Every other analytics call goes through
 * `window.posthog?.foo?.()` (lib/analytics/track.ts, report-error.ts,
 * FeedbackLink.tsx), already a safe no-op when `window.posthog` is unset.
 * Same no-op when NEXT_PUBLIC_POSTHOG_KEY is unset.
 */
import posthog from "posthog-js";
import { enrichExceptionProperties } from "@/lib/analytics/exceptions";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const isDev = process.env.NODE_ENV === "development";
const debugInDev = process.env.NEXT_PUBLIC_POSTHOG_DEBUG === "1";

/**
 * Carries a choice made on the cookie bar before cookieless mode existed
 * (`fomo:consent`, ConsentBar's own key) over into posthog-js's consent key,
 * before init. Must run pre-init: posthog-js reads its consent key during
 * init, and a visitor who already tapped "OK" keeps their existing cookie
 * identity only if init sees "granted" — opting them in afterwards resets
 * it. posthog-js stores the value JSON-encoded, so 1/0 is just "1"/"0".
 */
function migrateLegacyConsent(key: string) {
  try {
    const phKey = `__ph_opt_in_out_${key}`;
    if (localStorage.getItem(phKey) !== null) return;
    const legacy = localStorage.getItem("fomo:consent");
    if (legacy === "accepted") localStorage.setItem(phKey, "1");
    else if (legacy === "declined") localStorage.setItem(phKey, "0");
  } catch {
    // Blocked storage — the visitor just stays cookieless until they choose again.
  }
}

/**
 * Seconds between the server rendering this document's HTML (app/layout.tsx's
 * `fomo-rendered-at` meta) and now. A hydration error (React #418) on HTML
 * that is minutes or days old points at time-dependent text ("On now",
 * "Tonight") rendered from a cached page. Null if the meta is missing.
 */
function htmlAgeSeconds(): number | null {
  const renderedAt = Number(document.querySelector('meta[name="fomo-rendered-at"]')?.getAttribute("content"));
  return renderedAt > 0 ? Math.round((Date.now() - renderedAt) / 1000) : null;
}

if (POSTHOG_KEY && (!isDev || debugInDev)) {
  migrateLegacyConsent(POSTHOG_KEY);

  posthog.init(POSTHOG_KEY, {
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    // See this file's doc comment.
    cookieless_mode: "on_reject",
    opt_out_capturing_by_default: true,
    // Every visitor gets a person profile — the cookieless ones get one per
    // daily hash, the consented ones one that persists.
    person_profiles: "always",
    // `consent_status` ("granted" | "pending" | "denied") on every event,
    // including the initial pageview that fires during init (before any
    // React code could register a super property). The dashboards split on
    // it: "granted" visitors have a persistent ID, the rest are counted by
    // the daily hash. See scripts/posthog-dashboards.mjs.
    // `$exception` events also get readable React messages, the release and
    // the HTML's age, and known third-party noise is dropped — see
    // lib/analytics/exceptions.ts.
    before_send: (event) => {
      if (!event) return event;
      event.properties.consent_status = posthog.get_explicit_consent_status();
      if (event.event === "$exception") {
        if (!enrichExceptionProperties(event.properties)) return null;
        event.properties.html_age_s = htmlAgeSeconds();
      }
      return event;
    },
    // Append lazy-loaded scripts (config, surveys, recorder) to <head>. The
    // default inserts them before the first `body > script`, which lands
    // inside the React-rendered tree and breaks hydration.
    external_scripts_inject_target: "head",
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: true,
    // Uncaught errors and unhandled promise rejections. Errors React catches
    // in app/error.tsx / global-error.tsx never reach these handlers; those
    // report themselves (lib/analytics/report-error.ts). console.error is
    // left out: React and Next log recoverable noise through it.
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    session_recording: {
      // Masks every input's value in replay (form fields — Tip us
      // off/feedback, Fomo Friday email capture) by default; `true` here is
      // also just posthog-js's own default, kept explicit.
      maskAllInputs: true,
      // No maskTextSelector set here: posthog-js's own default
      // (`maskTextClass: 'ph-mask'`, verified against the installed
      // @posthog/types SessionRecordingOptions) already masks any element's
      // text content when it carries the `ph-mask` class — chat message
      // bubbles in app/(shell)/fomo/page.tsx use that class for exactly
      // this, since the AI chat transcript is free text `maskAllInputs`
      // doesn't cover (it's rendered text, not an input value).
    },
  });

  window.posthog = posthog;
}
