/**
 * GET /api/feed?window=now|coming_up|book_early&range=all|month&price=all|cheap&at=<ISO, optional>
 *
 * Thin wrapper: the response and its sections are documented in, and built
 * by, lib/happenings/build-feed.ts (also used to server-render the first
 * paint of Home, Deals, Free and This weekend).
 *
 * Public: signed-out visitors browse the feed too (user decision
 * 2026-09-15). Every table read is `read_all` to anon under RLS, so a
 * cookie-less request simply runs as the anon role.
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { buildFeed, parsePrice, parseRange, parseWindow } from "@/lib/happenings/build-feed";
import { parseWhoGroups } from "@/lib/happenings/groups";
import type { FeedResponse } from "@/lib/happenings/feed-types";
import { isUnauthorizedError } from "@/lib/supabase-error";
import { captureServerException } from "@/lib/analytics/server-exception";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const db = await supabaseServer();
  // Signed-in visitors get the hero ranked for their deals profile; the rest
  // of the response is the same for everyone.
  // Started now, awaited only where the hero needs it — it's a network call
  // to Supabase Auth when a session cookie is present, so it overlaps the
  // catalogue reads instead of running before them. Never rejects: a failed
  // lookup just means the generic (signed-out) hero ranking.
  const who = db.auth
    .getUser()
    .then(({ data: { user } }) => parseWhoGroups(user?.user_metadata))
    .catch(() => parseWhoGroups(undefined));

  const { searchParams } = new URL(request.url);
  const atParam = searchParams.get("at");

  try {
    const feed = await buildFeed(db, {
      window: parseWindow(searchParams.get("window")),
      range: parseRange(searchParams.get("range")),
      price: parsePrice(searchParams.get("price")),
      now: atParam && !Number.isNaN(Date.parse(atParam)) ? new Date(atParam) : new Date(),
      who,
    });
    return cachedJson<FeedResponse>(feed, CACHE_PRIVATE_NO_STORE);
  } catch (err) {
    console.error("[api/feed] failed", err);
    // A non-2xx status (rather than a 200 with empty sections) is the signal
    // every client page now checks (`res.ok`) to tell "the feed request
    // actually failed" apart from "the feed is genuinely empty" — a 200 here
    // used to render as "Nothing lined up... try another tab" on every page
    // reading this route, which reads as no content rather than a failure.
    // Unauthorized still gets its own distinct status (401) rather than the
    // generic 500 below, since that's a real "sign in again" case, not a
    // transient failure a Retry button should paper over.
    const unauthorized = isUnauthorizedError(err);
    if (!unauthorized) {
      await captureServerException(err, {
        path: new URL(request.url).pathname,
        method: request.method,
        headers: request.headers,
        route: "/api/feed",
        handled: true,
      });
    }
    return cachedJson<FeedResponse>(
      {
        hero: null,
        whatsOn: [],
        anyDay: null,
        bookEarly: [],
        deals: { venueGroups: [], singles: [] },
        freeAnyTime: [],
        degraded: unauthorized ? "unauthorized" : undefined,
      },
      CACHE_PRIVATE_NO_STORE,
      { status: unauthorized ? 401 : 500 }
    );
  }
}
