import type { Db } from "@/lib/supabase/types";
import type { EventItem } from "@/lib/types";
import { distanceKm, sortByDistance, type Coordinates } from "@/lib/geo";
import { eventIsLive, DEFAULT_EVENT_DURATION_MS } from "@/lib/events/format";

/**
 * The query-layer half of "is this event still running as of `at`" — kept
 * consistent with `eventEffectiveEndMs`'s own definition (an `ends_at` when
 * the row has one, else `starts_at` + `DEFAULT_EVENT_DURATION_MS`) by
 * importing that same constant rather than re-deriving it: either `ends_at`
 * hasn't passed yet, or there's no `ends_at` at all and `starts_at` is
 * recent enough that the default duration hasn't elapsed.
 *
 * Replaces the old fixed 24h "lookback" window (`.gte("starts_at", from -
 * 24h)`), which silently dropped any event whose `starts_at` was more than a
 * day in the past even when it was still genuinely running — a multi-day
 * festival or exhibition never reached the JS `eventIsLive` filter below at
 * all, because the DB-level filter excluded the row first. This filter is a
 * superset of nothing: every row it returns is already live, so `limit`
 * needs no extra padding for rows that will just be filtered back out.
 */
function stillRunningFilter(at: Date): string {
  const nowIso = at.toISOString();
  const defaultDurationCutoff = new Date(at.getTime() - DEFAULT_EVENT_DURATION_MS).toISOString();
  return `ends_at.gte.${nowIso},and(ends_at.is.null,starts_at.gte.${defaultDurationCutoff})`;
}

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
  db: Db,
  opts: ListUpcomingEventsOpts = {}
): Promise<EventItem[]> {
  const { destination, category, from, to, limit } = opts;

  const fromDate = from ? new Date(from) : new Date();

  let query = db
    .from("events")
    .select("*")
    .or(stillRunningFilter(fromDate))
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
  // Final in-memory guard, belt-and-braces: re-checks each row against its
  // own actual effective end (`eventEffectiveEndMs`), not just the SQL
  // approximation above — catches a clock-skew edge case or any future
  // query change that loosens the DB-level filter. Every list route reading
  // this function (feed/now/explore/discover/chat) inherits this guard for
  // free rather than re-implementing it per caller.
  const live = (data ?? []).filter((row) => eventIsLive(row, fromDate));
  return limit ? live.slice(0, limit) : live;
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
  db: Db,
  center: Coordinates,
  radiusKm: number,
  opts: Omit<ListUpcomingEventsOpts, "destination"> = {}
): Promise<EventItem[]> {
  const { category, from, to, limit } = opts;

  const fromDate = from ? new Date(from) : new Date();

  const dLat = radiusKm / 111;
  // Guard against center.lat === ±90 (cos → 0, division blows up); a polar
  // event search is not a real scenario for this app, so clamping is fine.
  const cosLat = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01);
  const dLng = radiusKm / (111 * cosLat);

  let query = db
    .from("events")
    .select("*")
    .or(stillRunningFilter(fromDate))
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
    if (!eventIsLive(row, fromDate)) return false;
    return distanceKm(center, { lat: row.lat, lng: row.lng }) <= radiusKm;
  });

  const sorted = sortByDistance(withinRadius, center, (row) =>
    row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null
  );

  return limit ? sorted.slice(0, limit) : sorted;
}

/** Fetch a single event by id. Returns null if not found. */
export async function getEvent(db: Db, id: string): Promise<EventItem | null> {
  const { data, error } = await db.from("events").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Batch-fetch events by id, for resolving itinerary items' linkage back into
 * full rows — mirrors listPlacesByIds (lib/db/places.ts).
 */
export async function listEventsByIds(db: Db, ids: string[]): Promise<EventItem[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from("events").select("*").in("id", ids);
  if (error) throw error;
  return data ?? [];
}
