/**
 * One place plus what its detail page shows: photos, live offers linked to
 * it, and upcoming events there. Read by the server-rendered place page
 * (first paint, metadata and structured data); the client component
 * (components/detail/PlaceDetail.tsx) refreshes the same pieces itself.
 */
import "server-only";
import { listUpcomingEventsForPlace } from "@/lib/db/events";
import { listHappeningsForPlace } from "@/lib/db/happenings";
import { getPlace, listPlacePhotos } from "@/lib/db/places";
import { happeningHasEnded } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import type { Db } from "@/lib/supabase/types";
import type { EventItem, Place, PlacePhoto } from "@/lib/types";

export interface PlaceDetailData {
  place: Place | null;
  photos: PlacePhoto[];
  offers: Happening[];
  events: EventItem[];
}

/** Best-effort extras: a failed read leaves that section empty rather than failing the page. */
async function orEmpty<T>(what: string, read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (err) {
    console.error(`[place detail] ${what} lookup failed`, err);
    return [];
  }
}

/** Throws only if the place lookup itself fails; a missing row is `{ place: null }`. */
export async function loadPlaceDetail(db: Db, id: string, now: Date = new Date()): Promise<PlaceDetailData> {
  const [place, photos, offers, events] = await Promise.all([
    getPlace(db, id),
    orEmpty("photos", listPlacePhotos(db, id)),
    orEmpty("offers", listHappeningsForPlace(db, id)),
    orEmpty("events", listUpcomingEventsForPlace(db, id, now)),
  ]);
  if (!place) return { place: null, photos: [], offers: [], events: [] };
  return { place, photos, offers: offers.filter((h) => !happeningHasEnded(h, now)), events };
}
