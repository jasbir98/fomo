"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/Icon";
import { track } from "@/lib/analytics/track";

/** Same key/values ConsentBar (components/analytics/ConsentBar.tsx) uses —
 *  duplicated here rather than imported so this component stays a leaf that
 *  only reads, never writes, ConsentBar's storage. */
const CONSENT_KEY = "fomo:consent";

const VISITS_KEY = "fomo:visits";
/** sessionStorage — one increment per browser session, not per page view. */
const VISIT_SESSION_FLAG = "fomo:visit-counted";
const DISMISSED_AT_KEY = "fomo:install-dismissed-at";
const SHOWN_COUNT_KEY = "fomo:install-shown-count";

const MIN_VISITS_BEFORE_SHOWING = 2;
const MAX_TOTAL_SHOWS = 3;
const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

type Platform = "android" | "ios";

/** Not yet in lib.dom.d.ts. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

function readInt(key: string): number {
  try {
    const n = parseInt(localStorage.getItem(key) ?? "0", 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function readStr(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStr(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window / blocked storage — worst case we ask again next visit.
  }
}

function isStandalone(): boolean {
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

/** iOS Safari only — Chrome/Firefox/Edge-on-iOS all ride Safari's WebKit but
 *  can't install PWAs, and in-app browsers (Instagram/Facebook) can't either. */
function detectIOSSafari(): "ios" | "in-app" | "unsupported" | null {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !("MSStream" in window);
  if (!isIOS) return null;
  if (/Instagram|FBAN|FBAV/.test(ua)) return "in-app";
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return "unsupported";
  return "ios";
}

// Nothing external to subscribe to — this only distinguishes the SSR/first-
// hydration pass (must render nothing, see below) from every client render
// after. Same pattern as ConsentBar's own useSyncExternalStore usage.
const subscribeNoop = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false
  );
}

/**
 * "Add to home screen" hint. Mounted once in AppShell, fixed above
 * BottomNav like ConsentBar (same position class — the two are mutually
 * exclusive within a visit, see the consent-decided gate below, so they
 * never actually stack).
 *
 * Gating (all must hold before anything renders):
 *  - not already installed (display-mode: standalone / navigator.standalone)
 *  - 2nd visit onward (fomo:visits, incremented once per session)
 *  - not dismissed in the last 14 days (fomo:install-dismissed-at)
 *  - shown fewer than 3 times total (fomo:install-shown-count)
 *  - the visitor has already made a cookie choice this visit, so this never
 *    appears stacked with ConsentBar (simplest fix per the brief: just
 *    don't show while ConsentBar might still be showing)
 *
 * SSR/hydration: renders null on the server and on the first client render
 * (useMounted's useSyncExternalStore server snapshot), then decides
 * visibility in an effect — never reads localStorage during render itself,
 * mirroring the hydration-bug fix already applied to ConsentBar.
 */
export function InstallHint() {
  const mounted = useMounted();
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [eligible, setEligible] = useState(false);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const hasTrackedShownRef = useRef(false);

  // Resolve the non-install-prompt gates once, client-side only.
  useEffect(() => {
    if (!mounted) return;
    if (isStandalone()) return;

    let visits = readInt(VISITS_KEY);
    try {
      if (!sessionStorage.getItem(VISIT_SESSION_FLAG)) {
        visits += 1;
        writeStr(VISITS_KEY, String(visits));
        sessionStorage.setItem(VISIT_SESSION_FLAG, "1");
      }
    } catch {
      // Ignore — worst case visits under-counts this session.
    }
    if (visits < MIN_VISITS_BEFORE_SHOWING) return;

    if (readInt(SHOWN_COUNT_KEY) >= MAX_TOTAL_SHOWS) return;

    const dismissedAt = readStr(DISMISSED_AT_KEY);
    if (dismissedAt && Date.now() - Number(dismissedAt) < DISMISS_COOLDOWN_MS) return;

    const consent = readStr(CONSENT_KEY);
    if (consent !== "accepted" && consent !== "declined") return; // ConsentBar may still be showing

    const ios = detectIOSSafari();
    // This effect reacts to external, client-only state (localStorage,
    // UA, matchMedia) it's reading for the first time — not deriving from
    // props/state — so the synchronous setState below is the exact
    // cascading-render shape react-hooks/set-state-in-effect flags.
    // Deferring to a microtask is this codebase's standard escape hatch
    // (see AmbientWeather.tsx, app/signin/page.tsx).
    queueMicrotask(() => {
      setEligible(true);
      if (ios === "ios") setPlatform("ios");
    });
    // "in-app" / "unsupported" / null (Android, desktop): wait for
    // beforeinstallprompt below — nothing to show without it.
  }, [mounted]);

  // Android/Chrome/Edge: capture the browser's own install prompt so we can
  // trigger it from our card's button instead of a native mini-infobar.
  useEffect(() => {
    function handler(e: Event) {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setPlatform("android");
    }
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const visible = mounted && eligible && !dismissed && platform !== null;

  useEffect(() => {
    if (visible && !hasTrackedShownRef.current) {
      hasTrackedShownRef.current = true;
      writeStr(SHOWN_COUNT_KEY, String(readInt(SHOWN_COUNT_KEY) + 1));
      track("install_hint_shown", { platform: platform ?? "unknown" });
    }
  }, [visible, platform]);

  function dismiss() {
    writeStr(DISMISSED_AT_KEY, String(Date.now()));
    track("install_hint_dismissed");
    setDismissed(true);
  }

  async function handleInstallClick() {
    const prompt = deferredPromptRef.current;
    if (!prompt) return;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      track("install_prompt_result", { outcome: choice.outcome });
    } catch {
      // User dismissed via OS chrome, or the prompt was already consumed.
    } finally {
      deferredPromptRef.current = null;
      // Either way the browser's one-shot prompt is spent — same 14-day
      // cooldown as an explicit dismiss rather than re-showing our card.
      writeStr(DISMISSED_AT_KEY, String(Date.now()));
      setDismissed(true);
    }
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Install Fomo"
      className="fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-40 mx-auto flex w-full max-w-[480px] items-center gap-3 border-t border-hairline bg-surface-container-lowest/95 px-4 py-3 shadow-level-2 backdrop-blur-md"
    >
      {platform === "ios" ? (
        <p className="flex-1 text-label-sm text-on-surface-variant">
          Add Fomo to your home screen: tap{" "}
          <Icon name="ios_share" size={16} className="align-text-bottom" /> then &ldquo;Add to Home
          Screen&rdquo;.
        </p>
      ) : (
        <p className="flex-1 text-label-sm text-on-surface-variant">
          Add Fomo to your home screen. Opens instantly, like an app.
        </p>
      )}
      <div className="flex shrink-0 items-center gap-2">
        {platform === "android" && (
          <button
            type="button"
            onClick={handleInstallClick}
            className="rounded-full bg-primary px-3.5 py-1.5 text-label-sm font-bold text-on-primary hover:opacity-90"
          >
            Install
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container"
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}

export default InstallHint;
