"use client";

/**
 * Client-side preview cache for provider-event cards (Skiddle/Ticketmaster,
 * the `events` table) → detail page navigation. Sibling of
 * lib/happenings/preview-cache.ts, same shape and same reasoning — see that
 * file's doc comment for the full rationale (browser testing found most
 * feed taps are actually provider events, not happenings, so this extends
 * the same instant-preview/prefetch treatment there).
 *
 * Like the happenings version, "prefetch" is an HTTP fetch of a JSON route,
 * GET /api/events/[id] (app/api/events/[id]/route.ts). That route reads with
 * the service role because the public `events` read is active-only, so an
 * ended event opened from a shared link or Saved can't be read straight from
 * the browser any more.
 */

import type { EventItem } from "@/lib/types";
import type { EventResponse } from "@/app/api/events/[id]/route";

export interface EventPreview {
  title: string;
  imageUrl: string | null;
  /** "From £12" / "Free" — `formatEventPrice`'s own output, or null when it returned "". */
  priceLabel: string | null;
  /** "Today · 7:30 PM" — `formatEventWhen`'s own output. */
  whenLabel: string | null;
  venueName: string | null;
  city: string | null;
  /** Event category slug, so the instant hero can show the right tile when there's no photo. Absent on previews cached by an older build. */
  category?: string | null;
}

/** Builds an `EventPreview` from a real `EventItem` row plus whatever
 *  price/when labels the calling card already computed for its own display. */
export function eventToPreview(
  event: Pick<EventItem, "name" | "image_url" | "venue_name" | "city"> & { place?: EventItem["place"]; category?: string | null },
  labels: { priceLabel?: string | null; whenLabel?: string | null } = {}
): EventPreview {
  return {
    title: event.name,
    // Own photo, else the linked venue's: the detail page's instant hero
    // matches the card the user just tapped.
    imageUrl: event.image_url || event.place?.image_url || null,
    priceLabel: labels.priceLabel || null,
    whenLabel: labels.whenLabel || null,
    venueName: event.venue_name,
    city: event.city,
    category: event.category ?? null,
  };
}

const SS_KEY_PREFIX = "fomo:event-preview:";

const previewCache = new Map<string, EventPreview>();
const fetchCache = new Map<string, Promise<EventItem | null>>();

/** Written by a card at click time. */
export function setEventPreview(id: string, preview: EventPreview): void {
  previewCache.set(id, preview);
  try {
    sessionStorage.setItem(SS_KEY_PREFIX + id, JSON.stringify(preview));
  } catch {
    // Storage unavailable/full — in-memory cache still covers the normal
    // same-tab card→detail navigation this exists for.
  }
}

/** Read by the detail page on mount — in-memory first, then sessionStorage
 *  (a full reload of the detail page itself, e.g. a shared link). */
export function getEventPreview(id: string): EventPreview | null {
  const mem = previewCache.get(id);
  if (mem) return mem;
  try {
    const raw = sessionStorage.getItem(SS_KEY_PREFIX + id);
    if (!raw) return null;
    // Memoised so repeat reads return the same object — the detail page
    // reads this through useSyncExternalStore, which needs a stable snapshot.
    const parsed = JSON.parse(raw) as EventPreview;
    previewCache.set(id, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** GET /api/events/[id]. Resolves to `null` for an id with no row; throws on a non-2xx or network failure. */
export async function fetchEvent(id: string): Promise<EventItem | null> {
  const res = await fetch(`/api/events/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`GET /api/events/${id} ${res.status}`);
  return ((await res.json()) as EventResponse).event;
}

/** Kicks off the event fetch early (a card's pointerdown/touchstart) and stashes
 *  the promise so the detail page's own load can reuse it instead of
 *  issuing a second, redundant request. No-op if one's already in flight. */
export function prefetchEvent(id: string): void {
  if (fetchCache.has(id)) return;
  const promise = fetchEvent(id);
  // A failed prefetch shouldn't wedge this id — let the detail page retry
  // from scratch instead of replaying the same rejection.
  promise.catch(() => fetchCache.delete(id));
  fetchCache.set(id, promise);
}

/** Consumed once by the detail page's own load. */
export function takePrefetchedEvent(id: string): Promise<EventItem | null> | undefined {
  const promise = fetchCache.get(id);
  fetchCache.delete(id);
  return promise;
}
