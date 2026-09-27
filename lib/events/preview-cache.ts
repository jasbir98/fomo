"use client";

/**
 * Client-side preview cache for provider-event cards (Skiddle/Ticketmaster,
 * the `events` table) → detail page navigation. Sibling of
 * lib/happenings/preview-cache.ts, same shape and same reasoning — see that
 * file's doc comment for the full rationale (browser testing found most
 * feed taps are actually provider events, not happenings, so this extends
 * the same instant-preview/prefetch treatment there).
 *
 * One difference from the happenings version: app/(shell)/event/[id]/page.tsx
 * has no `/api/events/[id]` JSON route to fetch — it reads the row directly
 * via `getEvent(db, id)` (lib/db/events.ts, a plain Supabase client call,
 * not `server-only`), same as every other lib/db/* read this app's client
 * components already do straight from the browser. So "prefetch" here means
 * kicking off that same `getEvent` call early, not an HTTP fetch — there's
 * no `/api/*` response, and therefore no Cache-Control decision to make for
 * this path (unlike GET /api/happenings/[id]).
 */

import type { EventItem } from "@/lib/types";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { getEvent } from "@/lib/db";

export interface EventPreview {
  title: string;
  imageUrl: string | null;
  /** "From £12" / "Free" — `formatEventPrice`'s own output, or null when it returned "". */
  priceLabel: string | null;
  /** "Today · 7:30 PM" — `formatEventWhen`'s own output. */
  whenLabel: string | null;
  venueName: string | null;
  city: string | null;
}

/** Builds an `EventPreview` from a real `EventItem` row plus whatever
 *  price/when labels the calling card already computed for its own display. */
export function eventToPreview(
  event: Pick<EventItem, "name" | "image_url" | "venue_name" | "city">,
  labels: { priceLabel?: string | null; whenLabel?: string | null } = {}
): EventPreview {
  return {
    title: event.name,
    imageUrl: event.image_url,
    priceLabel: labels.priceLabel || null,
    whenLabel: labels.whenLabel || null,
    venueName: event.venue_name,
    city: event.city,
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
    return JSON.parse(raw) as EventPreview;
  } catch {
    return null;
  }
}

/** Kicks off `getEvent` early (a card's pointerdown/touchstart) and stashes
 *  the promise so the detail page's own load can reuse it instead of
 *  issuing a second, redundant read. No-op if one's already in flight. */
export function prefetchEvent(id: string): void {
  if (fetchCache.has(id)) return;
  const promise = getEvent(supabaseBrowserAuth(), id);
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
