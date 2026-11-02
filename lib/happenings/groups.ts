/**
 * Fomo Happenings — Deals & Offers WHAT/WHO facet mapping, plus the
 * genuine-deal predicate that gates what reaches this section at all.
 *
 * The WHAT/WHO mapping is a pure, deterministic derivation from a
 * happening's `category`/`eligibility` columns into the two independent
 * filter rows the Deals & Offers section shows (originally the Home rebuild
 * contract, task 4; the WHAT table has since grown a `sports` group that
 * spec didn't have — see CATEGORY_TO_WHAT's own note). Kept separate from
 * lib/happenings/format.ts because that module is about DISPLAY strings for
 * every happening; this one is specifically the filter taxonomy for one
 * section.
 *
 * Precomputed server-side (see app/api/feed/route.ts) into `what`/`who` on
 * every deal card, so the client can filter by tapping a chip with no
 * refetch — the whole point of shipping facets instead of raw category /
 * eligibility and re-deriving them in the browser.
 */
import type { HappeningCategory, HappeningEligibility } from "@/lib/happenings/types";
import { familyFitForHappening } from "@/lib/happenings/family";
import { isCheapPrice } from "@/lib/happenings/cheap-price";

export type DealWhatGroup = "food_drink" | "culture" | "activities" | "sports" | "wellness";
export type DealWhoGroup = "students" | "residents" | "under_26" | "over_60" | "families";

export const WHAT_GROUP_LABEL: Record<DealWhatGroup, string> = {
  food_drink: "Food & drink",
  culture: "Culture",
  activities: "Activities",
  sports: "Sports",
  wellness: "Wellness",
};

export const WHO_GROUP_LABEL: Record<DealWhoGroup, string> = {
  students: "Students",
  residents: "EH residents",
  under_26: "Under 26",
  over_60: "Over 60",
  families: "Families",
};

/** Chip order for the WHAT row, "All" first (represented client-side as `null`, not a member of the union — see DealFilters). Sports sits next to Activities, the bucket it used to fall into before it got its own group. */
export const WHAT_GROUP_ORDER: DealWhatGroup[] = ["food_drink", "culture", "activities", "sports", "wellness"];

/** Chip order for the WHO row. No "All" chip in the union itself — the default, unfiltered state is "no chip selected" (`null`), per the task's own note that member/cardholder (and, since `anyone` maps to `null` too — see ELIGIBILITY_TO_WHO — unrestricted) rows should only show then. There's deliberately no "Everyone" chip: every deal already shows in that unfiltered default, so a chip that means the same thing as "no chip selected" would be redundant. */
export const WHO_GROUP_ORDER: DealWhoGroup[] = ["students", "residents", "under_26", "over_60", "families"];

/**
 * The visitor's own deals profile — the WHO groups they said they belong to
 * (Profile → "Deals for you"), stored as `fomo_who` in Supabase auth
 * user_metadata so it needs no table. Unknown values are dropped.
 */
export function parseWhoGroups(userMetadata: unknown): DealWhoGroup[] {
  const raw = (userMetadata as { fomo_who?: unknown } | null | undefined)?.fomo_who;
  if (!Array.isArray(raw)) return [];
  return WHO_GROUP_ORDER.filter((group) => raw.includes(group));
}

/** `sports` gets its own WHAT group rather than folding into `activities`
 *  (its pre-existing bucket) — fixtures/season tickets/club discounts read
 *  as a distinct interest from parkruns and family days out, and lumping
 *  them together buried both under one chip. */
const CATEGORY_TO_WHAT: Partial<Record<HappeningCategory, DealWhatGroup>> = {
  food: "food_drink",
  nightlife: "food_drink",
  museum: "culture",
  arts: "culture",
  cinema: "culture",
  comedy: "culture",
  music: "culture",
  festival: "culture",
  sports: "sports",
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
  student: "students",
  local_resident: "residents",
  under_26: "under_26",
  over_60: "over_60",
  family: "families",
  // anyone / member / cardholder deliberately absent: those rows should
  // surface only in the unfiltered ("no WHO chip selected") state, never
  // under a specific WHO chip. Returning `null` for them means they never
  // match any chip's `who === group` test, and the unfiltered state (which
  // ignores `who` entirely) still shows them. `anyone` joined this list when
  // the "Everyone" chip was removed — there's no chip left for it to map to.
};

/** `null` for `anyone`/`member`/`cardholder` — see the comment on ELIGIBILITY_TO_WHO. */
export function whoGroupForEligibility(eligibility: HappeningEligibility): DealWhoGroup | null {
  return ELIGIBILITY_TO_WHO[eligibility] ?? null;
}

export interface DealFacets {
  what: DealWhatGroup;
  who: DealWhoGroup | null;
  /** Aimed at children (`family_fit` kids, category "family" or a family-only offer — lib/happenings/family.ts), whatever its `eligibility`: a "kids go free" deal open to anyone still belongs under the Families chip. Optional so a client-cached feed from before this field existed still type-checks. */
  kidFriendly?: boolean;
}

export function dealFacets(h: {
  category: HappeningCategory | null;
  eligibility: HappeningEligibility;
  family_fit?: "kids" | "all_ages" | null;
}): DealFacets {
  return {
    what: whatGroupForCategory(h.category),
    who: whoGroupForEligibility(h.eligibility),
    kidFriendly: familyFitForHappening(h) === "kids",
  };
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
  if (whoFilter === "families") return facets.who === "families" || facets.kidFriendly === true;
  if (whoFilter != null && facets.who !== whoFilter) return false;
  return true;
}

/**
 * Matches a `saving_label`/`title` that actually reads as a discount, not a
 * bare price — a percentage figure, "off"/"discount"/"concession" wording,
 * "half price", "free" (as in "one free child ticket with each adult"), a
 * save/saving/savings stem, an "N for N" framing, or a price glued directly
 * to "ticket(s)" ("£4 tickets", "£10 tickets"). That last fragment is the
 * line between two live rows that read almost identically otherwise:
 * National Cinema Weekend's `saving_label: "£4 tickets"` IS the deal (every
 * participating cinema's normal ticket replaced by one flat promotional
 * price, the same shape as EIF's "£10 tickets") but Edinburgh Cocktail Week
 * VIP Pass's `saving_label: "£20.00"` is not — it's a bare number with no
 * noun attached, i.e. just the pass's price, not a price framed as a
 * special/reduced rate for a normal admission. The regex distinguishes them
 * on exactly that: digits immediately (only whitespace between) followed by
 * "ticket"/"tickets" reads as a promotional ticket-price class; digits with
 * nothing after them, or another word in between ("Adult £10", "£99 season
 * ticket"), doesn't — those fall through to signal 3 below instead, which
 * gates on restricted eligibility rather than trusting the label alone.
 *
 * Deliberately loose on WHICH discount shape (the research pipeline's
 * phrasing varies row to row — "20% off", "Save up to 57%", "half-price
 * tickets" all need to match) but tight on requiring one of these concrete
 * words/symbols rather than guessing from prose — see isGenuineDeal's own
 * doc comment for why title and saving_label are the only two fields this
 * runs against.
 */
const DISCOUNT_SHAPE_PATTERN =
  /\d+(\.\d+)?%|\boff\b|\bdiscount\b|\bconcession\b|half[- ]price|\bfree\b|\bsav(e|es|ing|ings)\b|\d+[- ]?for[- ]?\d+|\d+(\.\d+)?\s*tickets?\b|\bbogof\b|\bbuy one,? get one\b|\bget (?:another|a second)\b/i;

/**
 * True for a `kind: "deal"` happening that is an actual, redeemable
 * discount — the thing Deals & Offers is for — as opposed to a plain price
 * listing, "tickets on sale now" announcement, or a rights/application
 * notice that got miscategorised as a deal upstream. Concrete signals only,
 * checked in order of how much they alone prove:
 *
 *  1. A `promo_code` — nobody attaches a redemption code to a plain ticket
 *     price, so its presence alone is enough regardless of eligibility.
 *  2. A discount-shaped `saving_label`/`title` (DISCOUNT_SHAPE_PATTERN) —
 *     "20% off", "Save up to 57%", "half-price tickets", a title containing
 *     "concession" — enough on its own too, any eligibility.
 *  2b. A cheap price: a fixed £ price at or below the good-price line for a
 *     named item ("£4 cask pints", "£5 IPA with any burger"; lines in
 *     price-benchmarks.json, logic in cheap-price.ts). Judges value, not
 *     wording. Same order as scraper/deal_sources/gate.py.
 *  3. A restricted `eligibility` (student/local_resident/under_26/over_60/
 *     member/cardholder — anything but `anyone`) PAIRED WITH a positive
 *     `saving_amount`. Covers rows whose `saving_label` is just a bare price
 *     ("£5.00", "£14.50") rather than "X off" wording, where the restricted
 *     audience is itself the concession signal (a student/resident/senior/
 *     member rate implies a general-admission rate exists above it).
 *     Restricted eligibility ALONE, with no saving_amount at all, is NOT
 *     enough — several "Resident Day" rows in the live data have
 *     `eligibility: "local_resident"` but no captured saving whatsoever,
 *     which reads as a themed civic day, not a specific redeemable offer.
 *
 * Everything else is rejected, including a bare price with unrestricted
 * eligibility ("Adult £10", "£15", "On Sale") — that's a ticket-pricing
 * listing or an on-sale notice, exactly what the task calls out as NOT a
 * deal, even though it has a `saving_amount` column filled in.
 *
 * Only `saving_label`/`title` are regex-tested — never `summary` or
 * `eligibility_note`, both free-text research prose whose wording is
 * inconsistent row to row (checked against the live data: near-identical
 * "Resident Day" rows use "rewards", "special rates", and "free or
 * discounted entry" for the same underlying scheme) and would make near-twin
 * rows classify differently for no real reason.
 */
export function isGenuineDeal(h: {
  title: string;
  saving_label: string | null;
  saving_amount: number | null;
  promo_code: string | null;
  eligibility: HappeningEligibility;
}): boolean {
  if (h.promo_code) return true;
  if (DISCOUNT_SHAPE_PATTERN.test(h.saving_label ?? "") || DISCOUNT_SHAPE_PATTERN.test(h.title)) return true;
  // A fixed price at or below the good-price line for a named item ("£4 cask pints").
  if (isCheapPrice(h.title, h.saving_label)) return true;
  if (h.eligibility !== "anyone" && typeof h.saving_amount === "number" && h.saving_amount > 0) return true;
  return false;
}
