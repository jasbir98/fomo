"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Shared infinite-scroll list state, extracted from the one correct
 * implementation this app had (app/(shell)/experiences/page.tsx's original
 * inline version) so /events and any future paginated surface (/discover/
 * [intent], /saved) don't each hand-roll their own copy of the same three
 * subtleties:
 *
 *  - a `liveRef` mirror of the latest filters/state, read inside the
 *    IntersectionObserver callback so the observer doesn't need tearing down
 *    and recreating on every keystroke/page fetch
 *  - a fetch-generation counter (`requestIdRef`) so a "load more" response
 *    that resolves after the caller's filters have already changed gets
 *    discarded instead of appending stale rows to the new list
 *  - `hasMore` derived from `rows.length >= pageSize` (a full page came
 *    back, so there might be another) rather than a server-provided total
 *
 * Fully generic over the item type and the params driving the fetch (a
 * destination string, search text, category filter, etc) — the caller
 * supplies a `fetchPage` function and a dependency array that mirrors that
 * function's closed-over inputs; a change to any of those deps resets the
 * list and refetches page 1, exactly like the original experiences-page
 * effect keyed on `[destination, activeSlug, search]`.
 */

export interface UseInfiniteListOptions<T> {
  /**
   * Fetches one page. Called with `{ limit, offset }` — `offset` is always
   * the current accumulated row count, so `fetchPage({ limit, offset: 0 })`
   * is page 1. Return `null`/`undefined`-safe: throwing is caught and
   * logged, and simply stops that page's load (existing rows are kept).
   */
  fetchPage: (params: { limit: number; offset: number }) => Promise<T[]>;
  /** Rows returned per page — also the threshold `hasMore` is judged against. */
  pageSize: number;
  /** Stable identity for a row, for de-duping a "load more" response against what's already loaded. */
  getId: (item: T) => string;
  /**
   * Gate on the first page fetch firing at all — e.g. `!!destination`. When
   * false, the hook stays in its initial `loading: true`, no-op state
   * (mirrors both source pages guarding their effects on `!destination`
   * before the trip has loaded).
   */
  enabled?: boolean;
  /**
   * Delays the page-1 fetch by this many ms after `deps` settle, so a
   * fast-typed search doesn't fire a request per keystroke — same debounce
   * both source pages (map, experiences) already used ad hoc. A `deps`
   * change while a timer is pending cancels it, matching the original
   * `clearTimeout` cleanup.
   */
  debounceMs?: number;
  /** Called (best-effort) when a page fetch throws — for `console.error`-style logging by the caller. */
  onError?: (err: unknown, phase: "initial" | "more") => void;
}

export interface UseInfiniteListResult<T> {
  items: T[];
  /** True only for the very first page of the current filter set. */
  loading: boolean;
  /** True while a subsequent page is in flight. */
  loadingMore: boolean;
  hasMore: boolean;
  /** Attach to a trailing sentinel element after the last rendered row. */
  sentinelRef: RefObject<HTMLDivElement | null>;
  /**
   * Attach to the scrolling container for a horizontal/constrained list.
   * Leave unattached (root stays `null` → the viewport) for a plain vertical
   * page list — same distinction lib/useProgressiveReveal.ts's `vertical`
   * option and app/(shell)/events/page.tsx's Phase A fix are about.
   */
  rootRef: RefObject<HTMLDivElement | null>;
}

/**
 * `deps` should list every value `fetchPage` closes over that should reset
 * pagination when it changes (destination, search text, active filter, …) —
 * exactly the effect-dependency array the original experiences-page fetch
 * effect had. Changing `fetchPage`/`getId`/`pageSize` themselves does not
 * reset anything by design (callers are expected to pass stable-enough
 * closures; only `deps` drives a page-1 refetch), so the caller isn't forced
 * to `useCallback` the fetcher just to avoid an extra reset loop.
 */
export function useInfiniteList<T>(
  { fetchPage, pageSize, getId, enabled = true, debounceMs = 0, onError }: UseInfiniteListOptions<T>,
  deps: unknown[]
): UseInfiniteListResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Mutable mirror read by the IntersectionObserver callback so the observer
  // only needs to be attached once per filter set, not torn down/recreated
  // on every page fetch.
  const liveRef = useRef({ enabled, hasMore, loadingMore, items });
  useEffect(() => {
    liveRef.current = { enabled, hasMore, loadingMore, items };
  });

  // Bumped whenever `deps` change so a "load more" response that resolves
  // after the caller's filters already moved on gets discarded instead of
  // appending stale rows to the new list.
  const requestIdRef = useRef(0);

  // Page 1 — refetches and resets whenever a caller-supplied dep changes.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const myRequestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      (async () => {
        setLoading(true);
        try {
          const rows = await fetchPage({ limit: pageSize, offset: 0 });
          if (cancelled || requestIdRef.current !== myRequestId) return;
          setItems(rows);
          setHasMore(rows.length >= pageSize);
        } catch (err) {
          if (!cancelled) onError?.(err, "initial");
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, debounceMs, ...deps]);

  // Infinite scroll — loads the next page when the trailing sentinel scrolls
  // into view. Needs `loading` in its deps: the sentinel only mounts once
  // the first page has rendered, so `sentinelRef.current` is still null the
  // instant this effect first runs (right when `enabled` flips true, while
  // `loading` is still true) — without re-running once `loading` flips to
  // false, the observer would never attach to the real node.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        const { enabled: live, hasMore: more, loadingMore: busy, items: current } = liveRef.current;
        if (!live || !more || busy) return;

        const myRequestId = requestIdRef.current;
        setLoadingMore(true);
        fetchPage({ limit: pageSize, offset: current.length })
          .then((rows) => {
            if (requestIdRef.current !== myRequestId) return; // filters changed mid-fetch
            setItems((prev) => {
              const seen = new Set(prev.map(getId));
              const fresh = rows.filter((r) => !seen.has(getId(r)));
              return fresh.length > 0 ? [...prev, ...fresh] : prev;
            });
            setHasMore(rows.length >= pageSize);
          })
          .catch((err) => onError?.(err, "more"))
          .finally(() => {
            if (requestIdRef.current === myRequestId) setLoadingMore(false);
          });
      },
      { rootMargin: "0px 0px 600px 0px", threshold: 0 }
    );
    observer.observe(node);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loading]);

  return { items, loading, loadingMore, hasMore, sentinelRef, rootRef };
}
