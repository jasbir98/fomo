// GET /api/tips/places?q=<text>&session=<token>
//
// Google Places Autocomplete for the tip form's "Where?" field. Separate from
// /api/places/autocomplete (Explore's, signed-in only) because tips are mostly
// sent signed out, and that route's per-user limits need a session. Public
// here, so it's capped twice: per IP and site-wide (lib/rate-limit.ts's anon
// limiter), and it never costs anything below 3 characters. Always 200 with
// `suggestions` (empty on any Google-side failure), same as Explore's route.
import "server-only";
import { consumeAnonRateLimit, consumeGlobalRateLimit, anonRateLimitedResponse } from "@/lib/rate-limit";
import { cachedJson, CACHE_SHORT } from "@/lib/http/cache";
import { CITY } from "@/lib/city";
import { autocompletePlaces, GooglePlacesAutocompleteError, type AutocompleteSuggestion } from "@/lib/places/autocomplete";

export const runtime = "nodejs";

const PER_IP_LIMIT = { limit: 60, windowSeconds: 60 * 60 };
const GLOBAL_DAILY_LIMIT = { limit: 2000, windowSeconds: 24 * 60 * 60 };
const MAX_QUERY_CHARS = 100;

interface TipPlacesResponse {
  suggestions: AutocompleteSuggestion[];
  degraded?: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_CHARS);
  const session = (searchParams.get("session") ?? "").trim().slice(0, 100);
  if (q.length < 3) return cachedJson<TipPlacesResponse>({ suggestions: [] }, CACHE_SHORT);

  const perIp = await consumeAnonRateLimit(request, "tips:places", PER_IP_LIMIT);
  if (!perIp.allowed) return anonRateLimitedResponse("Too many lookups. Just type the place instead.", PER_IP_LIMIT.windowSeconds);
  const global = await consumeGlobalRateLimit("tips:places:day", GLOBAL_DAILY_LIMIT);
  if (!global.allowed) return cachedJson<TipPlacesResponse>({ suggestions: [], degraded: "daily-cap" }, CACHE_SHORT);

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return cachedJson<TipPlacesResponse>({ suggestions: [], degraded: "no-google-key" }, CACHE_SHORT);
  }
  try {
    const suggestions = await autocompletePlaces({ input: q, sessionToken: session, center: CITY.center });
    return cachedJson<TipPlacesResponse>({ suggestions }, CACHE_SHORT);
  } catch (err) {
    const detail = err instanceof GooglePlacesAutocompleteError ? err.message : String(err);
    console.error(`[api/tips/places] google autocomplete failed: ${detail}`);
    return cachedJson<TipPlacesResponse>({ suggestions: [], degraded: "places-error" }, CACHE_SHORT);
  }
}
