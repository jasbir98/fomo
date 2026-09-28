// Server-side Mapbox geocoding — turns a destination string ("Tokyo, Japan")
// into a map center coordinate. Used by lib/weather.ts.
import "server-only";

export interface Center {
  lat: number;
  lng: number;
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
