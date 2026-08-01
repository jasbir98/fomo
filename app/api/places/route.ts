/**
 * Roameo Places — real POI data for the map (server-only).
 *
 * GET /api/places?destination=<string>&category=<slug>&q=<text>&limit=<n>
 *   category: food | photo | lockers | transport  (omit for a general mix)
 *   q:        free-text search (e.g. a place name); when present it drives
 *             the Google Text Search query instead of category+destination
 *   limit:    default 12, max 20
 *
 * Pipeline: Mapbox-geocode the destination → Google Places (New) Text Search
 * (minimal field mask) → upsert into the `places` table (dedupe on
 * google_place_id) → return the cached rows (with real Supabase ids) plus the
 * map center. Always responds 200 with a usable body; degrades to the seeded
 * rows when a key is missing or Google errors, and to synthetic rows when the
 * cache migration hasn't been run yet. The Google key never leaves the server.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  listPlaces,
  listPlacesByCategory,
  listPlacesByCity,
  searchPlacesByName,
} from "@/lib/db/places";
import type { Place } from "@/lib/types";
import { geocodeDestination, type Center } from "@/lib/places/geocode";
import {
  searchPlaces,
  normalizeCategory,
  GooglePlacesError,
  type MappedPlace,
} from "@/lib/places/google";

export const runtime = "nodejs";

interface PlacesResponse {
  center: Center | null;
  places: Place[];
  degraded?: string;
}

/** Build a full Place from a live-mapped result (fallback when the DB cache is unavailable). */
function syntheticPlace(m: MappedPlace): Place {
  return {
    id: m.google_place_id,
    name: m.name,
    category: m.category,
    rating: m.rating,
    image_url: m.image_url,
    distance_label: null,
    tips: [],
    reviews: [],
    hours: null,
    station: null,
    badges: [],
    google_place_id: m.google_place_id,
    lat: m.lat,
    lng: m.lng,
    address: m.address,
    price_level: m.price_level,
    destination: m.destination,
    source: m.source,
    fetched_at: m.fetched_at,
    city: null,
    prefecture: null,
    country: m.country,
    description: null,
    last_verified_at: null,
    hours_status: null,
    opening_hours: null,
    mention_count: 0,
    mention_sources: null,
    detail_line: null,
    image_quality: null,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const destination = searchParams.get("destination")?.trim();
  if (!destination) {
    return NextResponse.json(
      { error: "missing required 'destination' query param" },
      { status: 400 }
    );
  }

  const category = normalizeCategory(searchParams.get("category"));
  const q = searchParams.get("q")?.trim() || undefined;
  // searchParams.get("limit") is null when the param is absent, and
  // Number(null) is 0 (not NaN) — Number.isFinite(0) is true, so without this
  // explicit null check the "no limit given" case was silently clamped to
  // Math.max(0, 1) = 1 instead of falling through to the intended default of
  // 12. The Map page never sends `limit`, so every category-chip/free-text
  // live Google search has been silently capped to a single result.
  const rawLimitParam = searchParams.get("limit");
  const rawLimit = rawLimitParam == null ? NaN : Number(rawLimitParam);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20)
    : 12;

  // 1. Geocode → map center (null-safe; text search still works without it).
  const center = await geocodeDestination(destination);

  // 1b. Default view (no category/search active) — prefer curated Japan
  // pipeline picks over a live Google call when the destination's city or
  // prefecture matches one we've promoted from places_staging. Category
  // filters and free-text search always fall through to live Google below.
  if (!category && !q) {
    const cityGuess = destination.split(",")[0]?.trim();
    if (cityGuess) {
      try {
        const curated = await listPlacesByCity(cityGuess);
        if (curated.length > 0) {
          return NextResponse.json<PlacesResponse>({ center, places: curated });
        }
      } catch (err) {
        console.error("[api/places] curated lookup failed, falling through to live search", err);
      }
    }
  }

  // 2. No Google key → degrade to seeded rows so the map still shows something.
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return NextResponse.json<PlacesResponse>({
      center,
      places: await safeSeedPlaces(category, q),
      degraded: "no-google-key",
    });
  }

  // 3. Fetch live POIs.
  let mapped: MappedPlace[];
  try {
    mapped = await searchPlaces({ destination, category, limit, center, q });
  } catch (err) {
    const reason =
      err instanceof GooglePlacesError ? "places-error" : "places-error";
    console.error(`[api/places] google places search failed (${reason})`, err);
    return NextResponse.json<PlacesResponse>({
      center,
      places: await safeSeedPlaces(category, q),
      degraded: reason,
    });
  }

  if (mapped.length === 0) {
    return NextResponse.json<PlacesResponse>({ center, places: [] });
  }

  // 4. Cache into `places` (dedupe on google_place_id) and return rows with ids.
  //
  // Split into two upsert batches by whether we resolved a photo. A place
  // re-discovered by a later search (e.g. a curated place that also matches
  // a live Google query) must not have its `image_url` column clobbered back
  // to null just because this particular Google response carried no photo —
  // supabase-js's upsert() writes every key present in the row object on
  // conflict, so `image_url` has to be *omitted* (not just falsy) for rows
  // where we have nothing new to write, letting the existing cached value
  // (curated or from a prior search) survive untouched.
  const rowsWithPhoto = mapped.filter((m) => m.image_url != null);
  const rowsWithoutPhoto = mapped
    .filter((m) => m.image_url == null)
    .map(({ image_url: _image_url, ...rest }) => rest);

  const results = await Promise.all([
    rowsWithPhoto.length > 0
      ? supabase.from("places").upsert(rowsWithPhoto, { onConflict: "google_place_id" }).select("*")
      : Promise.resolve({ data: [] as Place[], error: null }),
    rowsWithoutPhoto.length > 0
      ? supabase.from("places").upsert(rowsWithoutPhoto, { onConflict: "google_place_id" }).select("*")
      : Promise.resolve({ data: [] as Place[], error: null }),
  ]);

  const error = results[0].error ?? results[1].error;
  const data = error ? null : [...(results[0].data ?? []), ...(results[1].data ?? [])];

  if (error || !data) {
    // Migration not run yet (missing column / unique index) — still render the
    // live results; detail-page nav may not resolve until the cache exists.
    // Interpolate into a single string: PostgrestError doesn't always survive
    // console.error's default object formatting (some loggers render it as
    // `{}` because JSON.stringify drops undefined-valued keys).
    const rows: unknown = data; // narrowed to null in this branch; widen for logging
    console.error(
      `[api/places] places cache upsert failed (run supabase/add_places_columns.sql) ` +
        `code=${error?.code ?? "<none>"} message=${error?.message ?? "<none>"} ` +
        `details=${error?.details ?? "<none>"} hint=${error?.hint ?? "<none>"} ` +
        `dataIsNull=${rows === null} dataLength=${Array.isArray(rows) ? rows.length : "n/a"}`
    );
    return NextResponse.json<PlacesResponse>({
      center,
      places: mapped.map(syntheticPlace),
      degraded: "cache-unavailable",
    });
  }

  return NextResponse.json<PlacesResponse>({ center, places: data as Place[] });
}

/**
 * Seed rows, guarded so a Supabase misconfig can't 500 the map. Prefers a
 * real filtered query over the unfiltered `listPlaces()` when the caller has
 * a `q` (free-text search — degrades to an `ilike` search on cached rows
 * instead of returning every seed place) or `category` filter active.
 */
async function safeSeedPlaces(
  category?: string,
  q?: string
): Promise<Place[]> {
  try {
    if (q) return await searchPlacesByName(q);
    if (category) return await listPlacesByCategory(category);
    return await listPlaces();
  } catch (err) {
    console.error("[api/places] seed fallback failed", err);
    return [];
  }
}
