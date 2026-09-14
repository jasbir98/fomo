// Server-side Mapbox geocoding for the /api/places route.
// Turns a destination string ("Tokyo, Japan") into a map center coordinate.
import "server-only";

export interface Center {
  lat: number;
  lng: number;
}

export interface PlaceSuggestion {
  /** Human-readable place name, e.g. "Kyoto, Japan". */
  name: string;
  lat: number;
  lng: number;
  /**
   * ISO-2 country code (e.g. "JP"), read from Mapbox's feature `context[]`
   * entry whose `id` is prefixed `country.`. Null when the feature has no
   * country context (rare — mostly `types=country` results themselves) or
   * short_code is missing.
   */
  countryCode: string | null;
}

/**
 * Forward-geocode a partial query into up to `limit` place suggestions for
 * destination autocomplete (place / locality / region / country types).
 * Returns [] when the token is missing or the request fails — the caller's
 * input still works as free text.
 */
export async function geocodeSuggestions(
  query: string,
  limit = 5
): Promise<PlaceSuggestion[]> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const q = query.trim();
  if (!token || q.length < 2) return [];

  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/` +
    `${encodeURIComponent(q)}.json` +
    `?access_token=${encodeURIComponent(token)}` +
    `&autocomplete=true&types=place,locality,region,country&limit=${limit}` +
    // Force English place names — otherwise Mapbox returns the local-script
    // name (e.g. "鎌倉市" for Kamakura) for many non-Latin-script places,
    // which breaks curated-place city matching (listPlacesByCity) downstream
    // since our seed data is romanized.
    `&language=en`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(
        `[api/geocode] mapbox suggest failed: ${res.status} ${res.statusText}`
      );
      return [];
    }
    const data = (await res.json()) as {
      features?: Array<{
        place_name?: string;
        center?: [number, number];
        context?: Array<{ id?: string; short_code?: string }>;
      }>;
    };
    const out: PlaceSuggestion[] = [];
    for (const f of data.features ?? []) {
      const c = f.center;
      if (!f.place_name || !c || c.length !== 2) continue;
      const [lng, lat] = c; // Mapbox returns [lng, lat].
      if (typeof lat !== "number" || typeof lng !== "number") continue;
      const countryCtx = f.context?.find((entry) => entry.id?.startsWith("country."));
      const countryCode = countryCtx?.short_code ? countryCtx.short_code.toUpperCase() : null;
      out.push({ name: f.place_name, lat, lng, countryCode });
    }
    return out;
  } catch (err) {
    console.error("[api/geocode] mapbox suggest error", err);
    return [];
  }
}

/**
 * Geocode a destination string → { lat, lng } via the Mapbox Geocoding API.
 * Returns null if the token is missing, the request fails, or no feature is
 * returned — callers must treat a null center as "map center unavailable" and
 * carry on (text search still works without a location bias).
 */
export async function geocodeDestination(
  destination: string
): Promise<Center | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token) return null;

  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/` +
    `${encodeURIComponent(destination)}.json` +
    `?access_token=${encodeURIComponent(token)}&limit=1`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(
        `[api/places] mapbox geocode failed: ${res.status} ${res.statusText}`
      );
      return null;
    }
    const data = (await res.json()) as {
      features?: Array<{ center?: [number, number] }>;
    };
    const center = data.features?.[0]?.center;
    if (!center || center.length !== 2) return null;
    const [lng, lat] = center; // Mapbox returns [lng, lat].
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return { lat, lng };
  } catch (err) {
    console.error("[api/places] mapbox geocode error", err);
    return null;
  }
}
