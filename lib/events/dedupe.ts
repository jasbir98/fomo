// Cross-provider event dedupe. The same gig can be listed on both Skiddle
// and Ticketmaster — this collapses those into one row before the /api/events
// route upserts into `events`. Sits alongside the analogous ordering helpers
// in lib/social/order.ts (that file groups reels by place; this groups events
// by identity).
import "server-only";
import type { MappedEvent } from "./skiddle";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Stable identity key for "is this the same real-world event". Keys on the
 * slugified name + the calendar date (not full timestamp — providers
 * sometimes disagree on exact showtime by a few minutes) + lat/lng rounded to
 * 3 decimal places (~110 m), which is coarse enough to survive small
 * geocoding differences between providers while still separating distinct
 * venues.
 */
function eventKey(event: MappedEvent): string {
  const day = event.starts_at.slice(0, 10);
  const lat = event.lat != null ? event.lat.toFixed(3) : "?";
  const lng = event.lng != null ? event.lng.toFixed(3) : "?";
  return `${slugify(event.name)}|${day}|${lat},${lng}`;
}

/** Prefer Ticketmaster on a tie (its ticket_url is more consistently useful). */
const PROVIDER_TIE_BREAK_RANK: Record<string, number> = {
  ticketmaster: 0,
  skiddle: 1,
};

/**
 * Collapse duplicate events (same gig listed by more than one provider) into
 * one row per identity key. Keeps whichever candidate has an `image_url`;
 * among candidates that are equally (un)photographed, prefers Ticketmaster
 * first (better ticket links), then keeps input order as a stable tie-break.
 */
export function dedupeEvents(events: MappedEvent[]): MappedEvent[] {
  const best = new Map<string, MappedEvent>();

  for (const event of events) {
    const key = eventKey(event);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, event);
      continue;
    }

    const existingHasImage = existing.image_url != null;
    const candidateHasImage = event.image_url != null;
    if (candidateHasImage && !existingHasImage) {
      best.set(key, event);
      continue;
    }
    if (candidateHasImage === existingHasImage) {
      const existingRank = PROVIDER_TIE_BREAK_RANK[existing.provider] ?? 99;
      const candidateRank = PROVIDER_TIE_BREAK_RANK[event.provider] ?? 99;
      if (candidateRank < existingRank) best.set(key, event);
    }
    // else: existing already has an image and candidate doesn't — keep existing.
  }

  return Array.from(best.values());
}
