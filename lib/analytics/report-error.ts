/**
 * Error-reporting shim for the app's error boundaries (app/error.tsx,
 * app/global-error.tsx). Always `console.error`s so failures are visible in
 * server/browser logs, and also forwards to `posthog.captureException` when
 * PostHog has attached itself to `window.posthog` (instrumentation-client.ts)
 * — checked via `window.posthog` rather than importing the SDK directly so
 * this file needs no posthog-js dependency of its own and stays a safe
 * no-op before that script has run, or when NEXT_PUBLIC_POSTHOG_KEY is unset.
 */

// Method-shorthand signatures (not `foo?: (x) => void` arrow-typed
// properties) deliberately — TypeScript checks these bivariantly, which is
// what lets instrumentation-client.ts assign the real, much more strictly
// typed posthog-js instance to `window.posthog` without every param type
// here having to exactly (contravariantly) match posthog-js's own.
interface PosthogLike {
  captureException?(error: unknown, properties?: Record<string, unknown>): void;
  displaySurvey?(surveyId: string): void;
  /** lib/analytics/track.ts's `track()` is the one place the rest of the
   *  app calls this — declared here (the single `declare global` for
   *  `window.posthog` in the codebase) so every file that touches it agrees
   *  on one shape instead of TypeScript rejecting conflicting re-declarations. */
  capture?(event: string, properties?: Record<string, unknown>): void;
  /** components/analytics/ConsentBar.tsx's calls — "OK" switches from
   *  cookieless capture to a persistent cookie identity, "No thanks" records
   *  the refusal (capture stays cookieless). See instrumentation-client.ts. */
  opt_in_capturing?(options?: { captureEventName?: string | null | false }): void;
  opt_out_capturing?(): void;
  /** "granted" only after "OK" — identify (IdentifyUser) and surveys
   *  (FeedbackLink) are gated on it, since neither works cookieless. */
  get_explicit_consent_status?(): "granted" | "denied" | "pending";
  /** components/analytics/IdentifyUser.tsx's calls — identity + super properties. */
  identify?(id: string, properties?: Record<string, unknown>): void;
  reset?(): void;
  register?(properties: Record<string, unknown>): void;
}

declare global {
  interface Window {
    posthog?: PosthogLike;
  }
}

export function reportError(error: unknown, context?: Record<string, unknown>): void {
  console.error(error);
  if (typeof window !== "undefined" && window.posthog?.captureException) {
    try {
      window.posthog.captureException(error, context);
    } catch {
      // Never let telemetry itself break the error boundary it's reporting from.
    }
  }
}

export default reportError;
