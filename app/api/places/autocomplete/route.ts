// GET /api/places/autocomplete?q=<text>&session=<token>
//
// Google Places Autocomplete (New), biased to CITY.center and restricted to
// GB — backs Explore's search dropdown "Places" group. Always 200 for a
// Google-side failure (never a 4xx/5xx for a missing key or a Google-side
// failure) so the client can treat every response the same way and just
// render whatever `suggestions` came back; the actual Google status/message
// is logged server-side only — see the task brief's note on verifying the
// key separately via curl.
//
// Session + rate limit: this route isn't in proxy.ts's `PUBLIC_API_PREFIXES`
// (it's a paid-per-call Google API, unlike the read-only catalogue routes
// that list is for), so proxy.ts's default "/api/* needs a session" rule
// already 401s an unauthenticated call before it ever reaches this handler.
// The check below is belt-and-braces, matching every other route in this
// app (see app/api/chat/route.ts) — safe even if that proxy config ever
// changes. Rate limited via lib/rate-limit.ts's per-user
// `consumeRateLimit`, same burst+daily pattern as app/api/chat/route.ts,
// fail-open by default (that module's documented default) since a missing
// migration shouldn't take autocomplete down entirely.
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { consumeRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { cachedJson, CACHE_SHORT } from "@/lib/http/cache";
import { CITY } from "@/lib/city";
import { autocompletePlaces, GooglePlacesAutocompleteError, type AutocompleteSuggestion } from "@/lib/places/autocomplete";

export const runtime = "nodejs";

const AUTOCOMPLETE_RATE_LIMIT_BURST = { limit: 60, windowSeconds: 60 };
const AUTOCOMPLETE_RATE_LIMIT_DAILY = { limit: 600, windowSeconds: 24 * 60 * 60 };

interface AutocompleteResponse {
  suggestions: AutocompleteSuggestion[];
  degraded?: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const session = searchParams.get("session")?.trim() ?? "";

  // Below Google's own useful-suggestion threshold — skip the round trip
  // (and the auth/rate-limit checks below, since this never costs anything).
  if (q.length < 2) {
    return cachedJson<AutocompleteResponse>({ suggestions: [] }, CACHE_SHORT);
  }

  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const burst = await consumeRateLimit(db, "places:autocomplete:burst", AUTOCOMPLETE_RATE_LIMIT_BURST);
  if (!burst.allowed) return rateLimitedResponse(burst);
  const daily = await consumeRateLimit(db, "places:autocomplete:day", AUTOCOMPLETE_RATE_LIMIT_DAILY);
  if (!daily.allowed) return rateLimitedResponse(daily);

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
