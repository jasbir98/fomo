import "server-only";
import { listPlacesByIds } from "@/lib/db/places";
import { listEventsByIds } from "@/lib/db/events";
import { listHappeningsByIds } from "@/lib/db/happenings";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem, Place } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Db } from "@/lib/supabase/types";

/** A pointer to one card subject — the (subject_type, subject_id) pair `saved_items` and `finds` both store. */
export interface SubjectRef {
  /** Open-ended on purpose: saved_items can still hold removed kinds ("reel", "experience", …), which are simply never looked up. */
  subject_type: string;
  subject_id: string;
}

export interface LoadedSubjects {
  placeById: Map<string, Place>;
  eventById: Map<string, EventItem>;
  happeningById: Map<string, Happening>;
}

/**
 * Batch id-lookup for a list of subject refs: one query per table (places,
 * events, happenings) in parallel, returned as id -> row maps. Any status —
 * an ended or dormant subject still resolves, and it's the caller's call
 * whether to mark it (Saved keeps it with an "Ended" pill) or drop it (Finds
 * runs `findIsStale` in lib/finds/build.ts, which drops anything not live).
 *
 * `db` is used for places only. Events and happenings are read through the
 * service role: their public RLS read is live/active-only
 * (supabase/live_only_public_read.sql), so the caller's own client could not
 * see the ended or hidden rows Saved needs. Callers stay responsible for who
 * may see the result (the saved list is per-user and keyed off the session's
 * own `saved_items` rows).
 *
 * A ref whose row no longer exists, or whose subject_type isn't one of the
 * three, is simply absent from the maps; callers skip it. Extracted from
 * app/api/saved/route.ts so GET /api/finds and lib/finds/load.ts resolve
 * subjects the same way instead of each re-deriving the id lists.
 */
export async function loadSubjects(db: Db, refs: readonly SubjectRef[]): Promise<LoadedSubjects> {
  const idsOf = (type: string) => refs.filter((r) => r.subject_type === type).map((r) => r.subject_id);

  const [places, events, happenings] = await Promise.all([
    listPlacesByIds(db, idsOf("place")),
    listEventsByIds(supabaseAdmin(), idsOf("event")),
    listHappeningsByIds(supabaseAdmin(), idsOf("happening")),
  ]);

  return {
    placeById: new Map(places.map((p) => [p.id, p])),
    eventById: new Map(events.map((e) => [e.id, e])),
    happeningById: new Map(happenings.map((h) => [h.id, h])),
  };
}
