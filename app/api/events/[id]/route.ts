/**
 * GET /api/events/[id] — single provider-event lookup (Skiddle/Ticketmaster,
 * the `events` table), for the event detail page's client refresh and the
 * card pointerdown prefetch (lib/events/preview-cache.ts). The server-rendered
 * page (app/(shell)/event/[id]/page.tsx) reads the same row itself for its
 * first paint.
 *
 * A route, not a direct browser read, because the public `events` policy only
 * lets anon/authenticated see `status = 'active'` rows
 * (supabase/live_only_public_read.sql). A shared link or a Saved item for an
 * event that has since expired, been cancelled or been withdrawn must still
 * open, so the row is read with the service-role client (RLS bypassed) — for
 * this one query only. `server-only` keeps that client out of every bundle.
 *
 * Public, same as GET /api/happenings/[id]: shared links open signed out,
 * nothing here reads the caller's session, and proxy.ts lists the path in
 * PUBLIC_EVENT_DETAIL. The bare /api/events collection route does not exist.
 */
import "server-only";
import { captureServerException } from "@/lib/analytics/server-exception";
import { getEvent } from "@/lib/db/events";
import { cachedJson, CACHE_MEDIUM, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { EventItem } from "@/lib/types";

export const runtime = "nodejs";

/** `event` is `null` for an id with no row (any status); the detail page then shows its not-found state. */
export interface EventResponse {
  event: EventItem | null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const event = await getEvent(supabaseAdmin(), id);
    // CACHE_MEDIUM (browser-only `private`), never `public`/`s-maxage`: see
    // the long explanation in app/api/happenings/[id]/route.ts and
    // lib/http/cache.ts — proxy.ts force-merges the session cookie onto every
    // /api/* response, so a shared-cache copy could carry one visitor's
    // cookie to the next. The body never depends on the caller.
    return cachedJson<EventResponse>({ event }, CACHE_MEDIUM);
  } catch (err) {
    console.error("[api/events/:id] failed", err);
    await captureServerException(err, {
      path: new URL(request.url).pathname,
      method: request.method,
      headers: request.headers,
      route: "/api/events/[id]",
      handled: true,
    });
    // Never cache a transient failure, even browser-side.
    return cachedJson<EventResponse>({ event: null }, CACHE_PRIVATE_NO_STORE, { status: 500 });
  }
}
