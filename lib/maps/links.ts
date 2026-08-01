// Client-safe helpers for building external maps deep-links (no routing API
// in this repo — directions are handed off to Google Maps).
import type { Place } from "@/lib/types";

/**
 * Build a Google Maps "universal" directions link for a place — works on
 * iOS/Android (opens the Maps app if installed) and web as a plain fallback.
 * Prefers lat/lng (+ google_place_id disambiguation when present); falls
 * back to the address, then the name, as a free-text destination. Returns
 * null when there's nothing to route to, so the caller can disable the CTA.
 */
export function buildDirectionsUrl(place: Place): string | null {
  const { lat, lng, google_place_id, address, name } = place;

  if (typeof lat === "number" && typeof lng === "number") {
    let url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    if (google_place_id) {
      url += `&destination_place_id=${encodeURIComponent(google_place_id)}`;
    }
    return url;
  }

  const fallback = address ?? name;
  if (!fallback) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fallback)}`;
}

/**
 * Build a Google Maps search deep-link for a free-text query — used when a
 * reel has no resolved Place to route directions to, so the user can still
 * look the spot up on Maps themselves.
 */
export function buildSearchMapUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
