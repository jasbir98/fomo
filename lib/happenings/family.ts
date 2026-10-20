/**
 * Fomo Happenings — the "with kids" lens.
 *
 * Two values (supabase/add_family_fit.sql, column `family_fit` on happenings,
 * events and places):
 *   - `kids`     aimed at children — Bookbug rhyme time, soft play, a kids'
 *                workshop, "kids eat free".
 *   - `all_ages` good with kids but for anyone — a free museum, the Botanics,
 *                Christmas lights.
 *   - null       not for kids, or unknown.
 * Separately, a happening with `eligibility: "family"` is an offer only someone
 * with children can use; it is always at least `kids` here.
 *
 * THIS IS THE ONE HELPER every UI filter, chip, section and ranker must use to
 * ask "is this kid-friendly?". Never read `family_fit` / `category` /
 * `eligibility` directly for that: the stored column is null until the
 * classification pipeline has run, and the fallbacks below keep rows that
 * pre-date it (category "family", family-only offers) working.
 *
 * Deliberately NOT `server-only` — client components import it. Pure, no I/O.
 */
import type { EventItem } from "@/lib/types";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import type { FamilyFit, Happening } from "@/lib/happenings/types";

type HappeningLike = Pick<Happening, "category" | "eligibility"> & { family_fit?: FamilyFit | null };
type EventLike = Pick<EventItem, "category"> & { family_fit?: FamilyFit | null };
type PlaceLike = { family_fit?: FamilyFit | null };

export function familyFitForHappening(h: HappeningLike): FamilyFit | null {
  // Once supabase/add_family_fit.sql has run the key is always present, and a
  // null is a decision (the backfill leaves e.g. a zoo student concession null
  // on purpose). The category/eligibility fallback is only for rows read
  // before the column exists, when the key is absent.
  if (h.family_fit !== undefined) return h.family_fit;
  if (h.eligibility === "family") return "kids";
  // A concession for an adult group at a family venue (Edinburgh Zoo student
  // ticket, Camera Obscura resident rate) is not a kids' offer, whatever the
  // venue's category — the same rule scripts/lib/family-rules.mjs applies.
  if (h.category === "family" && (h.eligibility ?? "anyone") === "anyone") return "kids";
  return null;
}

export function familyFitForEvent(e: EventLike): FamilyFit | null {
  if (e.family_fit !== undefined) return e.family_fit;
  if (e.category === "family") return "kids";
  return null;
}

export function familyFitForPlace(p: PlaceLike): FamilyFit | null {
  return p.family_fit ?? null;
}

/** Any feed card, whatever its kind. A series or recurring card takes its lead's value. */
export function familyFitForCard(card: FeedCardData): FamilyFit | null {
  switch (card.kind) {
    case "happening":
      return familyFitForHappening(card.happening);
    case "event":
      return familyFitForEvent(card.event);
    case "series":
      return familyFitForHappening(card.lead);
    case "recurring":
      return familyFitForCard(card.lead);
  }
}

/** True when the card is `kids` or `all_ages` — the "With kids" filter's predicate. */
export function isKidFriendly(card: FeedCardData): boolean {
  return familyFitForCard(card) !== null;
}
