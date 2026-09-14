/**
 * Fomo Explore — category chips, replacing the old Japan-trip leftovers
 * (Food / Photo spots / Lockers / Transport).
 *
 * `places.category` is free text written by the research pipeline (see
 * scraper/discover_and_extract_city.py) or humanized from a live Google
 * Places type (lib/places/google.ts's `humanizeType`) — there is no fixed
 * enum, so a chip can't do a single `.eq("category", slug)` match. The
 * groupings below were built by sampling the actual promoted Scotland rows
 * (scraper/consolidated/scot-pilot-2026-07-25/_promoted_places.json — the
 * attractions batch — and scraper/consolidated/edi-local-2026-09-12/
 * edinburgh.json — the food/pub/nightlife batch) rather than guessed, so
 * every substring here is a category value that actually occurs in the data.
 * Substring match, case-insensitive, on purpose: "historic building" and
 * "historic-building" and "historic_building" all appear as separate literal
 * values for the same real-world concept.
 *
 * A place can match more than one chip (a "gastropub" is both a Pub & bar and
 * arguably Food & drink) — that's intentional, chips narrow rather than
 * partition, same as the existing Deals & Offers WHAT chips
 * (lib/happenings/groups.ts) tolerate a category belonging to one bucket only
 * by construction; places' free-text categories don't have that luxury.
 *
 * `happenings.category` (lib/happenings/types.ts's `HappeningCategory`) IS a
 * fixed enum, so that half of the mapping is a plain lookup table instead of
 * substrings.
 */
import type { HappeningCategory } from "@/lib/happenings/types";

export interface ExploreCategory {
  slug: ExploreCategorySlug;
  label: string;
  icon: string;
}

export const EXPLORE_CATEGORIES: ExploreCategory[] = [
  { slug: "food_drink", label: "Food & drink", icon: "restaurant" },
  { slug: "cafes", label: "Cafés", icon: "local_cafe" },
  { slug: "pubs_bars", label: "Pubs & bars", icon: "sports_bar" },
  { slug: "museums_galleries", label: "Museums & galleries", icon: "museum" },
  { slug: "parks_views", label: "Parks & views", icon: "park" },
  { slug: "shopping", label: "Shopping", icon: "shopping_bag" },
  { slug: "nightlife", label: "Nightlife", icon: "nightlife" },
  { slug: "culture", label: "Culture", icon: "theater_comedy" },
];

export type ExploreCategorySlug =
  | "food_drink"
  | "cafes"
  | "pubs_bars"
  | "museums_galleries"
  | "parks_views"
  | "shopping"
  | "nightlife"
  | "culture";

export const EXPLORE_CATEGORY_SLUGS: ExploreCategorySlug[] = EXPLORE_CATEGORIES.map((c) => c.slug);

function isExploreCategorySlug(value: string): value is ExploreCategorySlug {
  return (EXPLORE_CATEGORY_SLUGS as string[]).includes(value);
}

/** Parses a comma-separated `?category=` query value into known slugs only — an unrecognised or empty value drops silently rather than 500ing or matching everything. */
export function parseExploreCategories(value: string | null): ExploreCategorySlug[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(isExploreCategorySlug);
}

/** Substring needles matched against a lowercased `places.category`. See this file's header for where these values came from. */
const PLACE_CATEGORY_GROUPS: Record<ExploreCategorySlug, string[]> = {
  food_drink: ["restaurant", "chippy", "bakery", "delicatessen", "cheap eats", "gastropub", "ice cream", "food"],
  cafes: ["cafe", "coffee"],
  pubs_bars: ["pub", "bar", "gastropub", "brewery", "taproom"],
  museums_galleries: ["museum", "gallery", "arts centre", "art centre"],
  parks_views: [
    "park", "viewpoint", "garden", "nature reserve", "nature-reserve", "nature_reserve",
    "walking route", "trail", "loch", "beach", "waterfall", "hill", "mountain", "forest",
    "glen", "river walk", "cliff walk", "coastal feature", "island",
  ],
  shopping: ["shop", "market", "bookshop", "record shop", "shopping street"],
  nightlife: ["nightclub", "live music venue", "comedy club"],
  culture: [
    "theatre", "cinema", "arts centre", "art centre", "library", "historic", "castle",
    "monument", "landmark", "heritage", "cathedral", "abbey", "palace", "distillery",
    "visitor centre", "archaeological", "prehistoric", "chambered cairn", "broch",
  ],
};

/** True if a `places.category` free-text value belongs to `slug`'s group. Null/empty category never matches (no guessing a place into a chip it didn't declare). */
export function matchesPlaceCategory(category: string | null, slug: ExploreCategorySlug): boolean {
  if (!category) return false;
  const c = category.toLowerCase();
  return PLACE_CATEGORY_GROUPS[slug].some((needle) => c.includes(needle));
}

/** `HappeningCategory` -> the Explore chip(s) it reads as. Deliberately loose
 *  (e.g. `music` counts as both Nightlife and Culture) — a gig is plausibly
 *  either, and this only narrows a map layer, it isn't the Deals & Offers
 *  WHAT taxonomy's one-bucket-per-row contract (lib/happenings/groups.ts). A
 *  category absent here (sports, family, wellness, other) has no Explore
 *  chip equivalent and simply never matches any of these — those happenings
 *  still show up under "Everything" and their own layer, just not filtered
 *  into a category chip. */
const HAPPENING_CATEGORY_TO_EXPLORE: Partial<Record<HappeningCategory, ExploreCategorySlug[]>> = {
  food: ["food_drink"],
  nightlife: ["nightlife", "pubs_bars"],
  museum: ["museums_galleries"],
  arts: ["museums_galleries", "culture"],
  cinema: ["culture"],
  comedy: ["nightlife", "culture"],
  music: ["nightlife", "culture"],
  festival: ["culture"],
  outdoors: ["parks_views"],
  tours: ["culture"],
};

export function matchesHappeningCategory(
  category: HappeningCategory | null,
  slug: ExploreCategorySlug
): boolean {
  if (!category) return false;
  return (HAPPENING_CATEGORY_TO_EXPLORE[category] ?? []).includes(slug);
}
