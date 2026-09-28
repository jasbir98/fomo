/**
 * Fomo Saved — GET /api/saved?limit=&offset=
 *   Identity comes from the session cookie, not a query param — see
 *   plan-v1.2-accounts.md §A.5. No session -> immediate `degraded:
 *   "unauthorized"`, never a silent empty response.
 *   limit:  default 24, max 60.
 *   offset: default 0 — pagination for lib/useInfiniteList.ts, driving
 *           app/(shell)/saved/page.tsx.
 *
 * Reads one page of saved_items (user-scoped via RLS, NOT trip-scoped — see
 * lib/db/saved.ts's listSavedItemsPage doc comment), then resolves each row
 * into the same Candidate shape (lib/cards/types.ts) by direct id lookup
 * against places/events/happenings.
 *
 * A saved subject whose row was since deleted, or whose subject_type is one
 * of the removed kinds ("reel"/"experience"/"itinerary_item"/"practicality"
 * — the 2026-09 cleanup dropped their features; rows of those types still
 * exist in the DB until supabase/drop_legacy.sql runs), is silently dropped
 * rather than rendered broken. That can make a resolved page shorter than
 * the underlying saved_items page, which can make lib/useInfiniteList.ts's
 * `rows.length >= pageSize` hasMore heuristic stop one page early — an
 * accepted best-effort limitation, not a bug to chase down here.
 */
import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { CITY } from "@/lib/city";
import { listSavedItemsPage } from "@/lib/db/saved";
import { listPlacesByIds } from "@/lib/db/places";
import { listEventsByIds } from "@/lib/db/events";
import { listHappeningsByIds } from "@/lib/db/happenings";
import { eventHasEnded } from "@/lib/events/format";
import { happeningHasEnded } from "@/lib/happenings/occurrence";
import { placeImage, placeCoords, eventHeadline, venueLabel } from "@/lib/cards/place";
import type { Candidate } from "@/lib/cards/types";
import type { SavedItem } from "@/lib/types";
import type { Db } from "@/lib/supabase/types";
import { isUnauthorizedError } from "@/lib/supabase-error";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

interface SavedResponse {
  items: Candidate[];
  /**
   * Absent in the normal (including empty-list) case — only set when the
   * caller has no session, or the catch below positively identifies an auth
   * denial, so existing callers that only check `items.length` keep working
   * unchanged.
   */
  degraded?: "unauthorized";
}

export async function GET(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return cachedJson<SavedResponse>({ items: [], degraded: "unauthorized" }, CACHE_PRIVATE_NO_STORE);
  }

  const { searchParams } = new URL(request.url);

  // Same null-vs-0 guard used across this app's GET routes — searchParams.get
  // is null when absent, and Number(null) is 0, which Number.isFinite treats
  // as real, so the raw string must be null-checked before converting.
  const rawLimitParam = searchParams.get("limit");
  const rawLimit = rawLimitParam == null ? NaN : Number(rawLimitParam);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;

  const rawOffsetParam = searchParams.get("offset");
  const rawOffset = rawOffsetParam == null ? NaN : Number(rawOffsetParam);
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

  try {
    const saved = await listSavedItemsPage(db, { limit, offset });
    const items = await resolveCandidates(db, saved);
    return cachedJson<SavedResponse>({ items }, CACHE_PRIVATE_NO_STORE);
  } catch (err) {
    console.error("[api/saved] failed", err);
    return cachedJson<SavedResponse>(
      isUnauthorizedError(err) ? { items: [], degraded: "unauthorized" } : { items: [] },
      CACHE_PRIVATE_NO_STORE
    );
  }
}

/** Resolves one page of saved_items rows into Candidate objects, preserving newest-saved-first order. */
async function resolveCandidates(db: Db, saved: SavedItem[]): Promise<Candidate[]> {
  const placeIds = saved.filter((s) => s.subject_type === "place").map((s) => s.subject_id);
  const eventIds = saved.filter((s) => s.subject_type === "event").map((s) => s.subject_id);
  const happeningIds = saved.filter((s) => s.subject_type === "happening").map((s) => s.subject_id);

  const [places, events, happenings] = await Promise.all([
    listPlacesByIds(db, placeIds),
    listEventsByIds(db, eventIds),
    listHappeningsByIds(db, happeningIds),
  ]);
  const placeById = new Map(places.map((p) => [p.id, p]));
  const eventById = new Map(events.map((e) => [e.id, e]));
  const happeningById = new Map(happenings.map((h) => [h.id, h]));

  const now = new Date();
  const out: Candidate[] = [];

  for (const s of saved) {
    if (s.subject_type === "place") {
      const place = placeById.get(s.subject_id);
      if (!place) continue;
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "place", id: place.id },
        pill: "Saved",
        why: "You saved this",
        headline: place.name ?? "Saved place",
        detail: place.detail_line ?? "",
        primaryAction: { label: "Saved", kind: "add" },
        image: placeImage(place),
        urgency: "low",
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
        distanceKm: null,
        subjectName: place.name ?? "Saved place",
        coords: placeCoords(place),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    } else if (s.subject_type === "event") {
      const event = eventById.get(s.subject_id);
      if (!event) continue;
      const title = eventHeadline(event.name, CITY.name);
      // A saved event stays after it's happened, clearly marked — same
      // treatment as a saved happening below.
      const eventEnded = eventHasEnded(event, now);
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "event", id: event.id },
        pill: eventEnded ? "Ended" : "Saved",
        why: eventEnded ? "This event has passed" : "You saved this",
        headline: title,
        detail: eventEnded ? "Already happened" : (venueLabel(event.venue_name) ?? ""),
        primaryAction: { label: "Saved", kind: "add" },
        image: { url: event.image_url, quality: event.image_url ? "thin" : "none" },
        urgency: "low",
        validFrom: now.toISOString(),
        validUntil: event.starts_at,
        distanceKm: null,
        subjectName: title,
        coords: placeCoords(event),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    } else if (s.subject_type === "happening") {
      const h = happeningById.get(s.subject_id);
      if (!h) continue;
      // A saved offer that has since gone dormant/retired — or whose dates
      // have simply passed while still marked live — stays in the list,
      // clearly marked, instead of silently disappearing.
      const ended = h.status !== "live" || happeningHasEnded(h, now);
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "happening", id: h.id },
        pill: ended ? "Ended" : "Saved",
        why: ended ? "This offer has ended" : "You saved this",
        headline: h.title,
        detail: ended ? "No longer running" : (h.venue_name ?? ""),
        primaryAction: { label: "Saved", kind: "add" },
        image: { url: h.image_url, quality: h.image_url ? "thin" : "none" },
        urgency: "low",
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
        distanceKm: null,
        subjectName: h.title,
        coords: placeCoords(h),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    }
    // Any other subject_type ("reel" / "experience" / "itinerary_item" /
    // "practicality" — leftover rows from removed features, see this file's
    // header) has no batch id-lookup pool here; this if/else chain simply
    // falls through and skips it.
  }

  return out;
}
