import type { Db } from "@/lib/supabase/types";
import type { Place, PlacePhoto } from "@/lib/types";

// Curated pipeline rows often have no top-level `image_url` (extraction won't
// invent one without a citation) but do have cited photos in `place_photos`.
// List views (Home/Map cards) only ever render `Place.image_url`, so every
// list query embeds `place_photos` and backfills `image_url` from the
// earliest-ordered photo — keeping list-view rendering untouched while
// fixing the "place has real photos in Supabase but the card is blank" gap.
export const PLACE_SELECT = "*, place_photos(url, display_order)";

/**
 * PostgREST `or=` filter that drops `source = 'event-venue'` rows (null source
 * kept). Those places are venue metadata minted from event listings
 * (scripts/sources/core/google-venues.mjs), not recommendations, so no list or
 * search may surface them; they still resolve by id (event venue links, detail
 * pages). Passed to `.or()`, which ANDs with any other filter on the query.
 */
export const EXCLUDE_EVENT_VENUES = "source.is.null,source.neq.event-venue";

type PlaceRow = Place & {
  place_photos?: { url: string; display_order: number }[] | null;
};

export function withThumbnail(row: PlaceRow): Place {
  const { place_photos, ...place } = row;
  if (!place.image_url && place_photos && place_photos.length > 0) {
    const [first] = [...place_photos].sort((a, b) => a.display_order - b.display_order);
    place.image_url = first.url;
  }
  return place;
}

/** List all places (shared catalog data, no user scoping — readable by anon and authenticated alike). */
export async function listPlaces(db: Db): Promise<Place[]> {
  const { data, error } = await db.from("places").select(PLACE_SELECT).or(EXCLUDE_EVENT_VENUES);
  if (error) throw error;
  return (data ?? []).map(withThumbnail);
}

/** Fetch a single place by id. Returns null if not found. */
export async function getPlace(db: Db, id: string): Promise<Place | null> {
  const { data, error } = await db.from("places").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/** List places, optionally filtered by category. */
export async function listPlacesByCategory(db: Db, category?: string): Promise<Place[]> {
  let query = db.from("places").select(PLACE_SELECT).or(EXCLUDE_EVENT_VENUES);
  if (category) query = query.eq("category", category);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(withThumbnail);
}

/**
 * A place's photos for its detail-page carousel, in display order. Empty
 * for most rows today (place_photos is only populated where the pipeline
 * found more than one citable image) — callers should fall back to the
 * place's own `image_url` when this returns [].
 */
export async function listPlacePhotos(db: Db, placeId: string): Promise<PlacePhoto[]> {
  const { data, error } = await db
    .from("place_photos")
    .select("*")
    .eq("place_id", placeId)
    .order("display_order", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Batch-fetch places by id, for resolving itinerary items' `place_id` back
 * into full rows (lat/lng, name, etc.) — e.g. the Map page's "My itinerary"
 * mode. Empty input short-circuits to avoid an unnecessary `.in()` call.
 */
export async function listPlacesByIds(db: Db, ids: string[]): Promise<Place[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from("places").select(PLACE_SELECT).in("id", ids);
  if (error) throw error;
  return (data ?? []).map(withThumbnail);
}

/**
 * Free-text search over cached places (name, with category/address as
 * secondary match fields), case-insensitive substring match. Used by
 * /api/places as the search-aware fallback when Google is unavailable —
 * `listPlaces()` alone ignores `q` entirely and returns every seed row.
 */
export async function searchPlacesByName(db: Db, q: string): Promise<Place[]> {
  const term = q.trim().replace(/[,()%]/g, "");
  if (!term) return [];
  const { data, error } = await db
    .from("places")
    .select(PLACE_SELECT)
    .or(EXCLUDE_EVENT_VENUES)
    .or(`name.ilike.%${term}%,category.ilike.%${term}%,address.ilike.%${term}%`);
  if (error) throw error;
  return (data ?? []).map(withThumbnail);
}

/**
 * Curated pipeline picks (any non-live-Google source — each pipeline batch
 * writes its own `source` string, e.g. "seed-japan-pipeline" for the Kanto
 * batch or "seed:jp-tokyo-2026-07-15" for the Tokyo batch, so this matches
 * everything except "google" rather than one hardcoded value) whose city,
 * prefecture, destination, or address matches `query` (case-insensitive,
 * substring). Used by /api/places to surface editorial picks for a trip
 * destination ahead of a live Google search.
 *
 * The `address` fallback is intentional: country-level destinations like
 * "Scotland" won't match any city/prefecture column, but Scottish places
 * have addresses ending with ", Scotland" so they surface correctly.
 */
export async function listPlacesByCity(db: Db, query: string): Promise<Place[]> {
  // Strip characters that are syntactically significant in PostgREST's
  // or=() filter grammar (comma separates conditions, parens nest them)
  // before interpolating untrusted input into the filter string.
  const q = query.trim().replace(/[,()]/g, "");
  if (!q) return [];
  const { data, error } = await db
    .from("places")
    .select(PLACE_SELECT)
    // Not the live Google cache, and not `event-venue` rows: those are
    // metadata minted from event listings (scripts/sources/core/google-venues.mjs),
    // not recommendations, so they must never show up as places to visit.
    .not("source", "in", "(google,event-venue)")
    .or(`city.ilike.%${q}%,prefecture.ilike.%${q}%,destination.ilike.%${q}%,address.ilike.%${q}%`);
  if (error) throw error;
  return (data ?? []).map(withThumbnail);
}
