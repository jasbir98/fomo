import { supabase } from "@/lib/supabase";
import type { EventItem } from "@/lib/types";
import { distanceKm, sortByDistance, type Coordinates } from "@/lib/geo";

export interface ListUpcomingEventsOpts {
  destination?: string;
  category?: string;
  from?: string; // ISO timestamp, defaults to now
  to?: string;
  limit?: number;
}

/**
 * List cached upcoming events, optionally filtered by destination/category/
 * date window. Destination match takes the first comma-segment of the
 * destination string (mirrors cityGuess() in lib/now/context.ts) before
 * stripping remaining punctuation — the stored `destination` column values
 * keep their commas (e.g. "Edinburgh, Edinburgh, Scotland, United Kingdom"),
 * so a substring match against the full string with commas merely removed
 * never matches the literal comma-separated value. PostgREST's `or=()`
 * filter grammar also breaks on raw commas/parens in interpolated input.
 */
export async function listUpcomingEvents(
  opts: ListUpcomingEventsOpts = {}
): Promise<EventItem[]> {
  const { destination, category, from, to, limit } = opts;

  let query = supabase
    .from("events")
    .select("*")
    .gte("starts_at", from ?? new Date().toISOString())
    .order("starts_at", { ascending: true });

  if (to) query = query.lte("starts_at", to);
  if (category) query = query.eq("category", category);

  if (destination) {
    const term = destination.split(",")[0]?.trim().replace(/[,()]/g, "") ?? "";
    if (term) {
      query = query.or(
        `destination.ilike.%${term}%,city.ilike.%${term}%,address.ilike.%${term}%`
      );
    }
  }

  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * "Nearby" events within `radiusKm` of `center`. No PostGIS / earthdistance
 * / nearby RPC exists in this repo — this is the minimum step up from a full
 * table fetch: a bounding-box pre-filter (cheap index range scan against
 * events_geo_idx) followed by a client-side haversine refine + sort using the
 * existing distanceKm()/sortByDistance() helpers (lib/geo.ts). Never a new
 * SQL function.
 */
export async function listEventsNearby(
  center: Coordinates,
  radiusKm: number,
  opts: Omit<ListUpcomingEventsOpts, "destination"> = {}
): Promise<EventItem[]> {
  const { category, from, to, limit } = opts;

  const dLat = radiusKm / 111;
  // Guard against center.lat === ±90 (cos → 0, division blows up); a polar
  // event search is not a real scenario for this app, so clamping is fine.
  const cosLat = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01);
  const dLng = radiusKm / (111 * cosLat);

  let query = supabase
    .from("events")
    .select("*")
    .gte("starts_at", from ?? new Date().toISOString())
    .gte("lat", center.lat - dLat)
    .lte("lat", center.lat + dLat)
    .gte("lng", center.lng - dLng)
    .lte("lng", center.lng + dLng);

  if (to) query = query.lte("starts_at", to);
  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  const withinRadius = rows.filter((row) => {
    if (row.lat == null || row.lng == null) return false;
    return distanceKm(center, { lat: row.lat, lng: row.lng }) <= radiusKm;
  });

  const sorted = sortByDistance(withinRadius, center, (row) =>
    row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null
  );

  return limit ? sorted.slice(0, limit) : sorted;
}

/** Fetch a single event by id. Returns null if not found. */
export async function getEvent(id: string): Promise<EventItem | null> {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Batch-fetch events by id, for resolving itinerary items' linkage back into
 * full rows — mirrors listPlacesByIds (lib/db/places.ts:75).
 */
export async function listEventsByIds(ids: string[]): Promise<EventItem[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from("events").select("*").in("id", ids);
  if (error) throw error;
  return data ?? [];
}
