"use client";

import { useEffect, useSyncExternalStore } from "react";

export interface Coordinates {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two points, in kilometers. */
export function distanceKm(a: Coordinates, b: Coordinates): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "450 m" under 1 km, else "3.2 km". */
export function formatDistanceLabel(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/**
 * Rough walking-time estimate from a straight-line distance — same ~4.8km/h
 * pace and rounding lib/now/generators.ts's server-only `walkMinutes` uses,
 * duplicated here because that module is `import "server-only"` and this one
 * needs to run client-side (Plan's timeline "leave by" line). No
 * turn-by-turn/routing API is wired up anywhere in this codebase, so
 * straight-line distance is the only distance signal available; this is a
 * deliberate approximation, not a real ETA.
 */
export function walkMinutes(km: number): number {
  return Math.round((km / 4.8) * 60);
}

/**
 * Sorts `items` nearest-to-farthest from `from`. Items whose `getCoords`
 * returns null sort to the end, keeping their relative order. When `from`
 * is null (no live location yet, denied, or unsupported), returns `items`
 * unchanged -- callers keep today's ordering rather than showing an error.
 */
export function sortByDistance<T>(
  items: T[],
  from: Coordinates | null,
  getCoords: (item: T) => Coordinates | null
): T[] {
  if (!from) return items;
  return items
    .map((item, index) => ({ item, index, coords: getCoords(item) }))
    .sort((a, b) => {
      const da = a.coords ? distanceKm(from, a.coords) : Infinity;
      const db = b.coords ? distanceKm(from, b.coords) : Infinity;
      if (da !== db) return da - db;
      return a.index - b.index; // stable tie-break (equal distance, or both unresolved)
    })
    .map(({ item }) => item);
}

export type GeolocationStatus = "loading" | "granted" | "denied" | "unsupported";

export interface GeolocationState {
  coords: Coordinates | null;
  status: GeolocationStatus;
}

/** localStorage key for the last known fix -- bump the `v1` suffix if the shape ever changes. */
const CACHE_KEY = "roameo:geo:last-position:v1";
/** localStorage key that remembers a prior permission denial so we stop asking. */
const DENIED_KEY = "roameo:geo:denied:v1";

/**
 * How long a cached/browser-cached fix is trusted before we bother refreshing
 * it. This is a travel/discovery app (city-level "what's near me" sorting,
 * not turn-by-turn), so half an hour is plenty fresh and keeps us off the GPS
 * radio. Reused as `getCurrentPosition`'s `maximumAge` so the *browser's own*
 * position cache can also satisfy a request without a new fix.
 */
export const GEOLOCATION_CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedPosition {
  lat: number;
  lng: number;
  timestamp: number;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function readCachedPosition(): CachedPosition | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedPosition>;
    if (
      typeof parsed.lat !== "number" ||
      typeof parsed.lng !== "number" ||
      typeof parsed.timestamp !== "number"
    ) {
      return null;
    }
    return { lat: parsed.lat, lng: parsed.lng, timestamp: parsed.timestamp };
  } catch {
    // Safari private mode throws on read; a corrupt value throws on parse -- either way, no cache.
    return null;
  }
}

function writeCachedPosition(pos: CachedPosition): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(pos));
  } catch {
    // Quota exceeded / private mode -- losing the cache is fine, never crash the app for it.
  }
}

function isFresh(pos: CachedPosition): boolean {
  return Date.now() - pos.timestamp < GEOLOCATION_CACHE_TTL_MS;
}

function readDenied(): boolean {
  if (!hasWindow()) return false;
  try {
    return window.localStorage.getItem(DENIED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDenied(denied: boolean): void {
  if (!hasWindow()) return;
  try {
    if (denied) window.localStorage.setItem(DENIED_KEY, "1");
    else window.localStorage.removeItem(DENIED_KEY);
  } catch {
    // ignore -- non-fatal
  }
}

// --- Module-level shared store -------------------------------------------
//
// All `useGeolocation()` call sites (Home, Explore, Events, Reels, Discover
// -- every route is its own top-level client component, so navigating
// between tabs unmounts/remounts the hook) subscribe to ONE store instead of
// each running their own `getCurrentPosition()`. This is what makes
// navigating between tabs stop re-prompting: the underlying lookup runs at
// most once per page load, its result (and the permission outcome) is
// cached in localStorage, and every mount after the first just reads the
// already-resolved shared state.
//
// The store always *starts* at `INITIAL_STATE` on both server and client so
// the first client render matches the server-rendered markup exactly --
// reading localStorage synchronously here (or in a lazy useState
// initializer) would make the client's first render diverge from the
// server's and trip a hydration mismatch. Cache/permission hydration
// happens in an effect (`ensureInitialized`, below), i.e. strictly after
// mount, then republishes the real state to every subscriber.
const INITIAL_STATE: GeolocationState = { coords: null, status: "loading" };
let state: GeolocationState = INITIAL_STATE;
const listeners = new Set<() => void>();
let initStarted = false;
let inFlight: Promise<void> | null = null;

function setState(next: GeolocationState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): GeolocationState {
  return state;
}

function getServerSnapshot(): GeolocationState {
  return INITIAL_STATE;
}

/**
 * Actually calls `getCurrentPosition`, de-duplicated: if a lookup is already
 * in flight (e.g. two consumers mounted in the same tick), everyone shares
 * the one promise instead of firing a second GPS/network fix. Success and
 * failure both persist their outcome so the next page load skips straight
 * to the cache/denied fast path.
 */
function requestPosition(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = new Promise<void>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next: CachedPosition = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          timestamp: Date.now(),
        };
        writeCachedPosition(next);
        writeDenied(false);
        setState({ coords: { lat: next.lat, lng: next.lng }, status: "granted" });
        resolve();
      },
      () => {
        writeDenied(true);
        setState({ coords: null, status: "denied" });
        resolve();
      },
      // enableHighAccuracy: false -- this only needs city-level positioning,
      // and high accuracy engages GPS (slow, battery-hungry) for no benefit
      // here. maximumAge lets the *browser's* own position cache satisfy the
      // request so plenty of calls never need a fresh fix at all.
      { enableHighAccuracy: false, maximumAge: GEOLOCATION_CACHE_TTL_MS, timeout: 10 * 1000 }
    );
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function handlePermissionState(permission: PermissionState, cached: CachedPosition | null): void {
  if (permission === "denied") {
    writeDenied(true);
    setState({ coords: null, status: "denied" });
    return;
  }
  writeDenied(false);
  if (permission === "granted") {
    // Already granted -- refreshing is silent, no prompt, so always safe.
    void requestPosition();
    return;
  }
  // "prompt": only actually trigger the browser prompt if we don't already
  // have a fresh fix. This is what keeps a permission-granted user from
  // re-prompting on every navigation -- the prompt only fires once, here,
  // the first time `ensureInitialized` runs for the whole page load.
  if (!cached || !isFresh(cached)) void requestPosition();
}

/**
 * One-time-per-page-load bootstrap: hydrate from cache, then consult the
 * Permissions API (feature-detected -- support is patchy on Safari) to
 * decide whether it's safe to call `getCurrentPosition` at all. Guarded by
 * `initStarted` so remounting the hook on a different route never re-runs
 * this -- it just reads whatever the shared store already resolved to.
 */
function ensureInitialized(): void {
  if (initStarted) return;
  initStarted = true;
  if (!hasWindow() || typeof navigator === "undefined") return;

  if (!navigator.geolocation) {
    setState({ coords: null, status: "unsupported" });
    return;
  }

  const cached = readCachedPosition();
  if (cached && isFresh(cached)) {
    // Zero prompt, zero latency: consumers get coordinates on the very next
    // tick, before any permission check or network/GPS round trip.
    setState({ coords: { lat: cached.lat, lng: cached.lng }, status: "granted" });
  }

  if (navigator.permissions?.query) {
    navigator.permissions
      .query({ name: "geolocation" })
      .then((permissionStatus) => {
        handlePermissionState(permissionStatus.state, cached);
        // React if the user later flips the permission in browser settings,
        // instead of waiting for the next full page load to notice.
        permissionStatus.addEventListener("change", () => {
          handlePermissionState(permissionStatus.state, null);
        });
      })
      .catch(() => {
        fallbackWithoutPermissionsApi(cached);
      });
  } else {
    fallbackWithoutPermissionsApi(cached);
  }
}

/** Safari's Permissions API support is patchy -- degrade to the localStorage denial flag instead. */
function fallbackWithoutPermissionsApi(cached: CachedPosition | null): void {
  if (readDenied()) {
    setState({ coords: null, status: "denied" });
    return;
  }
  if (!cached || !isFresh(cached)) void requestPosition();
}

/**
 * Explicit user-triggered refresh (e.g. an "enable location" / "update my
 * location" tap). Goes through the same shared store/cache/dedupe pipeline
 * as the automatic bootstrap, so its result is immediately visible to every
 * `useGeolocation()` consumer on the page, not just the caller.
 */
export function refreshGeolocation(): Promise<void> {
  if (!hasWindow() || typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve();
  }
  return requestPosition();
}

/**
 * One-shot device location (not a live-tracking watch -- this is a travel
 * app, not a turn-by-turn navigator). Denial, error, or an unsupported
 * browser all just resolve `coords: null`; callers only branch on `coords`
 * for sorting, so this never needs an error UI -- it silently falls back to
 * today's ordering, per product decision.
 *
 * Backed by one shared, localStorage-cached, permission-aware lookup (see
 * above) -- mounting this hook on a new route never re-prompts or re-fires
 * `getCurrentPosition()` as long as a fresh cached fix or granted
 * permission already resolved it earlier in the page load.
 */
export function useGeolocation(): GeolocationState {
  useEffect(() => {
    ensureInitialized();
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
