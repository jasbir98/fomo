/**
 * Fomo Geocode — destination autocomplete for the create-trip flow.
 *
 * GET /api/geocode?q=<partial place name>
 *   → { suggestions: { name, lat, lng }[] }
 *
 * Thin server-side proxy over Mapbox forward geocoding. Keeps the same Mapbox
 * token usage as /api/places and always responds 200 with a usable body —
 * degrades to an empty list when the token is missing or Mapbox errors, so the
 * destination field still works as free-text input.
 */
import "server-only";
import { geocodeSuggestions, type PlaceSuggestion } from "@/lib/places/geocode";
import { cachedJson, CACHE_IMMUTABLE } from "@/lib/http/cache";

export const runtime = "nodejs";

interface GeocodeResponse {
  suggestions: PlaceSuggestion[];
}

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const suggestions = await geocodeSuggestions(q);
  // No auth, no per-user data, and forward-geocoding results for a given
  // free-text query are effectively immutable — cacheable aggressively, but
  // browser-cache only (`private`), never `public`/`s-maxage`: this route
  // is matched by proxy.ts's /api/* matcher too, so it's subject to the
  // same session-refresh Set-Cookie risk (see lib/http/cache.ts).
  return cachedJson<GeocodeResponse>({ suggestions }, CACHE_IMMUTABLE);
}
