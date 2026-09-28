/**
 * One helper every event call in the app goes through —
 * `track("card_opened", { kind, id, ... })` — instead of touching
 * `window.posthog` directly everywhere. Safe no-op when PostHog hasn't
 * initialised (no key set, still loading, or consent hasn't landed yet:
 * ConsentBar/instrumentation-client.ts always call `posthog.init` when a key
 * exists, just with `persistence: "memory"` pre-consent — see that file's
 * doc comment — so `window.posthog` exists and captures even before a
 * choice is made, it just isn't persisted to cookies/localStorage yet).
 *
 * `window.posthog`'s type (including the `capture` member this file calls)
 * is declared once, in lib/analytics/report-error.ts — importing it here
 * (type-only, side-effect import) pulls that global augmentation into this
 * file's compilation without redeclaring it, which TypeScript would reject
 * as a conflicting duplicate.
 */
import "./report-error";

export type TrackProps = Record<string, string | number | boolean | null | undefined>;

/** Fire-and-forget event capture. Never throws — a broken analytics call must never break the feature it's instrumenting. */
export function track(event: string, props?: TrackProps): void {
  if (typeof window === "undefined") return;
  try {
    window.posthog?.capture?.(event, props);
  } catch {
    // Telemetry must never break the feature it's instrumenting.
  }
}

/** `price_band` for `card_opened`/`outbound_clicked` — derived from a
 *  happening/event's own `is_free` rather than re-parsing a display label
 *  (lib/happenings/price-label.ts's `PriceLabel` is presentation text like
 *  "£5" or "Kids free", not a stable analytics dimension). */
export function priceBand(isFree: boolean | null | undefined): "free" | "paid" | "unknown" {
  if (isFree === true) return "free";
  if (isFree === false) return "paid";
  return "unknown";
}

/**
 * `outbound_clicked` — THE key metric (see the task brief): every ticket/
 * "get deal"/"see programme"/source link that leaves Fomo, from a card CTA
 * or a detail page's own booking/source/directions link. One shared call
 * site so every caller reports `host` the same way (derived from the URL
 * itself, not threaded separately, so it can never drift from the actual
 * href) rather than each component re-deriving it.
 */
export function trackOutboundClicked(
  kind: "happening" | "event" | "place",
  id: string,
  href: string | null | undefined,
  cta: string
): void {
  let host: string | null = null;
  try {
    host = href ? new URL(href, typeof window !== "undefined" ? window.location.href : undefined).hostname.replace(/^www\./, "") : null;
  } catch {
    // Not a parseable URL — leave host null rather than throw.
  }
  track("outbound_clicked", { kind, id, host, cta });
}

export default track;
