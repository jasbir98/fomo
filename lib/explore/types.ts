/**
 * Fomo Explore — shared pin contract for GET /api/explore.
 *
 * Client-safe (no `server-only`): the route handler AND the Explore page (a
 * client component) both need this, same pattern as lib/happenings/types.ts.
 *
 * Deliberately a small, flat shape rather than the full `Place`/`Happening`/
 * `EventItem` row it was built from — Explore only ever needs enough to draw
 * a pin, render a results-list card, and open a BottomSheet with a CTA to the
 * subject's own detail page. Pulling three big payloads (places + happenings
 * + events) into the client just to get lat/lng and a title is the thing
 * this route exists to avoid — see the task brief's own contract note.
 */

/** Which map layer a pin belongs to. "everything" is a request-time filter
 *  value only (GET /api/explore?layer=everything) — it never appears as a
 *  pin's own `type`, which is always one of the other four. */
export type ExploreLayer = "everything" | "places" | "deals" | "events" | "free";

export type ExplorePinType = "place" | "deal" | "event" | "free";

export interface ExplorePin {
  id: string;
  type: ExplorePinType;
  title: string;
  lat: number;
  lng: number;
  image: string | null;
  /** Human category label ("Museum", "Food & drink") — the results list's type badge. */
  category: string | null;
  /** Deal/price/free badge ("20% off", "Free", "From £12") — null when there's nothing short to show. */
  badge: string | null;
  /** Where "View details" / tapping the card navigates: /place/[id], /happening/[id], or /event/[id]. */
  href: string;
  /** ISO timestamp for a dated deal/event, else null (standing deals, free-any-time places/happenings). */
  starts_at?: string | null;
}

export interface ExploreResponse {
  pins: ExplorePin[];
  degraded?: string;
}
