"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { supabaseBrowserAuth } from "@/lib/supabase/client";

/**
 * A tiny stale-while-revalidate JSON cache for client-side GET requests —
 * the piece this app was missing entirely (every page did a raw `fetch()`
 * inside `useEffect`, so every mount/navigation showed a skeleton again,
 * even for data that hadn't changed in seconds). No new dependency; same
 * module-level-store + `useSyncExternalStore` shape as `lib/geo.ts` and
 * `lib/useSaved.ts`, just keyed and generic over the payload instead of one
 * fixed shape.
 *
 * Mirrored to `sessionStorage` (not `localStorage`: this is per-user data —
 * see the SIGNED_OUT wipe below — and a tab-scoped cache is the right
 * lifetime for "reload within the same tab paints instantly", not
 * "persists forever across browsers/devices"). Every storage read/write is
 * try/catch'd — Safari private mode throws on write, and a corrupt/foreign
 * value throws on parse; either way, the in-memory cache still works, it
 * just behaves like a cold cache for that one key.
 *
 * Two components requesting the same key share one in-flight request (the
 * `inFlight` map below) rather than firing a duplicate fetch, and a failed
 * revalidation never discards previously-good data — it keeps the last
 * value and surfaces `error` alongside it, so a flaky network blip dims
 * nothing that was already on screen.
 */

const STORAGE_PREFIX = "fomo:cache:v1:";
/** Drop an entry from the sessionStorage mirror rather than persist it — the in-memory cache still holds it for this tab's lifetime. */
const MAX_PERSISTED_ENTRY_BYTES = 2 * 1024 * 1024;
/** Roughly-LRU cap (by `fetchedAt`) on the sessionStorage mirror so a long session doesn't slowly fill quota with stale keys. */
const MAX_PERSISTED_KEYS = 50;
/** Default staleness window — matches `CACHE_SHORT` in lib/http/cache.ts, the shortest server preset, so the client never trusts data longer than the server already promises to serve fresh browser-cached responses for. */
const DEFAULT_STALE_MS = 60_000;

interface CacheEntry<T = unknown> {
  data: T | undefined;
  error: unknown;
  /** `Date.now()` of the last *successful* fetch; 0 means "never fetched". */
  fetchedAt: number;
  isValidating: boolean;
}

const EMPTY_ENTRY: CacheEntry<unknown> = { data: undefined, error: undefined, fetchedAt: 0, isValidating: false };

// --- Module-level shared store -------------------------------------------
const store = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Map<string, Promise<void>>();
// Keys already checked against sessionStorage this page load — read once per
// key, not on every getEntry() call.
const hydratedKeys = new Set<string>();

function storageKey(key: string): string {
  return STORAGE_PREFIX + key;
}

function isStaleEntry(entry: CacheEntry, staleMs: number): boolean {
  return entry.data === undefined || Date.now() - entry.fetchedAt > staleMs;
}

function notify(key: string): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const listener of set) listener();
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(key);
  };
}

/** Best-effort LRU-ish trim of the sessionStorage mirror to `MAX_PERSISTED_KEYS`, oldest `fetchedAt` first. */
function enforceStorageCap(): void {
  try {
    const rows: { storageKey: string; fetchedAt: number }[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      if (!k || !k.startsWith(STORAGE_PREFIX)) continue;
      try {
        const raw = window.sessionStorage.getItem(k);
        const parsed = raw ? (JSON.parse(raw) as { fetchedAt?: number }) : null;
        rows.push({ storageKey: k, fetchedAt: parsed?.fetchedAt ?? 0 });
      } catch {
        rows.push({ storageKey: k, fetchedAt: 0 }); // corrupt -- evict first
      }
    }
    if (rows.length <= MAX_PERSISTED_KEYS) return;
    rows.sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (const row of rows.slice(0, rows.length - MAX_PERSISTED_KEYS)) {
      window.sessionStorage.removeItem(row.storageKey);
    }
  } catch {
    // Reading sessionStorage.length/key() can throw in the same private-mode
    // cases as get/set -- losing the cap enforcement for this write is fine.
  }
}

function persistEntry(key: string, entry: CacheEntry): void {
  if (typeof window === "undefined" || entry.data === undefined) return;
  try {
    const serialized = JSON.stringify({ data: entry.data, fetchedAt: entry.fetchedAt });
    if (serialized.length > MAX_PERSISTED_ENTRY_BYTES) return; // still cached in memory for this tab, just not mirrored
    window.sessionStorage.setItem(storageKey(key), serialized);
    enforceStorageCap();
  } catch {
    // Quota exceeded / private mode -- in-memory cache still works.
  }
}

function setEntry(key: string, entry: CacheEntry): void {
  store.set(key, entry);
  persistEntry(key, entry);
  notify(key);
}

/** Reads sessionStorage for `key` exactly once per page load (per key), the first time it's asked for. */
function ensureHydrated(key: string): void {
  if (hydratedKeys.has(key) || typeof window === "undefined") return;
  hydratedKeys.add(key);
  if (store.has(key)) return; // already warmed this session (e.g. prefetchJson beat us to it)
  try {
    const raw = window.sessionStorage.getItem(storageKey(key));
    if (!raw) return;
    const parsed = JSON.parse(raw) as { data: unknown; fetchedAt: number };
    store.set(key, { data: parsed.data, error: undefined, fetchedAt: parsed.fetchedAt, isValidating: false });
  } catch {
    // Corrupt entry -- behaves like a cache miss for this key.
  }
}

function getEntry(key: string): CacheEntry {
  ensureHydrated(key);
  return store.get(key) ?? EMPTY_ENTRY;
}

/**
 * Runs `fetcher`, de-duped per key: a second caller while one's already in
 * flight just awaits the same promise instead of firing another request.
 * Never throws away good data on failure -- the entry keeps its last `data`
 * and picks up `error` instead.
 */
function doFetch(key: string, fetcher: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const current = getEntry(key);
  setEntry(key, { ...current, isValidating: true });

  const controller = new AbortController();
  const promise = fetcher(controller.signal)
    .then((data) => {
      setEntry(key, { data, error: undefined, fetchedAt: Date.now(), isValidating: false });
    })
    .catch((err: unknown) => {
      const latest = getEntry(key);
      if (err instanceof DOMException && err.name === "AbortError") {
        setEntry(key, { ...latest, isValidating: false });
        return;
      }
      setEntry(key, { data: latest.data, error: err, fetchedAt: latest.fetchedAt, isValidating: false });
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** Warms the cache for `key` without mounting a component -- e.g. Home prefetching the other two feed windows in the background. A no-op if `key` already holds fresh-enough (< `staleMs`) data or a fetch for it is already in flight. */
export function prefetchJson<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  staleMs: number = DEFAULT_STALE_MS
): void {
  if (typeof window === "undefined") return;
  if (!isStaleEntry(getEntry(key), staleMs)) return;
  void doFetch(key, fetcher);
}

/**
 * Marks every cached key starting with `prefix` as stale (keeps the data,
 * resets `fetchedAt` to 0) and drops its sessionStorage mirror. Any
 * currently-mounted `useCachedJson` consumer of that key re-checks
 * staleness the instant its entry changes (see the hook's effect below) and
 * revalidates on its own -- callers don't need to know who, if anyone, is
 * watching a given key.
 */
export function invalidate(prefix: string): void {
  for (const [key, entry] of store.entries()) {
    if (key.startsWith(prefix)) setEntry(key, { ...entry, fetchedAt: 0 });
  }
  if (typeof window === "undefined") return;
  try {
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const k = window.sessionStorage.key(i);
      if (!k || !k.startsWith(STORAGE_PREFIX)) continue;
      if (k.slice(STORAGE_PREFIX.length).startsWith(prefix)) window.sessionStorage.removeItem(k);
    }
  } catch {
    // best-effort
  }
}

/** Drops everything -- memory and sessionStorage -- and wakes every mounted consumer. Cached data is per-user, so this runs on Supabase SIGNED_OUT (see `ensureAuthListener` below); a shared/kiosk device must not show the next signed-in visitor the previous one's cached saved items, feed, etc. */
function clearAll(): void {
  store.clear();
  hydratedKeys.clear();
  for (const key of listeners.keys()) notify(key);
  if (typeof window === "undefined") return;
  try {
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const k = window.sessionStorage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) window.sessionStorage.removeItem(k);
    }
  } catch {
    // best-effort
  }
}

let authListenerStarted = false;
/** Same one-time-wiring pattern as lib/useSaved.ts's `ensureInitialized` -- started lazily by the first mounted `useCachedJson`, not an app-wide provider. */
function ensureAuthListener(): void {
  if (authListenerStarted || typeof window === "undefined") return;
  authListenerStarted = true;
  supabaseBrowserAuth().auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") clearAll();
  });
}

export interface UseCachedJsonOptions {
  /** How long a value is trusted before a mount/focus/visibility check revalidates it in the background. Default 60s -- see `DEFAULT_STALE_MS`. */
  staleMs?: number;
}

export interface UseCachedJsonResult<T> {
  data: T | undefined;
  error: unknown;
  /** True only while there's no data at all yet -- the "show a skeleton" signal. False as soon as any data (even stale) is available, including synchronously on first render from a warm cache. */
  isLoading: boolean;
  /** True while a fetch (initial or background revalidation) is in flight. Use this, not `isLoading`, to drive a thin progress indicator over otherwise-visible cached content. */
  isValidating: boolean;
  /** Replace the cached value directly (e.g. after a mutation) without a network round trip. */
  mutate: (data: T) => void;
  /** Force a background refetch now, regardless of staleness. */
  revalidate: () => void;
}

/**
 * Stale-while-revalidate read for one JSON endpoint. `key` doubles as the
 * cache key and the de-dupe key -- callers building a key per parameter
 * (e.g. `feed:${window}`) get one cache slot per parameter value for free.
 * `key: null` disables the hook entirely (mirrors `enabled` on
 * `lib/useInfiniteList.ts`) -- useful when the fetch depends on something
 * not resolved yet (e.g. a destination).
 *
 * Returns cached data synchronously on first client render when present.
 * This relies on `useSyncExternalStore`'s documented hydration behaviour:
 * React renders the *server* snapshot (always `EMPTY_ENTRY` here -- see
 * `getServerSnapshot` below) for the pass that has to match the
 * server-rendered HTML, then immediately re-renders with the real client
 * snapshot once hydration commits -- so there's no server/client mismatch
 * to warn about, even though the very next paint can already show cached
 * data. All call sites are "use client" pages behind the login wall, so
 * there's nothing sensitive about that first paint being cache-driven.
 */
export function useCachedJson<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: UseCachedJsonOptions
): UseCachedJsonResult<T> {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  // Ref'd so revalidate()/effects always call the latest closure without
  // needing `fetcher` itself to be stable across renders (same reasoning as
  // lib/useInfiniteList.ts not requiring callers to useCallback theirs).
  const fetcherRef = useRef(fetcher);
  // Assigned in an effect, not directly during render -- mutating a ref's
  // `.current` while rendering trips the react-hooks/refs rule (and is
  // genuinely unsafe under concurrent rendering); every reader of this ref
  // only runs from an effect or an event handler, both strictly after this
  // effect has had a chance to run for the current render.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const subscribeForKey = useCallback(
    (onStoreChange: () => void) => (key ? subscribe(key, onStoreChange) : () => {}),
    [key]
  );
  const getSnapshotForKey = useCallback(() => (key ? getEntry(key) : EMPTY_ENTRY), [key]);
  const getServerSnapshot = useCallback(() => EMPTY_ENTRY, []);

  const entry = useSyncExternalStore(subscribeForKey, getSnapshotForKey, getServerSnapshot) as CacheEntry<T>;

  const revalidate = useCallback(() => {
    if (!key) return;
    void doFetch(key, (signal) => fetcherRef.current(signal));
  }, [key]);

  // Mount + "went stale" check. Deliberately keyed on `entry.fetchedAt`, not
  // the whole `entry` object: an isValidating-only transition produces a new
  // entry reference but doesn't change `fetchedAt`, so this doesn't refire
  // mid-fetch -- it only re-checks staleness once a fetch actually resolves
  // (its own success leaves fresh data, so no re-trigger) or once something
  // external -- `invalidate()` -- resets `fetchedAt` to 0 out from under a
  // mounted consumer.
  useEffect(() => {
    ensureAuthListener();
    if (!key) return;
    if (isStaleEntry(getEntry(key), staleMs)) revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, staleMs, entry.fetchedAt]);

  // Revalidate on return-to-tab, but only if what's cached has actually gone
  // stale meanwhile -- switching tabs for ten seconds shouldn't refetch.
  useEffect(() => {
    if (!key) return;
    function onWake() {
      if (document.visibilityState === "hidden") return;
      if (key && isStaleEntry(getEntry(key), staleMs)) revalidate();
    }
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [key, staleMs, revalidate]);

  const mutate = useCallback(
    (data: T) => {
      if (!key) return;
      setEntry(key, { data, error: undefined, fetchedAt: Date.now(), isValidating: false });
    },
    [key]
  );

  return {
    data: entry.data,
    error: entry.error,
    isLoading: entry.data === undefined,
    isValidating: entry.isValidating,
    mutate,
    revalidate,
  };
}
