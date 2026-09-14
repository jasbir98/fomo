/**
 * Fomo Happenings — Deals & Offers WHAT/WHO facet mapping.
 *
 * Pure, deterministic mapping from a happening's `category`/`eligibility`
 * columns to the two independent filter rows the Deals & Offers section
 * shows (see the Home rebuild contract, task 4). Kept separate from
 * lib/happenings/format.ts because that module is about DISPLAY strings for
 * every happening; this one is specifically the filter taxonomy for one
 * section, and the mapping tables here are a direct transcription of the
 * task's own WHAT/WHO group spec — reviewers should be able to diff this
 * file against that spec line-for-line.
 *
 * Precomputed server-side (see app/api/feed/route.ts) into `what`/`who` on
 * every deal card, so the client can filter by tapping a chip with no
 * refetch — the whole point of shipping facets instead of raw category /
 * eligibility and re-deriving them in the browser.
 */
import type { HappeningCategory, HappeningEligibility } from "@/lib/happenings/types";

export type DealWhatGroup = "food_drink" | "culture" | "activities" | "wellness";
export type DealWhoGroup = "everyone" | "students" | "residents" | "under_26" | "over_60";

export const WHAT_GROUP_LABEL: Record<DealWhatGroup, string> = {
  food_drink: "Food & drink",
  culture: "Culture",
  activities: "Activities",
  wellness: "Wellness",
};

export const WHO_GROUP_LABEL: Record<DealWhoGroup, string> = {
  everyone: "Everyone",
  students: "Students",
  residents: "EH residents",
  under_26: "Under 26",
  over_60: "Over 60",
};

/** Chip order for the WHAT row, "All" first (represented client-side as `null`, not a member of the union — see DealFilters). */
export const WHAT_GROUP_ORDER: DealWhatGroup[] = ["food_drink", "culture", "activities", "wellness"];

/** Chip order for the WHO row. No "All" chip in the union itself — the default, unfiltered state is "no chip selected" (`null`), per the task's own note that member/cardholder rows should only show then. */
export const WHO_GROUP_ORDER: DealWhoGroup[] = ["everyone", "students", "residents", "under_26", "over_60"];

const CATEGORY_TO_WHAT: Partial<Record<HappeningCategory, DealWhatGroup>> = {
  food: "food_drink",
  nightlife: "food_drink",
  museum: "culture",
  arts: "culture",
  cinema: "culture",
  comedy: "culture",
  music: "culture",
  festival: "culture",
  sports: "activities",
  family: "activities",
  outdoors: "activities",
  tours: "activities",
  other: "activities",
  wellness: "wellness",
};

/** Every `category` value not explicitly listed (currently none — the union is exhaustively covered) and `null` fall back to "Activities", the task's own catch-all bucket ("...tours, other, null → Activities"). */
export function whatGroupForCategory(category: HappeningCategory | null): DealWhatGroup {
  if (!category) return "activities";
  return CATEGORY_TO_WHAT[category] ?? "activities";
}

const ELIGIBILITY_TO_WHO: Partial<Record<HappeningEligibility, DealWhoGroup>> = {
  anyone: "everyone",
  student: "students",
  local_resident: "residents",
  under_26: "under_26",
  over_60: "over_60",
  // member / cardholder deliberately absent: per the task, those rows should
  // surface only in the unfiltered ("no WHO chip selected") state, never
  // under a specific WHO chip — including "Everyone". Returning `null` for
  // them means they never match any chip's `who === group` test, and the
  // unfiltered state (which ignores `who` entirely) still shows them.
};

/** `null` for `member`/`cardholder` — see the comment on ELIGIBILITY_TO_WHO. */
export function whoGroupForEligibility(eligibility: HappeningEligibility): DealWhoGroup | null {
  return ELIGIBILITY_TO_WHO[eligibility] ?? null;
}

export interface DealFacets {
  what: DealWhatGroup;
  who: DealWhoGroup | null;
}

export function dealFacets(h: {
  category: HappeningCategory | null;
  eligibility: HappeningEligibility;
}): DealFacets {
  return { what: whatGroupForCategory(h.category), who: whoGroupForEligibility(h.eligibility) };
}

/**
 * Client-side chip match — `whatFilter: null` means the "All" chip (row 1
 * always has a selection, "All" by default); `whoFilter: null` means no WHO
 * chip is selected, the section's true default (see the task's own note:
 * "Make 'no WHO chip selected' the default (shows everything)").
 */
export function matchesDealFilters(
  facets: DealFacets,
  whatFilter: DealWhatGroup | null,
  whoFilter: DealWhoGroup | null
): boolean {
  if (whatFilter != null && facets.what !== whatFilter) return false;
  if (whoFilter != null && facets.who !== whoFilter) return false;
  return true;
}
