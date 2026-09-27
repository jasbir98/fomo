/**
 * Fomo personalisation — the 8 "Into…" chips (Profile / MakeFomoYours "Make
 * Fomo yours" card) mapped onto the categories/kinds feed cards actually
 * carry, so lib/personalise/score.ts's `personalBoost` can match a
 * visitor's picked interests against a real card without either module
 * needing to know the other's taxonomy. Two source vocabularies feed into
 * one InterestKey:
 *
 *  - `HappeningCategory` (lib/happenings/types.ts) — our own catalogue rows.
 *  - Provider event `category` strings (scripts/daily-sources.mjs's own
 *    classifier output — "comedy"/"nightlife"/"sports"/"food"/"music"/…,
 *    the same free-text values EventItem.category carries; see that
 *    script's `categoryMap` for the exact vocabulary this mirrors).
 *
 * `other`/`outdoors`/`tours`/`wellness`/`family`/`arts`/`museum`/`cinema`/
 * `festival` all fold into ONE of the 8 chips below rather than getting
 * their own — the chip set is deliberately smaller than the full category
 * union (task: "up to 5 of: comedy, gigs, club_nights, food_drink,
 * culture, outdoors, tech_networking, sport"), the same folding principle
 * lib/happenings/groups.ts's WHAT facets already use for `tours`/`family`/
 * `other` → "activities".
 */
import type { HappeningCategory } from "@/lib/happenings/types";

export type InterestKey =
  | "comedy"
  | "gigs"
  | "club_nights"
  | "food_drink"
  | "culture"
  | "outdoors"
  | "tech_networking"
  | "sport";

export const INTEREST_ORDER: InterestKey[] = [
  "comedy",
  "gigs",
  "club_nights",
  "food_drink",
  "culture",
  "outdoors",
  "tech_networking",
  "sport",
];

export const INTEREST_LABEL: Record<InterestKey, string> = {
  comedy: "Comedy",
  gigs: "Gigs",
  club_nights: "Club nights",
  food_drink: "Food & drink",
  culture: "Culture",
  outdoors: "Outdoors",
  tech_networking: "Tech & networking",
  sport: "Sport",
};

/** Chip icon (Material Symbols) — decorative only, same styling role as lib/happenings/category-style.ts's per-category icons. */
export const INTEREST_ICON: Record<InterestKey, string> = {
  comedy: "theater_comedy",
  gigs: "music_note",
  club_nights: "nightlife",
  food_drink: "restaurant",
  culture: "museum",
  outdoors: "park",
  tech_networking: "groups",
  sport: "sports_soccer",
};

export const MAX_INTERESTS = 5;

/** Our own catalogue rows: `HappeningCategory` → interest. No source category
 *  maps to `tech_networking` here — nothing in the catalogue is currently
 *  classified that way, so that chip only ever matches provider events
 *  (below). Kept as a lookup table, same shape as lib/happenings/groups.ts's
 *  CATEGORY_TO_WHAT, so a future catalogue category is a one-line addition. */
const HAPPENING_CATEGORY_TO_INTEREST: Partial<Record<HappeningCategory, InterestKey>> = {
  comedy: "comedy",
  music: "gigs",
  nightlife: "club_nights",
  food: "food_drink",
  museum: "culture",
  arts: "culture",
  cinema: "culture",
  festival: "culture",
  family: "culture",
  tours: "culture",
  other: "culture",
  outdoors: "outdoors",
  wellness: "outdoors",
  sports: "sport",
};

/** Provider events' free-text `category` (scripts/daily-sources.mjs
 *  classifier output) → interest. Lowercased/trimmed before lookup —
 *  providers are inconsistent about case. */
const EVENT_CATEGORY_TO_INTEREST: Record<string, InterestKey> = {
  comedy: "comedy",
  music: "gigs",
  gigs: "gigs",
  clubs: "club_nights",
  nightlife: "club_nights",
  food: "food_drink",
  drink: "food_drink",
  arts: "culture",
  museum: "culture",
  cinema: "culture",
  festival: "culture",
  family: "culture",
  outdoors: "outdoors",
  sports: "sport",
  sport: "sport",
  tech: "tech_networking",
  networking: "tech_networking",
  business: "tech_networking",
};

export function interestForHappeningCategory(category: HappeningCategory | null): InterestKey | null {
  if (!category) return null;
  return HAPPENING_CATEGORY_TO_INTEREST[category] ?? null;
}

export function interestForEventCategory(category: string | null | undefined): InterestKey | null {
  if (!category) return null;
  return EVENT_CATEGORY_TO_INTEREST[category.trim().toLowerCase()] ?? null;
}
