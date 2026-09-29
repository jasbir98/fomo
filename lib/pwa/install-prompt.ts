/**
 * PWA install plumbing, shared by InstallHint, InstallSheet, AppHeader and the
 * profile page. Safe to import anywhere: nothing here touches `window` until
 * `initInstallCapture()` runs (client only), and the server snapshot is a
 * constant, so it can sit behind useSyncExternalStore (see useInstallState).
 *
 * Why a module and not a component: Chrome fires `beforeinstallprompt` once,
 * shortly after load, and it's gone if nobody was listening. InstallCapture
 * (rendered from app/layout.tsx) imports this file, which attaches the
 * listener as the chunk evaluates, before AppShell or any page has mounted.
 */
import { track } from "@/lib/analytics/track";

export type InstallPlatform = "android" | "ios" | "ios-other-browser" | "in-app" | "desktop" | null;

export interface InstallState {
  /** null until the client has looked (and always null on the server). */
  platform: InstallPlatform;
  /** A native install prompt is stashed and `promptInstall()` will show it. */
  canPrompt: boolean;
  /** Running as an installed app (standalone display mode), or just installed. */
  installed: boolean;
}

/** Not yet in lib.dom.d.ts. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

/** Stable reference: useSyncExternalStore needs the same object every call. */
export const SERVER_INSTALL_STATE: InstallState = { platform: null, canPrompt: false, installed: false };

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let justInstalled = false;
let started = false;
let snapshot: InstallState = SERVER_INSTALL_STATE;
const listeners = new Set<() => void>();

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

function detectPlatform(): InstallPlatform {
  const ua = navigator.userAgent;
  // In-app browsers first: they can't install anything, whatever the OS.
  if (/Instagram|FBAN|FBAV|TikTok|musical_ly|Snapchat/i.test(ua)) return "in-app";
  // iPadOS 13+ reports as a Mac; touch points give it away.
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) {
    // Chrome/Firefox/Edge/Opera on iOS all ride WebKit but can't add to Home Screen.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? "ios-other-browser" : "ios";
  }
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

function compute(): InstallState {
  const next: InstallState = {
    platform: detectPlatform(),
    canPrompt: deferredPrompt !== null,
    installed: justInstalled || isStandalone(),
  };
  const prev = snapshot;
  return prev.platform === next.platform && prev.canPrompt === next.canPrompt && prev.installed === next.installed
    ? prev
    : next;
}

function emit() {
  const next = compute();
  if (next === snapshot) return;
  snapshot = next;
  listeners.forEach((l) => l());
}

/** Idempotent. Attaches the window listeners once; no-op on the server. */
export function initInstallCapture(): void {
  if (typeof window === "undefined" || started) return;
  started = true;

  window.addEventListener("beforeinstallprompt", (e) => {
    // Suppress the mini-infobar; we offer the prompt from our own UI.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    justInstalled = true;
    emit();
  });
  try {
    window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", emit);
  } catch {
    // Old Safari: no MediaQueryList.addEventListener. Standalone is read at load anyway.
  }

  snapshot = compute();
}

export function getInstallState(): InstallState {
  if (typeof window === "undefined") return SERVER_INSTALL_STATE;
  initInstallCapture();
  return snapshot;
}

export function subscribeInstall(cb: () => void): () => void {
  initInstallCapture();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Shows the browser's own install dialog. Must be called from a click handler
 * (the browser requires a user gesture). The event is one-shot, so it's spent
 * whatever the outcome.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = deferredPrompt;
  if (!event) return "unavailable";
  deferredPrompt = null;
  emit();
  const platform = snapshot.platform ?? "unknown";
  track("install_prompted", { platform });
  try {
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") track("install_accepted", { platform });
    return choice.outcome;
  } catch {
    // Prompt already consumed, or dismissed via OS chrome.
    return "dismissed";
  }
}

// Attach as soon as the chunk evaluates (client only), before any component mounts.
initInstallCapture();
