/**
 * PostHog client init — Next.js 15.3+'s `instrumentation-client.ts`
 * convention (runs once, before the rest of the app's client code, no
 * "use client" needed: this isn't a React module). EU-hosted, proxied
 * same-origin through /ingest (see next.config.ts's rewrites — this file
 * never talks to posthog.com directly, so it isn't a third-party request
 * and needs no separate CSP connect-src entry beyond 'self').
 *
 * CONSENT (UK PECR — see components/analytics/ConsentBar.tsx): PostHog
 * always initialises when a key is set, so events can flow and be tested in
 * every environment, but it starts with `persistence: "memory"` — no
 * cookies, no localStorage, nothing written to disk — until the visitor
 * actively says "OK". ConsentBar itself flips persistence to
 * "localStorage+cookie" on accept (and never asks again either way, per
 * `fomo:consent` in localStorage). This is the standard PostHog "cookieless
 * until consent" pattern and satisfies PECR without a hard gate that blocks
 * capture (and therefore blocks even testing) before a choice is made.
 * `person_profiles: "always"` (not the "identified_only" default) is
 * required for this to work at all: an anonymous, pre-consent, memory-only
 * visitor still needs an anon profile/session so their behaviour up to the
 * moment they identify (lib/analytics/identify) or convert isn't lost.
 *
 * DEV: still initialises in development (so events are capturable/testable
 * locally) but starts opted out of capturing via
 * `opt_out_capturing_by_default`, unless NEXT_PUBLIC_POSTHOG_DEBUG=1 is set
 * — flip that on to see real events flow while developing. Chose
 * `opt_out_capturing_by_default` over "init but never capture" because it's
 * PostHog's own documented lever for exactly this (toggle-able at runtime
 * via `posthog.opt_in_capturing()` from the console too, if needed
 * mid-session) rather than a second parallel gate this app would have to
 * maintain itself.
 *
 * No-op entirely (posthog-js never imported/initialised) when
 * NEXT_PUBLIC_POSTHOG_KEY is unset — every other analytics call in the app
 * goes through `window.posthog?.foo?.()` (lib/analytics/track.ts,
 * report-error.ts, FeedbackLink.tsx), which is already a safe no-op when
 * `window.posthog` was never assigned.
 */
import posthog from "posthog-js";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (POSTHOG_KEY) {
  const isDev = process.env.NODE_ENV === "development";
  const debugInDev = process.env.NEXT_PUBLIC_POSTHOG_DEBUG === "1";

  posthog.init(POSTHOG_KEY, {
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    // Anonymous visitors get a full profile too — required so pre-consent
    // (memory-only) and never-signed-in usage still shows up in retention/
    // funnels, not just identified users. See this file's doc comment.
    person_profiles: "always",
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: true,
    capture_exceptions: true,
    session_recording: {
      maskAllInputs: true,
    },
    // No consent yet — nothing written to cookies/localStorage until
    // ConsentBar flips this on accept. See this file's own doc comment.
    persistence: "memory",
    // Dev: capture is wired up (so it's testable) but off by default unless
    // explicitly debugging — see this file's doc comment.
    opt_out_capturing_by_default: isDev && !debugInDev,
  });

  window.posthog = posthog;
}
