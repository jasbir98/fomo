// Client-safe helpers for building external maps deep-links (no routing API
// in this repo — directions are handed off to Google Maps).
import type { Place } from "@/lib/types";
import { CITY } from "@/lib/city";

/**
 * One Google Maps directions URL for anything with coordinates and/or a
 * text location. Uses Google's cross-platform `maps/dir/?api=1` URL, which
 * opens maps.google.com on desktop/web and hands off to the Maps app on
 * phones. Free-text fallbacks get the city appended so a bare venue name
 * doesn't resolve to a same-named place elsewhere.
 */
export function directionsUrlFor(input: {
  lat?: number | null;
  lng?: number | null;
  placeId?: string | null;
  query?: string | null;
}): string | null {
  if (typeof input.lat === "number" && typeof input.lng === "number") {
    let url = `https://www.google.com/maps/dir/?api=1&destination=${input.lat},${input.lng}`;
    if (input.placeId) {
      url += `&destination_place_id=${encodeURIComponent(input.placeId)}`;
    }
    return url;
  }

  if (input.query && input.query.trim()) {
    const query = input.query.trim();
    // Don't append city if query already contains it (case-insensitive)
    const queryWithCity = query.toLowerCase().includes(CITY.name.toLowerCase())
      ? query
      : `${query}, ${CITY.name}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(queryWithCity)}`;
  }

  return null;
}

/**
 * Build a Google Maps "universal" directions link for a place — works on
 * iOS/Android (opens the Maps app if installed) and web as a plain fallback.
 * Prefers lat/lng (+ google_place_id disambiguation when present); falls
 * back to the address, then the name, as a free-text destination. Returns
 * null when there's nothing to route to, so the caller can disable the CTA.
 */
export function buildDirectionsUrl(place: Place): string | null {
  const { lat, lng, google_place_id, address, name } = place;
  return directionsUrlFor({
    lat,
    lng,
    placeId: google_place_id,
    query: address ?? name,
  });
}

/**
 * Build a Google Maps search deep-link for a free-text query — used when a
 * reel has no resolved Place to route directions to, so the user can still
 * look the spot up on Maps themselves.
 */
export function buildSearchMapUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
