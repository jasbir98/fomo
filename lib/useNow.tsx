"use client";

import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

/**
 * The current time for text that depends on it ("Tonight 8pm", "On now ·
 * until 5pm", "Checked 2 days ago", today's weekday), safe to render in a
 * statically cached page.
 *
 * HYDRATION: Home, Deals, This weekend and the detail pages are built on the
 * server and re-served from the cache for minutes (or longer, when nobody has
 * asked for them), so their HTML holds labels worked out at build time. A
 * component that reads `new Date()` while rendering gets a different answer
 * on the client the moment the clock crosses a label boundary, and React
 * throws away the server markup ("Hydration failed", minified #418).
 *
 * `useNow` returns the server's own build time for the hydration pass, so the
 * first client render matches the HTML exactly, and the real time straight
 * after. It is a per-component `useSyncExternalStore` (not one value from the
 * provider) because React hydrates Suspense boundaries one at a time: a
 * provider that had already flipped to the client clock would hand every
 * boundary hydrating later the wrong time. On a client-side navigation there
 * is no hydration, so the very first render already has the real time.
 *
 * Without a `NowProvider` above it (an error page), a component falls back to
 * the time it first rendered.
 */
const ServerNowContext = createContext<Date | null>(null);

/** Mounted once in the shell layout with the time that layout was rendered on the server. */
export function NowProvider({ serverNow, children }: { serverNow: string; children: ReactNode }) {
  const value = useMemo(() => new Date(serverNow), [serverNow]);
  return <ServerNowContext.Provider value={value}>{children}</ServerNowContext.Provider>;
}

// One clock for the whole page, shared by every consumer so cards in the same
// render never disagree. Re-read when the first consumer mounts and when the
// tab comes back to the front, so a tab left open for hours doesn't keep
// yesterday's labels. Not a ticking interval: a re-sorted list under the
// visitor's thumb every minute is worse than a label that is a few minutes old.
let clientNow: Date | null = null;
const listeners = new Set<() => void>();

function refreshClock(): void {
  clientNow = new Date();
  for (const listener of listeners) listener();
}

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") refreshClock();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) document.addEventListener("visibilitychange", onVisibilityChange);
  listeners.add(listener);
  // A new page's first consumer: replace whatever time the last page left behind.
  if (listeners.size === 1) queueMicrotask(refreshClock);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

function getClientNow(): Date {
  return (clientNow ??= new Date());
}

export function useNow(): Date {
  const serverNow = useContext(ServerNowContext);
  const [fallback] = useState(() => new Date());
  const hydrationNow = serverNow ?? fallback;
  return useSyncExternalStore(subscribe, getClientNow, () => hydrationNow);
}
