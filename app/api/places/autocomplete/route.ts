// GET /api/places/autocomplete?q=<text>&session=<token>
//
// Google Places Autocomplete (New), biased to CITY.center and restricted to
// GB — backs Explore's search dropdown "Places" group. Always 200 (never a
// 4xx/5xx for a missing key or a Google-side failure) so the client can
// treat every response the same way and just render whatever `suggestions`
// came back; the actual Google status/message is logged server-side only —
// see the task brief's note on verifying the key separately via curl.
import "server-only";
import { cachedJson, CACHE_SHORT } from "@/lib/http/cache";
import { CITY } from "@/lib/city";
import { autocompletePlaces, GooglePlacesAutocompleteError, type AutocompleteSuggestion } from "@/lib/places/autocomplete";

export const runtime = "nodejs";

interface AutocompleteResponse {
  suggestions: AutocompleteSuggestion[];
  degraded?: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const session = searchParams.get("session")?.trim() ?? "";

  // Below Google's own useful-suggestion threshold — skip the round trip.
  if (q.length < 2) {
    return cachedJson<AutocompleteResponse>({ suggestions: [] }, CACHE_SHORT);
  }

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return cachedJson<AutocompleteResponse>({ suggestions: [], degraded: "no-google-key" }, CACHE_SHORT);
  }

  try {
    const suggestions = await autocompletePlaces({ input: q, sessionToken: session, center: CITY.center });
    return cachedJson<AutocompleteResponse>({ suggestions }, CACHE_SHORT);
  } catch (err) {
    const detail = err instanceof GooglePlacesAutocompleteError ? err.message : String(err);
    console.error(`[api/places/autocomplete] google autocomplete failed: ${detail}`);
    return cachedJson<AutocompleteResponse>({ suggestions: [], degraded: "places-error" }, CACHE_SHORT);
  }
}
