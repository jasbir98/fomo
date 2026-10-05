/**
 * Coordinate resolution for happenings — shared by app/api/explore/route.ts
 * (map pins) and app/api/chat/route.ts (ChatItem lat/lng for the desktop
 * chat map). No `server-only` marker: nothing here is secret, but it takes a
 * Supabase client, so in practice it runs wherever one is available.
 */
import type { Db } from "@/lib/supabase/types";
import { listPlacesByIds } from "@/lib/db/places";
import type { Place } from "@/lib/types";
import type { Happening } from "@/lib/happenings/types";

/** A happening's own lat/lng wins; otherwise borrows its linked place's coordinates (`placesById`, batch-fetched once — mirrors app/api/feed/route.ts's `withPlaceImageFallback` pattern, just for coordinates instead of a photo). Null when neither resolves — that happening can't be pinned on a map at all. */
export function resolveHappeningCoords(
  h: Happening,
  placesById: Map<string, Place>
): { lat: number; lng: number } | null {
  if (h.lat != null && h.lng != null) return { lat: h.lat, lng: h.lng };
  if (h.place_id) {
    const p = placesById.get(h.place_id);
    if (p?.lat != null && p?.lng != null) return { lat: p.lat, lng: p.lng };
  }
  return null;
}

/**
 * Coordinate fallback for happenings with a `place_id` but no lat/lng of
 * their own — one batched lookup covering every such row (never a query per
 * row). Returns an empty map when none need it. Throws on a DB error; callers
 * decide whether that is fatal (both current callers log and carry on without
 * the fallback coordinates).
 */
export async function loadPlacesForHappenings(
  db: Db,
  happenings: Happening[],
  { alsoForMissingImage = false }: { alsoForMissingImage?: boolean } = {}
): Promise<Map<string, Place>> {
  const placeIdsNeeded = new Set<string>();
  for (const h of happenings) {
    if (!h.place_id) continue;
    // `alsoForMissingImage`: Ask Fomo's catalogue also borrows the venue's
    // photo for a happening without its own, same as the feed does.
    if (h.lat == null || h.lng == null || (alsoForMissingImage && !h.image_url)) placeIdsNeeded.add(h.place_id);
  }
  if (placeIdsNeeded.size === 0) return new Map();
  const resolved = await listPlacesByIds(db, Array.from(placeIdsNeeded));
  return new Map(resolved.map((p) => [p.id, p]));
}
