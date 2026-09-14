/**
 * GET /api/happenings/[id] — single happening lookup, for the happening
 * detail page (app/(shell)/happening/[id]/page.tsx).
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
import { CITY } from "@/lib/city";
import { getHappeningById, listLiveHappenings } from "@/lib/db/happenings";
import { listPlacesByIds } from "@/lib/db/places";
import { groupHappeningsIntoSeries } from "@/lib/happenings/series";
import type { Happening } from "@/lib/happenings/types";
import type { Place } from "@/lib/types";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

/**
 * Same fallback as GET /api/feed's own `withPlaceImageFallback`: a happening
 * with no `image_url` of its own borrows its linked place's photo. Kept as a
 * local copy (not imported) because the feed route's version isn't exported
 * and takes a request-scoped Map this route builds independently — the
 * detail page needs the same result for exactly two happenings' worth of
 * rows (the one being viewed, plus its series siblings), not a whole feed's.
 */
function withPlaceImageFallback(h: Happening, placesById: Map<string, Place>): Happening {
  if (h.image_url || !h.place_id) return h;
  const placeImage = placesById.get(h.place_id)?.image_url;
  return placeImage ? { ...h, image_url: placeImage } : h;
}

export const runtime = "nodejs";

export interface HappeningResponse {
  happening: Happening | null;
  /**
   * Other members of the same series (lib/happenings/series.ts) — "Also at"
   * locations for the detail page's Locations section (task 1's "links to a
   * detail view that lists every location/date"). Always `[]` when the
   * happening isn't part of a series, including when it or the whole
   * catalog can't be re-fetched live (best-effort, never fails the main
   * `happening` lookup above it).
   */
  siblings: Happening[];
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    // Auth-gated (401 vs 200 per session) — must not be publicly cached
    // despite the underlying happening data itself being non-user-specific.
    return cachedJson<HappeningResponse>({ happening: null, siblings: [] }, CACHE_PRIVATE_NO_STORE, {
      status: 401,
    });
  }

  try {
    let happening = await getHappeningById(db, id);
    let siblings: Happening[] = [];
    if (happening) {
      try {
        const all = await listLiveHappenings(db, CITY);
        const groups = groupHappeningsIntoSeries(all);
        const group = groups.find((g) => g.members.some((m) => m.id === happening!.id));
        if (group) siblings = group.members.filter((m) => m.id !== happening!.id);
      } catch (err) {
        console.error("[api/happenings/:id] series lookup failed", err);
      }

      // Hero image fallback (task: "Detail hero has no image" — same chain
      // as the feed cards) — borrow the linked place's photo for this
      // happening and every sibling that has none of its own, batched into
      // one query. Best-effort: a lookup failure just leaves image_url as
      // the DB had it (the page's own category-default <img onError> still
      // covers that case), never fails the whole response.
      const needingPlaceImage = [happening, ...siblings].filter((h) => !h.image_url && h.place_id);
      if (needingPlaceImage.length > 0) {
        try {
          const placeIds = Array.from(new Set(needingPlaceImage.map((h) => h.place_id as string)));
          const places = await listPlacesByIds(db, placeIds);
          const placesById = new Map(places.map((p) => [p.id, p]));
          happening = withPlaceImageFallback(happening, placesById);
          siblings = siblings.map((s) => withPlaceImageFallback(s, placesById));
        } catch (err) {
          console.error("[api/happenings/:id] place image fallback failed", err);
        }
      }
    }
    return cachedJson<HappeningResponse>({ happening, siblings }, CACHE_PRIVATE_NO_STORE);
  } catch (err) {
    console.error("[api/happenings/:id] failed", err);
    return cachedJson<HappeningResponse>({ happening: null, siblings: [] }, CACHE_PRIVATE_NO_STORE, {
      status: 500,
    });
  }
}
