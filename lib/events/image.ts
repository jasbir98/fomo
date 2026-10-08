/**
 * Which picture an event card or detail page shows, cheapest and most specific
 * first:
 *   1. the event's own image;
 *   2. its linked venue's photo (`place`, joined in lib/db/events.ts);
 *   3. a bundled themed / category tile (`defaultImageFor`).
 * Pure and client-safe (no `server-only`), so cards, the detail page and API
 * routes share one chain instead of each re-deriving it.
 */
import { CATEGORY_STYLE, defaultImageFor } from "@/lib/happenings/category-style";
import type { HappeningCategory } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";

/** Event categories (lib/events/categories.ts) are a subset of happening categories, so every one maps to a real tile; anything unexpected returns undefined (-> the neutral "other" tile). */
export function eventCategoryToHappening(category: string | null | undefined): HappeningCategory | undefined {
  if (!category) return undefined;
  const slug = category.toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(CATEGORY_STYLE, slug) ? (slug as HappeningCategory) : undefined;
}

/** The bundled tile for an event: keyword theme on title + venue, else its category's tile. */
export function eventDefaultImage(event: Pick<EventItem, "name" | "venue_name" | "category">): string {
  return defaultImageFor({
    category: eventCategoryToHappening(event.category),
    title: event.name,
    venue_name: event.venue_name,
  });
}

/** Event image -> linked venue's photo -> category tile. Never null. */
export function eventImageFor(event: Pick<EventItem, "name" | "venue_name" | "category" | "image_url" | "place">): string {
  return event.image_url || event.place?.image_url || eventDefaultImage(event);
}

/** Like eventImageFor but null when the event has no real photo of its own or its venue's (the caller supplies its own placeholder). */
export function eventRealImage(event: Pick<EventItem, "image_url" | "place">): string | null {
  return event.image_url || event.place?.image_url || null;
}
