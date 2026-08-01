import { supabase } from "@/lib/supabase";
import type { Place, PlacePhoto } from "@/lib/types";

// Curated pipeline rows often have no top-level `image_url` (extraction won't
// invent one without a citation) but do have cited photos in `place_photos`.
// List views (Home/Map cards) only ever render `Place.image_url`, so every
// list query embeds `place_photos` and backfills `image_url` from the
// earliest-ordered photo — keeping list-view rendering untouched while
// fixing the "place has real photos in Supabase but the card is blank" gap.
const PLACE_SELECT = "*, place_photos(url, display_order)";

type PlaceRow = Place & {
  place_photos?: { url: string; display_order: number }[] | null;
};

function withThumbnail(row: PlaceRow): Place {
  const { place_photos, ...place } = row;
  if (!place.image_url && place_photos && place_photos.length > 0) {
    const [first] = [...place_photos].sort((a, b) => a.display_order - b.display_order);
    place.image_url = first.url;
  }
  return place;
}

/** List all places (shared seed data, no device scoping). */
export async function listPlaces(): Promise<Place[]> {
  const { data, error } = await supabase.from("places").select(PLACE_SELECT);
  if (error) throw error;
  return (data ?? []).map(withThumbnail);
}

/** Fetch a single place by id. Returns null if not found. */
export async function getPlace(id: string): Promise<Place | null> {
  const { data, error } = await supabase
    .from("places")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** List places, optionally filtered by category. */
export async function listPlacesByCategory(
  category?: string
): Promise<Place[]> {
  let query = supabase.from("places").select(PLACE_SELECT);
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
export async function listPlacePhotos(placeId: string): Promise<PlacePhoto[]> {
  const { data, error } = await supabase
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
export async function listPlacesByIds(ids: string[]): Promise<Place[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("places")
    .select(PLACE_SELECT)
    .in("id", ids);
  if (error) throw error;
  return (data ?? []).map(withThumbnail);
}

/**
 * Free-text search over cached places (name, with category/address as
 * secondary match fields), case-insensitive substring match. Used by
 * /api/places as the search-aware fallback when Google is unavailable —
 * `listPlaces()` alone ignores `q` entirely and returns every seed row.
 */
export async function searchPlacesByName(q: string): Promise<Place[]> {
  const term = q.trim().replace(/[,()%]/g, "");
  if (!term) return [];
  const { data, error } = await supabase
    .from("places")
    .select(PLACE_SELECT)
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
export async function listPlacesByCity(query: string): Promise<Place[]> {
  // Strip characters that are syntactically significant in PostgREST's
  // or=() filter grammar (comma separates conditions, parens nest them)
  // before interpolating untrusted input into the filter string.
  const q = query.trim().replace(/[,()]/g, "");
  if (!q) return [];
  const { data, error } = await supabase
    .from("places")
    .select(PLACE_SELECT)
    .neq("source", "google")
    .or(`city.ilike.%${q}%,prefecture.ilike.%${q}%,destination.ilike.%${q}%,address.ilike.%${q}%`);
  if (error) throw error;
  return (data ?? []).map(withThumbnail);
}
