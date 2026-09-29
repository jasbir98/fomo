// GET /api/places/resolve?placeId=<id>&session=<token>
//
// Resolves an Explore search-dropdown pick (either an "On Fomo" pin's own id
// or a Google Places `placeId`) into something the map can fly to. Looks up
// our own `places` row by `google_place_id` first — Fomo's curated pipeline
// and cached live-Google places both carry that column (see
// lib/places/google.ts / app/api/places/route.ts's upsert) — and only falls
// through to a live Google Place Details call when nothing's cached. Always
// 200 for a Google-side failure: it comes back as `{ source: "error" }`
// rather than a 4xx/5xx, so the client can render "couldn't load that
// place" instead of a thrown fetch error.
//
// Session + rate limit: this route isn't in proxy.ts's `PUBLIC_API_PREFIXES`
// (it can trigger a paid Google Place Details call, unlike the read-only
// catalogue routes that list is for), so proxy.ts's default "/api/* needs a
// session" rule already 401s an unauthenticated call before it ever reaches
// this handler. The check below is belt-and-braces, matching every other
// route in this app (see app/api/chat/route.ts) — safe even if that proxy
// config ever changes. Rate limited via lib/rate-limit.ts's per-user
// `consumeRateLimit`, same burst+daily pattern as app/api/chat/route.ts,
// fail-open by default (that module's documented default) since a missing
// migration shouldn't take resolve down entirely.
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { consumeRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import type { Db } from "@/lib/supabase/types";
import { cachedJson, CACHE_SHORT } from "@/lib/http/cache";
import { resolvePlaceDetails, GooglePlacesAutocompleteError } from "@/lib/places/autocomplete";

export const runtime = "nodejs";

const RESOLVE_RATE_LIMIT_BURST = { limit: 30, windowSeconds: 60 };
const RESOLVE_RATE_LIMIT_DAILY = { limit: 300, windowSeconds: 24 * 60 * 60 };

type ResolveResponse =
  | { source: "fomo"; placeId: string; name: string | null; lat: number | null; lng: number | null }
  | { source: "google"; name: string | null; address: string | null; lat: number | null; lng: number | null }
  | { source: "error"; message: string };

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const placeId = searchParams.get("placeId")?.trim();
  const session = searchParams.get("session")?.trim() || undefined;

  if (!placeId) {
    return NextResponse.json({ source: "error", message: "missing required 'placeId' query param" }, { status: 400 });
  }

  // Typed as `Db` (the loose alias, not the stub-schema `Database` generic
  // `supabaseServer()` itself returns) so `.from("places")` isn't narrowed to
  // `never` — same reasoning as lib/supabase/types.ts's own doc comment.
  const db: Db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const burst = await consumeRateLimit(db, "places:resolve:burst", RESOLVE_RATE_LIMIT_BURST);
  if (!burst.allowed) return rateLimitedResponse(burst);
  const daily = await consumeRateLimit(db, "places:resolve:day", RESOLVE_RATE_LIMIT_DAILY);
  if (!daily.allowed) return rateLimitedResponse(daily);

  const { data: existing, error } = await db
    .from("places")
    .select("id, name, lat, lng")
    .eq("google_place_id", placeId)
    .maybeSingle();

  if (error) {
    // Not fatal — fall through to live Google below rather than failing the
    // whole lookup over a catalog read hiccup.
    console.error("[api/places/resolve] fomo lookup failed", error);
  } else if (existing) {
    return cachedJson<ResolveResponse>(
      { source: "fomo", placeId: existing.id, name: existing.name, lat: existing.lat, lng: existing.lng },
      CACHE_SHORT
    );
  }

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return cachedJson<ResolveResponse>({ source: "error", message: "no-google-key" }, CACHE_SHORT);
  }

  try {
    const resolved = await resolvePlaceDetails({ placeId, sessionToken: session });
    return cachedJson<ResolveResponse>({ source: "google", ...resolved }, CACHE_SHORT);
  } catch (err) {
    const detail = err instanceof GooglePlacesAutocompleteError ? err.message : String(err);
    console.error(`[api/places/resolve] google details failed: ${detail}`);
    return cachedJson<ResolveResponse>({ source: "error", message: "places-error" }, CACHE_SHORT);
  }
}
