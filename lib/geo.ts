"use client";

import { useEffect, useState } from "react";

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

function initialGeolocationState(): GeolocationState {
  const supported = typeof navigator !== "undefined" && !!navigator.geolocation;
  return { coords: null, status: supported ? "loading" : "unsupported" };
}

/**
 * One-shot device location (not a live-tracking watch -- this is a travel
 * app, not a turn-by-turn navigator). Denial, error, or an unsupported
 * browser all just resolve `coords: null`; callers only branch on `coords`
 * for sorting, so this never needs an error UI -- it silently falls back to
 * today's ordering, per product decision.
 */
export function useGeolocation(): GeolocationState {
  const [state, setState] = useState<GeolocationState>(initialGeolocationState);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (cancelled) return;
        setState({
          coords: { lat: position.coords.latitude, lng: position.coords.longitude },
          status: "granted",
        });
      },
      () => {
        if (cancelled) return;
        setState({ coords: null, status: "denied" });
      },
      { maximumAge: 5 * 60 * 1000, timeout: 10 * 1000 }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
