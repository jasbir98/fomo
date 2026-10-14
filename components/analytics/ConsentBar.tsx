"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { track } from "@/lib/analytics/track";

/** localStorage key remembering the visitor's choice — set once, never asked again either way (accept or decline), matching SubscribeCard's own `fomo_subscribed` convention (components/happenings/SubscribeCard.tsx). */
const CONSENT_KEY = "fomo:consent";

/** Window event fired after a choice — IdentifyUser re-identifies on it. */
export const CONSENT_CHANGED_EVENT = "fomo:consent-changed";

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
 * Until a choice is made PostHog captures cookieless — nothing written to
 * cookies/localStorage, visitors counted by a server-side daily hash (see
 * instrumentation-client.ts's doc comment). "OK" calls
 * `posthog.opt_in_capturing()` (persistent cookie identity from then on);
 * "No thanks" calls `opt_out_capturing()`, which records the refusal and
 * keeps capture cookieless. Either way the choice is also remembered in
 * `fomo:consent` so the bar never asks twice.
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
      window.posthog?.opt_in_capturing?.({ captureEventName: false });
    } else {
      window.posthog?.opt_out_capturing?.();
    }
    track("consent_choice", { choice: value });
    // Opting in resets PostHog's identity and super properties —
    // IdentifyUser listens for this to identify and re-register them.
    window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
  }

  if (consent !== null || stored !== null) return null;

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-40 mx-auto flex w-full max-w-[480px] items-center gap-3 border-t border-hairline bg-surface-container-lowest/95 px-4 py-3 shadow-level-2 backdrop-blur-md lg:inset-x-auto lg:bottom-6 lg:right-6 lg:max-w-sm lg:rounded-xl lg:border"
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
