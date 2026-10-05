"use client";

import { useSyncExternalStore } from "react";

/**
 * Desktop detail overlay — opens /happening, /event and /place pages as a
 * modal over whatever page you're on, instead of navigating away from it.
 *
 * Mechanism: native `history.pushState` to the detail's real URL. Next 16
 * folds a native pushState into its router (it copies its own tree into the
 * entry's state, verified 2026-10-02), so the current page stays mounted,
 * `usePathname()` reports the detail path, and Back pops the entry without a
 * reload. Each entry we push carries `fomoDetail` (the href) and
 * `fomoDetailDepth` (how many detail entries deep it is), so a popstate —
 * Back, Forward, or our own `closeDetail()` — can rebuild the overlay's
 * state from the entry alone. Intercepting routes were rejected because they
 * would change phones too; this only ever runs at ≥1024px.
 *
 * A reload or a shared link lands on the real detail page (the URL is the
 * canonical one), which renders its own full-page desktop layout.
 *
 * Plain module state + useSyncExternalStore: callers outside React's tree
 * (the provider's capture-phase click listener) and inside it (NavCard,
 * FeedHero) all go through `tryOpenDetail`.
 */

export type DetailKind = "happening" | "event" | "place";

export interface DetailTarget {
  kind: DetailKind;
  id: string;
  /** Same-origin path (plus any query) — what goes in the address bar. */
  href: string;
}

interface DetailState {
  target: DetailTarget | null;
  /** Detail entries we've pushed on top of the underlying page (0 when closed). */
  depth: number;
}

const DETAIL_PATH = /^\/(happening|event|place)\/([^/?#]+)\/?$/;

/** Matches Tailwind's `lg` breakpoint (64rem) — the desktop shell's threshold. */
export const DESKTOP_MEDIA_QUERY = "(min-width: 64rem)";

let state: DetailState = { target: null, depth: 0 };
let enabled = false;
const listeners = new Set<() => void>();

function setState(next: DetailState) {
  state = next;
  listeners.forEach((l) => l());
}

/** `{kind, id, href}` for a same-origin detail URL (relative or absolute), else null. */
export function parseDetailHref(href: string): DetailTarget | null {
  if (typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const m = DETAIL_PATH.exec(url.pathname);
  if (!m) return null;
  return { kind: m[1] as DetailKind, id: decodeURIComponent(m[2]), href: `${url.pathname}${url.search}` };
}

export function isDesktopViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}

/**
 * Open `href` in the overlay if it's a detail URL, we're on desktop and the
 * provider is mounted (it isn't on /signin, /welcome, …). Returns false when
 * the caller should navigate normally instead.
 */
export function tryOpenDetail(href: string): boolean {
  if (!enabled || !isDesktopViewport()) return false;
  const target = parseDetailHref(href);
  if (!target) return false;
  if (state.target?.href === target.href) return true;
  const depth = state.depth + 1;
  window.history.pushState({ fomoDetail: target.href, fomoDetailDepth: depth }, "", target.href);
  setState({ target, depth });
  return true;
}

/** Close by popping every detail entry we pushed; the popstate handler clears state. */
export function closeDetail() {
  if (!state.target) return;
  if (state.depth > 0) window.history.go(-state.depth);
  else setState({ target: null, depth: 0 });
}

/** Rebuild overlay state from the history entry we just landed on (Back/Forward/closeDetail). */
export function syncDetailFromHistory() {
  const entry = (window.history.state ?? {}) as { fomoDetail?: unknown; fomoDetailDepth?: unknown };
  const target = typeof entry.fomoDetail === "string" ? parseDetailHref(entry.fomoDetail) : null;
  const depth = typeof entry.fomoDetailDepth === "number" ? entry.fomoDetailDepth : 0;
  if (target && depth > 0) setState({ target, depth });
  else if (state.target) setState({ target: null, depth: 0 });
}

/**
 * Drop overlay state without touching history — for when the app navigated
 * somewhere else underneath it (a sidebar link while the modal was open), so
 * the entries we pushed are already behind the user.
 */
export function resetDetail() {
  if (state.target) setState({ target: null, depth: 0 });
}

/** The provider flips this on mount/unmount so links outside the shell never get intercepted. */
export function setDetailOverlayEnabled(on: boolean) {
  enabled = on;
  if (!on) resetDetail();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER_STATE: DetailState = { target: null, depth: 0 };

export function useDetailOverlay(): DetailState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE
  );
}
