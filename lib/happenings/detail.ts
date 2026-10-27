/**
 * One happening plus the context its detail page shows: the other members of
 * its series and the place photos borrowed for any that have none of their
 * own. Shared by GET /api/happenings/[id] (the client page's refresh) and the
 * server-rendered detail page (first paint and metadata), so the two always
 * agree.
 */
import "server-only";
import { CITY } from "@/lib/city";
import { getHappeningById, listLiveHappenings } from "@/lib/db/happenings";
import { listPlacesByIds } from "@/lib/db/places";
import { groupHappeningsIntoSeries } from "@/lib/happenings/series";
import type { Happening } from "@/lib/happenings/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Db } from "@/lib/supabase/types";
import type { Place } from "@/lib/types";

/**
 * Same fallback as the feed's own `withPlaceImageFallback`: a happening
 * with no `image_url` of its own borrows its linked place's photo. Kept as a
 * local copy (not imported) because the feed's version isn't exported and
 * takes a request-scoped Map built independently — the detail page needs the
 * same result for exactly two happenings' worth of rows (the one being
 * viewed, plus its series siblings), not a whole feed's.
 */
function withPlaceImageFallback(h: Happening, placesById: Map<string, Place>): Happening {
  if (h.image_url || !h.place_id) return h;
  const placeImage = placesById.get(h.place_id)?.image_url;
  return placeImage ? { ...h, image_url: placeImage } : h;
}

export interface HappeningDetailData {
  happening: Happening | null;
  /**
   * Other members of the same series (lib/happenings/series.ts) — "Also at"
   * locations for the detail page's Locations section. Always `[]` when the
   * happening isn't part of a series, including when the whole catalog can't
   * be re-fetched live (best-effort, never fails the main `happening`
   * lookup above it).
   */
  siblings: Happening[];
  /**
   * The linked venue's own website, for the page's Event structured data
   * (organizer.url). Server page only; the API route leaves it out.
   */
  venueWebsite?: string | null;
}

/**
 * Throws only if the happening lookup itself fails; a missing row is `{ happening: null }`.
 *
 * The requested row is read through the service role, not `db`: the public RLS
 * read is live-only (supabase/live_only_public_read.sql), but a link to a deal
 * that has since gone dormant or retired must still open its page. Only that
 * one by-id query bypasses RLS. The series siblings and the place photos below
 * stay on `db` — they list live rows only, which is all anon may read.
 */
export async function loadHappeningDetail(db: Db, id: string): Promise<HappeningDetailData> {
  let happening = await getHappeningById(supabaseAdmin(), id);
  let siblings: Happening[] = [];
  let venueWebsite: string | null = null;
  if (happening) {
    try {
      const all = await listLiveHappenings(db, CITY);
      const groups = groupHappeningsIntoSeries(all);
      const group = groups.find((g) => g.members.some((m) => m.id === happening!.id));
      if (group) siblings = group.members.filter((m) => m.id !== happening!.id);
    } catch (err) {
      console.error("[happening detail] series lookup failed", err);
    }

    // Hero image fallback (task: "Detail hero has no image" — same chain
    // as the feed cards) — borrow the linked place's photo for this
    // happening and every sibling that has none of its own, batched into
    // one query. Best-effort: a lookup failure just leaves image_url as
    // the DB had it (the page's own category-default <img onError> still
    // covers that case), never fails the whole response.
    // The happening's own venue rides along in the same query, for its website.
    const needingPlaceImage = [happening, ...siblings].filter((h) => !h.image_url && h.place_id);
    const placeIds = Array.from(
      new Set([happening.place_id, ...needingPlaceImage.map((h) => h.place_id)].filter((id): id is string => !!id))
    );
    if (placeIds.length > 0) {
      try {
        const places = await listPlacesByIds(db, placeIds);
        const placesById = new Map(places.map((p) => [p.id, p]));
        venueWebsite = (happening.place_id && placesById.get(happening.place_id)?.website) || null;
        happening = withPlaceImageFallback(happening, placesById);
        siblings = siblings.map((s) => withPlaceImageFallback(s, placesById));
      } catch (err) {
        console.error("[happening detail] place image fallback failed", err);
      }
    }
  }
  return { happening, siblings, venueWebsite };
}
