/**
 * Fomo taxonomy — interest-tag vocabulary.
 *
 * Phase 4 (Onboarding + the real gate, plan-v1.2-accounts.md) seeds just the
 * vocabulary this file needs for onboarding chips (`/onboarding/taste`'s
 * Interests section, `interest_tags[]` on `travel_preferences` — see
 * supabase/add_person_persona.sql). Phase 5 adds the ranking-side mapping
 * functions on top of this same file (`CATEGORY_TO_INTERESTS`,
 * `interestsForPlace`, `interestsForEvent`, `interestsForExperience`,
 * `DWELL_MINUTES`, `HARD_MEAT_CUISINES`) per plan §C.3 — extend this file,
 * don't replace it.
 *
 * This deliberately did not touch `lib/interests.ts` (the old 18-label list
 * used by the old `/setup/travel-dna` interest chips and read-only on
 * Profile) when this file was first written. That file has since been
 * deleted (Phase 8 cleanup) — every reader (TasteForm, Profile) now uses
 * `INTEREST_TAG_META` below instead.
 */

export type InterestTag =
  | "history"
  | "art"
  | "nature"
  | "food"
  | "nightlife"
  | "shopping"
  | "views"
  | "wellness"
  | "popculture"
  | "outdoors"
  | "music"
  | "family";

/** All 12 interest tags, in a stable order for rendering chips. */
export const INTEREST_TAGS: InterestTag[] = [
  "history",
  "art",
  "nature",
  "food",
  "nightlife",
  "shopping",
  "views",
  "wellness",
  "popculture",
  "outdoors",
  "music",
  "family",
];

/** Display label + Material Symbols icon for each interest tag chip. */
export const INTEREST_TAG_META: Record<InterestTag, { label: string; icon: string }> = {
  history: { label: "History", icon: "history_edu" },
  art: { label: "Art", icon: "palette" },
  nature: { label: "Nature", icon: "forest" },
  food: { label: "Food", icon: "restaurant" },
  nightlife: { label: "Nightlife", icon: "nightlife" },
  shopping: { label: "Shopping", icon: "shopping_bag" },
  views: { label: "Views", icon: "landscape" },
  wellness: { label: "Wellness", icon: "spa" },
  popculture: { label: "Pop culture", icon: "animation" },
  outdoors: { label: "Outdoors", icon: "hiking" },
  music: { label: "Music", icon: "music_note" },
  family: { label: "Family", icon: "family_restroom" },
};

/**
 * Dietary options — moved out of `app/setup/travel-dna/page.tsx`'s inline
 * `DIETARY` const (plan §A.3) so both `/onboarding/taste` and the
 * travel-dna edit-mode wrapper share one list. Values match the existing
 * `travel_preferences.dietary text[]` column, unchanged.
 */
export const DIETARY_OPTIONS = ["Vegan", "Gluten Free", "Vegetarian", "Halal"] as const;

// ============================================================================
// Phase 5 (Persona schema + taxonomy, plan-v1.2-accounts.md §C.3) — the
// ranking-side mapping functions. Everything below is plumbing only this
// phase: nothing in lib/now/rank.ts, lib/now/generators.ts or
// lib/now/rails.ts calls any of this yet (that's Phase 6, "the killer
// test" — see the F-table). `lib/now/persona.ts` doesn't call these
// directly either; they exist so Phase 6 has one place to import from.
//
// This file is imported by client components (TasteForm.tsx and friends),
// so it must stay import-clean of anything importing the `server-only`
// package. `EventCategory` below is pulled in with `import type` — a
// type-only import is fully erased by the compiler, so it never drags
// lib/events/categories.ts's `server-only` guard into a client bundle.
// ============================================================================
import type { EventCategory } from "@/lib/events/categories";
import type { Place, EventItem, Experience } from "@/lib/types";

/**
 * Place/category-like string → interest tags. Grounded in the category
 * vocabulary the data actually carries (plan §C.3): Japan seed pipeline
 * (museum..garden), Scotland seed pipeline (castle..island-viewpoint), and
 * live Google-cached rows (food | photo | lockers | transport).
 *
 * Two entries (`attraction`, `lockers`, `transport`) are deliberately mapped
 * to an empty array rather than omitted — they're real values in the data,
 * just too generic/utility-only to carry an interest signal. An empty array
 * here behaves identically to a key that isn't present at all (both make
 * `interestsForPlace` return an empty `Set`, which is neutral downstream,
 * per the "unmappable category is never a penalty" rule) — they're listed
 * explicitly so a reader doesn't mistake the omission for an oversight.
 */
export const CATEGORY_TO_INTERESTS: Record<string, InterestTag[]> = {
  // Japan seed pipeline (supabase/seed_japan_pilot.sql lineage)
  museum: ["history", "art"],
  park: ["nature", "outdoors"],
  shrine: ["history"],
  temple: ["history"],
  attraction: [],
  "shopping-street": ["shopping"],
  viewpoint: ["views"],
  nightlife: ["nightlife"],
  bath: ["wellness"],
  "scenic-walk": ["views", "outdoors"],
  market: ["shopping", "food"],
  food: ["food"],
  garden: ["nature"],
  // Scotland seed pipeline (scraper/consolidated/scot-pilot-*)
  castle: ["history"],
  distillery: ["food", "history"],
  loch: ["nature", "views"],
  "hill-walk": ["outdoors", "nature"],
  cathedral: ["history"],
  abbey: ["history"],
  gallery: ["art"],
  battlefield: ["history"],
  "standing-stones": ["history"],
  golf: ["outdoors"],
  harbour: ["views"],
  "island-viewpoint": ["views"],
  // Live Google Places fallback (lib/places/google.ts normalizeCategory)
  photo: ["views"],
  lockers: [],
  transport: [],
};

/**
 * Event category → interest tags. `EventCategory` (lib/events/categories.ts)
 * is the 9-value union every provider mapper (Skiddle, Ticketmaster)
 * normalizes onto. `other` maps to an empty array deliberately — it's the
 * catch-all bucket for anything a provider's own taxonomy didn't resolve,
 * so it carries no reliable interest signal.
 */
export const EVENT_CATEGORY_TO_INTERESTS: Record<EventCategory, InterestTag[]> = {
  music: ["music"],
  nightlife: ["nightlife"],
  festival: ["music", "popculture"],
  arts: ["art"],
  comedy: ["popculture"],
  sports: ["outdoors"],
  food: ["food"],
  family: ["family"],
  other: [],
};

/** Interest tags implied by a place's category. Empty set for a null or unmapped category — never a default/fallback tag (plan §C.3's "unmappable → neutral, not a penalty" rule). */
export function interestsForPlace(p: Place): Set<InterestTag> {
  if (!p.category) return new Set();
  return new Set(CATEGORY_TO_INTERESTS[p.category] ?? []);
}

/** Interest tags implied by an event's category. Same empty-set-for-unmapped rule as `interestsForPlace`; `e.category` is stored as plain `string | null` on `EventItem` (see lib/types.ts), so an unrecognized value also falls through to empty rather than throwing. */
export function interestsForEvent(e: EventItem): Set<InterestTag> {
  if (!e.category) return new Set();
  return new Set(EVENT_CATEGORY_TO_INTERESTS[e.category as EventCategory] ?? []);
}

/**
 * Keyword groups for `interestsForExperience` — Viator/GetYourGuide don't
 * give Fomo a clean categorical field (`Experience.category` is
 * provider-supplied free text: a Viator tag, a GetYourGuide category
 * string, sometimes null). Rather than trust an uncontrolled vocabulary the
 * way `CATEGORY_TO_INTERESTS` trusts Fomo's own pipeline output, this
 * scans title + category + description for conservative, unambiguous
 * keywords. Deliberately short lists — a false match here mis-tags a
 * bookable tour, which is worse than missing a tag.
 */
const EXPERIENCE_KEYWORDS: Array<[InterestTag, string[]]> = [
  ["history", ["museum", "historic", "heritage", "castle", "palace", "temple", "shrine"]],
  ["art", ["art gallery", "art museum", "gallery tour"]],
  ["nature", ["national park", "garden tour", "wildlife", "safari"]],
  ["outdoors", ["hiking", "trekking", "cycling", "kayak", "climbing"]],
  ["food", ["food tour", "tasting", "cooking class", "culinary", "wine tour", "brewery", "distillery"]],
  ["nightlife", ["bar crawl", "nightclub", "pub crawl"]],
  ["shopping", ["shopping tour", "market tour"]],
  ["views", ["viewpoint", "observation deck", "skyline", "sunset cruise"]],
  ["wellness", ["spa", "onsen", "hot spring", "yoga retreat"]],
  ["popculture", ["anime", "studio tour", "theme park"]],
  ["music", ["concert", "live music", "music festival"]],
  ["family", ["family friendly", "kid friendly", "theme park", "zoo", "aquarium"]],
];

/** Interest tags implied by an experience's title/category/description via a conservative keyword scan — see `EXPERIENCE_KEYWORDS`. Empty set when nothing matches, same neutral-not-penalty rule as the others. */
export function interestsForExperience(x: Experience): Set<InterestTag> {
  const hay = `${x.title ?? ""} ${x.category ?? ""} ${x.description ?? ""}`.toLowerCase();
  const result = new Set<InterestTag>();
  for (const [tag, keywords] of EXPERIENCE_KEYWORDS) {
    if (keywords.some((k) => hay.includes(k))) result.add(tag);
  }
  return result;
}

/**
 * Estimated dwell time in minutes per category. No measured duration data
 * exists anywhere in the pipeline today (plan §C.3) — these are reasonable
 * estimates for `gap_filler`'s dwell-vs-gap math (Phase 6), not real
 * averages. Keys mirror `CATEGORY_TO_INTERESTS`; utility categories
 * (`lockers`, `transport`) get near-zero dwell since they're waypoints, not
 * destinations.
 */
export const DWELL_MINUTES: Record<string, number> = {
  museum: 90,
  park: 45,
  shrine: 20,
  temple: 20,
  attraction: 45,
  "shopping-street": 60,
  viewpoint: 20,
  nightlife: 120,
  bath: 90,
  "scenic-walk": 60,
  market: 45,
  food: 60,
  garden: 30,
  castle: 60,
  distillery: 75,
  loch: 30,
  "hill-walk": 120,
  cathedral: 30,
  abbey: 30,
  gallery: 60,
  battlefield: 30,
  "standing-stones": 20,
  golf: 180,
  harbour: 20,
  "island-viewpoint": 20,
  photo: 10,
  lockers: 5,
  transport: 5,
};

/**
 * Cuisine tag strings that unambiguously imply meat, for Phase 6's
 * structured hard filter (plan §D.2) — matched against a place's category/
 * cuisine tag and name, never against reframed headline copy. No `cuisine`
 * column exists on `places` today (checked schema.sql and the pipeline
 * migrations), so there's no real vocabulary to ground this in yet; this is
 * a conservative starting list Phase 6 (or the places pipeline, once it
 * gains a cuisine column) can extend.
 */
export const HARD_MEAT_CUISINES: string[] = [
  "steakhouse",
  "yakiniku",
  "yakitori",
  "bbq",
  "barbecue",
  "butcher",
  "grill",
  "churrascaria",
  "kebab",
  "charcuterie",
];
