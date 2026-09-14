/**
 * Fomo Happenings — /whats-on page category filter taxonomy.
 *
 * Pure, deterministic mapping from a `FeedCardData` (lib/happenings/
 * feed-types.ts) to the single category chip the /whats-on page's category
 * row shows for it. Same "derive facets from the already-fetched list, no
 * refetch on a chip tap" principle as lib/happenings/book-early-filters.ts
 * and lib/happenings/free-any-time-filters.ts.
 *
 * Happening/series cards use `lib/happenings/category-style.ts`'s existing
 * 14-value HappeningCategory vocabulary directly. Event cards (Skiddle/
 * Ticketmaster, via lib/events/categories.ts's EventCategory, which is
 * server-only) carry their category as a plain string on `EventItem` — its
 * live values (music/nightlife/festival/arts/comedy/sports/food/family/
 * other) are already a subset of HappeningCategory's own slugs, so a match
 * against CATEGORY_STYLE's keys reuses the identical label/icon rather than
 * inventing a second vocabulary; anything unrecognised groups under the
 * catch-all "Events" chip instead of guessing a "nearest" category.
 */
import { CATEGORY_ORDER, CATEGORY_STYLE, type CategoryStyle } from "@/lib/happenings/category-style";
import type { HappeningCategory } from "@/lib/happenings/types";
import type { FeedCardData } from "@/lib/happenings/feed-types";

/** "events" is a synthetic key — never a real HappeningCategory slug — for
 *  an event card whose provider category didn't resolve to one. */
export type CategoryFacetKey = HappeningCategory | "events";

export interface CategoryFacet {
  key: CategoryFacetKey;
  label: string;
  icon: string;
}

const EVENTS_FACET: CategoryFacet = { key: "events", label: "Events", icon: "confirmation_number" };

function isHappeningCategory(value: string): value is HappeningCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_STYLE, value);
}

function facetFromStyle(key: HappeningCategory, style: CategoryStyle): CategoryFacet {
  return { key, label: style.label, icon: style.icon };
}

/** The category chip a given card belongs under. */
export function categoryFacetForCard(card: FeedCardData): CategoryFacet {
  if (card.kind === "happening") return facetFromStyle(card.happening.category ?? "other", CATEGORY_STYLE[card.happening.category ?? "other"]);
  if (card.kind === "series") return facetFromStyle(card.lead.category ?? "other", CATEGORY_STYLE[card.lead.category ?? "other"]);
  const raw = card.event.category;
  if (raw && isHappeningCategory(raw)) return facetFromStyle(raw, CATEGORY_STYLE[raw]);
  return EVENTS_FACET;
}

/** Distinct category facets actually present in a list, in CATEGORY_ORDER's
 *  order with the "Events" catch-all always last (it's not part of that
 *  vocabulary). Only ever offers a chip for a facet that has at least one
 *  matching card. */
export function distinctCategoryFacets(cards: FeedCardData[]): CategoryFacet[] {
  const present = new Map<CategoryFacetKey, CategoryFacet>();
  for (const card of cards) {
    const facet = categoryFacetForCard(card);
    if (!present.has(facet.key)) present.set(facet.key, facet);
  }
  const ordered = CATEGORY_ORDER.filter((key) => present.has(key)).map((key) => present.get(key)!);
  if (present.has("events")) ordered.push(present.get("events")!);
  return ordered;
}

export function matchesCategoryFilter(card: FeedCardData, key: CategoryFacetKey | null): boolean {
  if (key == null) return true;
  return categoryFacetForCard(card).key === key;
}
