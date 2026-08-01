/**
 * Roameo Geocode — destination autocomplete for the create-trip flow.
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
import { NextResponse } from "next/server";
import { geocodeSuggestions, type PlaceSuggestion } from "@/lib/places/geocode";

export const runtime = "nodejs";

interface GeocodeResponse {
  suggestions: PlaceSuggestion[];
}

export async function GET(req: Request): Promise<NextResponse<GeocodeResponse>> {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const suggestions = await geocodeSuggestions(q);
  return NextResponse.json({ suggestions });
}
