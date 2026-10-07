/**
 * GET /api/happenings/[id] — single happening lookup, for the happening
 * detail page (app/(shell)/happening/[id]/page.tsx), which also builds the
 * same data on the server for its first paint (lib/happenings/detail.ts).
 *
 * A route, not a direct client-side `lib/db` call, because
 * lib/db/happenings.ts is `server-only` (it's the read the GET /api/feed
 * route uses) — unlike lib/db/places.ts/lib/db/events.ts, which have no such
 * restriction and so the place/event detail pages can call getPlace/getEvent
 * straight from the browser. Same session gate as every other /api/* route
 * in this app (proxy.ts already 401s an unauthenticated request before
 * this ever runs; the explicit check below is belt-and-braces, matching
 * /api/feed's own).
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { loadHappeningDetail, type HappeningDetailData } from "@/lib/happenings/detail";
import { cachedJson, CACHE_MEDIUM, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

export const runtime = "nodejs";

/** `siblings` is every other member of the happening's series, `[]` when it isn't part of one — see HappeningDetailData. */
export type HappeningResponse = HappeningDetailData;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await supabaseServer();
  // Public: shared deal links open signed out (user decision 2026-09-15);
  // happenings are `read_all` to anon under RLS.

  try {
    const { happening, siblings } = await loadHappeningDetail(db, id);
    // CACHE_MEDIUM, not CACHE_PRIVATE_NO_STORE: this response never depends
    // on the caller (RLS grants `read_all` to anon, and nothing here reads
    // `db`'s session). It's still `private` (browser-cache only), never
    // `public`/`s-maxage` — lib/http/cache.ts's own file-header doc comment
    // explains why that's unsafe for ANY /api/* route in this app
    // regardless of the data itself: proxy.ts refreshes the session cookie
    // on every request and force-merges it onto whatever the route handler
    // returns, so a `public` response here could get cached at a shared
    // edge/CDN layer carrying a signed-in visitor's session cookie and
    // replayed to the next visitor who hits the same URL. `private,
    // max-age=…` still gets the real win for this page (the browser's own
    // disk cache serving the card→detail hop, and back-navigation) without
    // that risk.
    return cachedJson<HappeningResponse>({ happening, siblings }, CACHE_MEDIUM);
  } catch (err) {
    console.error("[api/happenings/:id] failed", err);
    // The 500 branch stays CACHE_PRIVATE_NO_STORE (never CACHE_MEDIUM) — a
    // transient failure must not get cached, even browser-side, or a retry
    // a moment later would just replay the same empty response.
    return cachedJson<HappeningResponse>({ happening: null, siblings: [] }, CACHE_PRIVATE_NO_STORE, {
      status: 500,
    });
  }
}
