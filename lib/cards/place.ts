import "server-only";
import type { Place } from "@/lib/types";
import type { Candidate } from "@/lib/cards/types";

// ---------------------------------------------------------------------------
// Split out of the old lib/now/generators.ts (the /api/now ranker, removed in
// the 2026-09 Fomo cleanup) — only the small formatting helpers other routes
// still need (GET /api/saved's card resolution, GET /api/feed's hero).
// ---------------------------------------------------------------------------

export function placeImage(place: Place): Candidate["image"] {
  return { url: place.image_url, quality: place.image_url ? place.image_quality ?? "thin" : "none" };
}

export function placeCoords(place: { lat: number | null; lng: number | null }): Candidate["coords"] {
  return place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null;
}

/**
 * Ticketing feeds carry placeholder venue rows ("Virtual Event Edinburgh",
 * "TBC", "Secret Location") that read as noise in a one-line detail. Drop
 * them rather than surfacing them verbatim — a vague venue is worse than no
 * venue.
 */
const PLACEHOLDER_VENUE = /^(virtual event|online|tbc|tba|secret location|various)\b/i;

/** Exported so app/api/saved/route.ts can build the same detail line for a saved event. */
export function venueLabel(name: string | null): string | null {
  if (!name || PLACEHOLDER_VENUE.test(name.trim())) return null;
  return name;
}

/**
 * Ticketing feeds title events as pipe-delimited SEO strings —
 * "Ryan Nicholls | Secret Location Rave | Edinburgh". Rendered verbatim that
 * blows a sane headline-length budget and reads like a listing, not a
 * recommendation. Strip the city segment (already implied — the user is
 * standing in it) and rejoin the rest with an em dash.
 */
export function eventHeadline(name: string, cityName: string): string {
  const city = cityName.toLowerCase();
  const parts = name
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !city || p.toLowerCase() !== city);
  if (parts.length === 0) return name.trim();
  return parts.join(" — ").replace(/\s*\(\s*([^)]+)\s*\)\s*$/, (m, inner: string) =>
    inner.trim().toLowerCase() === city ? "" : m
  );
}
