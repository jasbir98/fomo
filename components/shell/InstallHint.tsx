"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { InstallSheet } from "@/components/install/InstallSheet";
import { promptInstall } from "@/lib/pwa/install-prompt";
import { useInstallState } from "@/lib/pwa/useInstallState";
import { track } from "@/lib/analytics/track";
import { subscribeSavedChanges } from "@/lib/useSaved";

/** Same key ConsentBar (components/analytics/ConsentBar.tsx) writes. Only read here, never written. */
const CONSENT_KEY = "fomo:consent";

const DISMISSED_AT_KEY = "fomo:install-dismissed-at";
const SHOWN_COUNT_KEY = "fomo:install-shown-count";
/** Browser sessions seen on this device (localStorage), bumped once per tab session (sessionStorage flag). */
const SESSION_COUNT_KEY = "fomo:session-count";
const SESSION_COUNTED_KEY = "fomo:session-counted";

/** A first visit never gets the hint (it would stack with the cookie bar and Home's own asks) unless the visitor saves something. */
const MIN_SESSIONS_BEFORE_SHOWING = 2;
const MIN_PAGES_BEFORE_SHOWING = 2;
/** Or, for someone reading one long page: this long on the site. */
const MIN_SECONDS_BEFORE_SHOWING = 25;
const MAX_TOTAL_SHOWS = 5;
const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

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
    // Private window / blocked storage: worst case we ask again next visit.
  }
}

/** Counts this browser session once (sessionStorage survives reloads, not a new tab or a later visit) and returns the running total. */
function countSession(): number {
  try {
    if (sessionStorage.getItem(SESSION_COUNTED_KEY) === "1") return readInt(SESSION_COUNT_KEY);
    const next = readInt(SESSION_COUNT_KEY) + 1;
    localStorage.setItem(SESSION_COUNT_KEY, String(next));
    sessionStorage.setItem(SESSION_COUNTED_KEY, "1");
    return next;
  } catch {
    // Blocked storage: treat as a first visit, so the hint waits for a save.
    return 1;
  }
}

function readConsent(): "accepted" | "declined" | null {
  const raw = readStr(CONSENT_KEY);
  return raw === "accepted" || raw === "declined" ? raw : null;
}

/**
 * Has the visitor answered the cookie bar yet? ConsentBar writes the key in
 * this same tab, where the `storage` event doesn't fire, so poll once a second
 * until it's set (then stop). "pending" is the server/hydration snapshot.
 */
function subscribeConsent(cb: () => void): () => void {
  const timer = window.setInterval(() => {
    if (readConsent() !== null) window.clearInterval(timer);
    cb();
  }, 1000);
  window.addEventListener("storage", cb);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("storage", cb);
  };
}

/**
 * "Add to home screen" hint, mounted once in AppShell and fixed above
 * BottomNav like ConsentBar (same position class; it waits for ConsentBar to
 * be answered so the two never stack).
 *
 * Gating (all must hold before anything renders):
 *  - a phone or tablet browser that can (or could) install: not desktop, not
 *    already running as the installed app
 *  - the cookie bar has been answered (any choice, this session or before)
 *  - a returning visitor (a second browser session on this device,
 *    fomo:session-count) or one who has saved something: never on a first
 *    visit otherwise, where the cookie bar and Home's own asks already
 *    compete for the screen
 *  - engaged: 2+ pages viewed this session, or 25s on the site
 *  - not dismissed in the last 14 days (fomo:install-dismissed-at)
 *  - shown fewer than 5 times total (fomo:install-shown-count)
 *
 * The button installs in one tap when the browser has handed over its prompt
 * (lib/pwa/install-prompt.ts), otherwise it opens InstallSheet's step list.
 *
 * SSR/hydration: renders null on the server and first client render (install
 * state and consent both have "unknown" server snapshots), and reads storage
 * only in an effect, never during render.
 */
export function InstallHint() {
  const { platform, canPrompt, installed } = useInstallState();
  const consent = useSyncExternalStore(
    subscribeConsent,
    readConsent,
    () => "pending" as const
  );
  const pathname = usePathname();
  // Pages viewed this session: the shell persists across client navigations,
  // so count pathname changes ("adjust state during render", not an effect).
  const [pagesViewed, setPagesViewed] = useState(1);
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setPagesViewed((n) => n + 1);
  }
  const [timeOnSiteReached, setTimeOnSiteReached] = useState(false);
  const [storageOk, setStorageOk] = useState(false);
  const [returning, setReturning] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const hasTrackedShownRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setTimeOnSiteReached(true), MIN_SECONDS_BEFORE_SHOWING * 1000);
    return () => window.clearTimeout(timer);
  }, []);

  // Storage-backed gates, resolved once client-side. Reads external,
  // client-only state for the first time, so the deferred setState is this
  // codebase's standard escape hatch for react-hooks/set-state-in-effect
  // (see AmbientWeather.tsx, app/signin/page.tsx).
  useEffect(() => {
    if (countSession() >= MIN_SESSIONS_BEFORE_SHOWING) queueMicrotask(() => setReturning(true));
    if (readInt(SHOWN_COUNT_KEY) >= MAX_TOTAL_SHOWS) return;
    const dismissedAt = readStr(DISMISSED_AT_KEY);
    if (dismissedAt && Date.now() - Number(dismissedAt) < DISMISS_COOLDOWN_MS) return;
    queueMicrotask(() => setStorageOk(true));
  }, []);

  // Saving anything is a clear engagement signal. The saved set is
  // account-backed, so this also fires for a signed-in visitor whose saves
  // load from an earlier visit, which is fine: they're not new.
  useEffect(
    () =>
      subscribeSavedChanges((keys) => {
        if (keys.size > 0) setHasSaved(true);
      }),
    []
  );

  const installable = platform !== null && platform !== "desktop";
  const engaged = pagesViewed >= MIN_PAGES_BEFORE_SHOWING || timeOnSiteReached;
  // Chat and search own the bottom of the screen (composer / keyboard).
  const onBusyScreen = /^\/(fomo|search)(\/|$)/.test(pathname);
  const visible =
    !onBusyScreen && storageOk && installable && !installed && !dismissed && consent !== "pending" && consent !== null && engaged && (returning || hasSaved);

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

  async function handleAction() {
    // Either route spends this show; same cooldown as an explicit dismiss.
    writeStr(DISMISSED_AT_KEY, String(Date.now()));
    setDismissed(true);
    if (canPrompt) {
      await promptInstall();
    } else {
      setSheetOpen(true);
    }
  }

  const message =
    platform === "ios" ? (
      <>
        Add Fomo to your home screen: tap <Icon name="ios_share" size={16} className="align-text-bottom" />, then
        &ldquo;Add to Home Screen&rdquo;.
      </>
    ) : platform === "in-app" ? (
      "Open Fomo in your browser to add it to your home screen."
    ) : platform === "ios-other-browser" ? (
      "Open Fomo in Safari to add it to your home screen."
    ) : (
      "Add Fomo to your home screen. Opens instantly, like an app."
    );

  return (
    <>
      {visible ? (
        <div
          role="region"
          aria-label="Install Fomo"
          className="fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] z-40 mx-auto flex w-full max-w-[480px] items-center gap-3 border-t border-hairline bg-surface-container-lowest/95 px-4 py-3 shadow-level-2 backdrop-blur-md lg:inset-x-auto lg:bottom-6 lg:right-6 lg:max-w-sm lg:rounded-xl lg:border"
        >
          <p className="flex-1 text-label-sm text-on-surface-variant">{message}</p>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => void handleAction()}
              className="min-h-9 rounded-full bg-primary px-3.5 py-1.5 text-label-sm font-bold text-on-primary hover:opacity-90"
            >
              {canPrompt ? "Install" : "Show me"}
            </button>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss"
              className="flex h-9 w-9 items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        </div>
      ) : null}
      <InstallSheet open={sheetOpen} onClose={() => setSheetOpen(false)} source="hint" />
    </>
  );
}

export default InstallHint;
