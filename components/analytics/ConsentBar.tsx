"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";

/** localStorage key remembering the visitor's choice — set once, never asked again either way (accept or decline), matching SubscribeCard's own `fomo_subscribed` convention (components/happenings/SubscribeCard.tsx). */
const CONSENT_KEY = "fomo:consent";

type Consent = "accepted" | "declined";

function readConsent(): Consent | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    return raw === "accepted" || raw === "declined" ? raw : null;
  } catch {
    return null;
  }
}

// The choice only changes through this component (which tracks it in state),
// so there's nothing external to subscribe to.
const subscribeNoop = () => () => {};

function writeConsent(value: Consent) {
  try {
    localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Private window / blocked storage — the bar just re-asks next visit,
    // no worse than not having this at all (same fallback as SubscribeCard).
  }
}

/**
 * UK PECR cookie/consent bar — small, non-blocking, mounted once in
 * AppShell above BottomNav (never inside it, so it never eats nav taps).
 * PostHog always initialises with `persistence: "memory"` (see
 * instrumentation-client.ts's doc comment) — no cookies or localStorage
 * written — until this bar's "OK" flips that to
 * "localStorage+cookie". "No thanks" leaves memory persistence in place
 * (events still capture for the current page load/session, nothing
 * persisted) and, like "OK", is remembered so the bar never asks twice.
 *
 * Renders nothing once a choice has been made. The stored choice is read
 * via useSyncExternalStore with a "pending" server snapshot, so SSR and the
 * hydration pass both render nothing and the bar only appears on the client
 * for visitors who haven't chosen yet. (Reading localStorage in a state
 * initializer made returning visitors' client tree differ from the server
 * HTML — React #418, whole-page client re-render.)
 */
export function ConsentBar() {
  const stored = useSyncExternalStore(subscribeNoop, readConsent, () => "pending" as const);
  const [consent, setConsent] = useState<Consent | null>(null);

  function choose(value: Consent) {
    writeConsent(value);
    setConsent(value);
    if (value === "accepted") {
      window.posthog?.set_config?.({ persistence: "localStorage+cookie" });
    }
  }

  if (consent !== null || stored !== null) return null;

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-40 mx-auto flex w-full max-w-[480px] items-center gap-3 border-t border-hairline bg-surface-container-lowest/95 px-4 py-3 shadow-level-2 backdrop-blur-md"
    >
      <p className="flex-1 text-label-sm text-on-surface-variant">
        Fomo uses cookies to learn what&rsquo;s useful.{" "}
        <Link href="/privacy" className="underline underline-offset-2">
          Privacy
        </Link>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => choose("declined")}
          className="rounded-full px-3 py-1.5 text-label-sm font-semibold text-on-surface-variant hover:bg-surface-container"
        >
          No thanks
        </button>
        <button
          type="button"
          onClick={() => choose("accepted")}
          className="rounded-full bg-primary px-3.5 py-1.5 text-label-sm font-bold text-on-primary hover:opacity-90"
        >
          OK
        </button>
      </div>
    </div>
  );
}

export default ConsentBar;
