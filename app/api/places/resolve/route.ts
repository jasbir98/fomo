// GET /api/places/resolve?placeId=<id>&session=<token>
//
// Resolves an Explore search-dropdown pick (either an "On Fomo" pin's own id
// or a Google Places `placeId`) into something the map can fly to. Looks up
// our own `places` row by `google_place_id` first — Fomo's curated pipeline
// and cached live-Google places both carry that column (see
// lib/places/google.ts / app/api/places/route.ts's upsert) — and only falls
// through to a live Google Place Details call when nothing's cached. Always
// 200: a Google-side failure comes back as `{ source: "error" }` rather than
// a 4xx/5xx, so the client can render "couldn't load that place" instead of
// a thrown fetch error.
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import type { Db } from "@/lib/supabase/types";
import { cachedJson, CACHE_SHORT } from "@/lib/http/cache";
import { resolvePlaceDetails, GooglePlacesAutocompleteError } from "@/lib/places/autocomplete";

export const runtime = "nodejs";

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
