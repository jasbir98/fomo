/**
 * Minimal error-reporting shim for the app's error boundaries
 * (app/error.tsx, app/global-error.tsx). For now just `console.error`s so
 * failures are visible in server/browser logs; once PostHog is wired up
 * (separate task) it'll also forward to `posthog.captureException` — this
 * checks for `window.posthog` rather than importing the SDK so this file
 * has zero new dependencies today and doesn't need touching when that
 * lands, as long as PostHog attaches itself to `window.posthog` the usual
 * way.
 */

interface PosthogLike {
  captureException?: (error: unknown, properties?: Record<string, unknown>) => void;
  displaySurvey?: (surveyId: string) => void;
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
