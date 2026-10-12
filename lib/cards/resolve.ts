import "server-only";
import { listPlacesByIds } from "@/lib/db/places";
import { listEventsByIds } from "@/lib/db/events";
import { listHappeningsByIds } from "@/lib/db/happenings";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem, Place } from "@/lib/types";
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
 * whether to mark it (Saved keeps it with an "Ended" pill) or drop it (Finds).
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
    listEventsByIds(db, idsOf("event")),
    listHappeningsByIds(db, idsOf("happening")),
  ]);

  return {
    placeById: new Map(places.map((p) => [p.id, p])),
    eventById: new Map(events.map((e) => [e.id, e])),
    happeningById: new Map(happenings.map((h) => [h.id, h])),
  };
}
