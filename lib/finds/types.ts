/**
 * Fomo Finds — the small, hand-approved list of steals (see
 * docs/plans/2026-10-12-fomo-finds.md). One row in `finds` points at either a
 * provider event (`events`) or a happening (`happenings`, which holds deals),
 * the same subject_type/subject_id shape `saved_items` uses.
 *
 * Shared by the API route, the /finds page, the badge store and
 * scripts/finds.ts, so the contract lives here rather than in any one of them.
 */
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";

export type FindSubjectType = "event" | "happening";
export type FindStatus = "suggested" | "live" | "retired";

/** One `finds` row, as stored (supabase/add_finds.sql). */
export interface FindRow {
  id: string;
  subject_type: FindSubjectType;
  subject_id: string;
  /** One line on why it's a steal, in the IG slides' voice. */
  why: string;
  /** 1–5, the "Fomo level" meter from the IG Finds slides. */
  fomo_level: number;
  score: number | null;
  status: FindStatus;
  /** The Friday of the week it was suggested for ("YYYY-MM-DD"). */
  week_of: string | null;
  created_at: string;
  approved_at: string | null;
}

/** A live Find joined to its subject, ready to render. Ended subjects never reach this shape. */
export type FindItem =
  | { id: string; why: string; fomoLevel: number; kind: "happening"; happening: Happening }
  | { id: string; why: string; fomoLevel: number; kind: "event"; event: EventItem };

/** GET /api/finds */
export interface FindsResponse {
  items: FindItem[];
}

/** Badge lookup key, same "type:id" form lib/useSaved.ts uses. */
export function findKey(type: FindSubjectType, id: string): string {
  return `${type}:${id}`;
}
