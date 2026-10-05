"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DESKTOP_MEDIA_QUERY } from "@/lib/detail-overlay/store";

/**
 * Live `matchMedia` match for `query`. `null` on the server and on the very
 * first client render (so hydration always agrees with the server HTML), then
 * the real boolean — callers render a CSS-gated fallback while it is null.
 */
export function useMediaQuery(query: string): boolean | null {
  // Stable per query: an inline function would make React unsubscribe and
  // resubscribe on every render.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query]
  );
  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore<boolean | null>(subscribe, getSnapshot, () => null);
}

/** True at Tailwind's `lg` (>=1024px) and up — the desktop shell's threshold. `null` until known. */
export function useIsDesktop(): boolean | null {
  return useMediaQuery(DESKTOP_MEDIA_QUERY);
}
