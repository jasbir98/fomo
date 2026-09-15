/**
 * GET /api/places/[id]/offers — every live happening linked to this place
 * via `place_id`, for the place detail page's "Offers here" section (Home
 * restructure task 2).
 *
 * A route, not a direct client-side `lib/db` call, for the same reason
 * app/api/happenings/[id]/route.ts exists: lib/db/happenings.ts is
 * `server-only`, unlike lib/db/places.ts, so the (client-component) place
 * page can't call `listHappeningsForPlace` straight from the browser. Same
 * session gate as every other /api/* route (proxy.ts already 401s an
 * unauthenticated request before this ever runs; the explicit check below is
 * belt-and-braces, matching /api/feed's and /api/happenings/[id]'s own).
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { listHappeningsForPlace } from "@/lib/db/happenings";
import type { Happening } from "@/lib/happenings/types";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

export const runtime = "nodejs";

export interface PlaceOffersResponse {
  offers: Happening[];
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await supabaseServer();
  // Public: place pages are browsable signed out (user decision 2026-09-15).

  try {
    const offers = await listHappeningsForPlace(db, id);
    return cachedJson<PlaceOffersResponse>({ offers }, CACHE_PRIVATE_NO_STORE);
  } catch (err) {
    console.error("[api/places/:id/offers] failed", err);
    return cachedJson<PlaceOffersResponse>({ offers: [] }, CACHE_PRIVATE_NO_STORE, { status: 500 });
  }
}
