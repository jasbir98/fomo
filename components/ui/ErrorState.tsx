"use client";

import { Button } from "./Button";
import { Icon } from "./Icon";

export type ErrorStateProps = {
  /** Short one-line problem statement, e.g. "Couldn't load what's on". */
  title?: string;
  /** One short sentence of guidance shown under the title. */
  message?: string;
  /** Re-runs whatever fetch produced the error. Omit to hide the Retry button. */
  onRetry?: () => void;
  className?: string;
};

/**
 * Shared "this fetch failed" state. Before this component existed, every
 * page reading GET /api/feed (or a detail route) had no way to tell a real
 * network/server failure apart from a genuinely empty result — a failed
 * fetch either rendered that page's empty-state copy ("Nothing lined up...
 * try another tab") or left the loading skeleton on screen forever, both of
 * which read as "no events here" or "the app is broken", not "try again".
 *
 * Same dashed-border tile shape as this app's existing empty states (e.g.
 * app/(shell)/deals/page.tsx's "No live deals right now") so a failure
 * doesn't read as some unfamiliar kind of screen — just a different icon,
 * copy, and a Retry action the empty states don't have.
 */
export function ErrorState({
  title = "Couldn't load this",
  message = "Check your connection and try again.",
  onRetry,
  className = "",
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-center gap-3 rounded-2xl border border-dashed border-hairline-strong p-8 text-center ${className}`}
    >
      <Icon name="wifi_off" size={28} className="text-outline" />
      <div className="flex flex-col gap-1">
        <p className="text-body-md font-semibold text-on-surface">{title}</p>
        <p className="text-body-sm text-on-surface-variant">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" leadingIcon="refresh" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export default ErrorState;
