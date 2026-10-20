/**
 * Fallback photo for a curated place with no photo of its own — the place
 * twin of lib/happenings/category-style.ts's `defaultImageFor`, reusing the
 * same bundled images (public/defaults). Display-time only: never written to
 * `places.image_url`, so "has a real photo" checks (hero ranking, deal photo
 * borrowing, scripts/lib/place-match.mjs) still see the gap.
 *
 * An unrecognised category gets null (the caller keeps its plain tile)
 * rather than a photo that could be wrong. Pure and dependency-free so server
 * routes and client components can share it.
 */
import { categoryDefaultImage } from "@/lib/happenings/category-style";
import type { HappeningCategory } from "@/lib/happenings/types";

const theme = (name: string) => `/defaults/themes/${name}.webp`;

// Name keywords checked first. Only ones that can't misfire on an address-y
// venue name: the deal themes' "Lothian"/"bus"/"shop" would turn a café on
// Lothian Road into a bus photo.
const NAME_THEMES: [RegExp, string][] = [
  [/\bcastle\b/i, theme("castle")],
  [/\btheat(re|er)s?\b|\bplayhouse\b|\bLyceum\b|\bTraverse\b/i, theme("theatre")],
  [/\bclimb|\bboulder/i, theme("climbing")],
  [/\bswim|\bpools?\b/i, theme("swim")],
  [/\bgyms?\b|\bfitness\b/i, theme("gym")],
];

// `places.category` is free text from the seed pipelines ("pub", "live music
// venue", "walking route"…); matched as a substring, first hit wins.
const CATEGORY_IMAGES: [RegExp, string][] = [
  [/castle/, theme("castle")],
  [/theatre/, theme("theatre")],
  [/shop|delicatessen/, theme("shopping")],
  [/leisure centre/, theme("swim")],
];

const CATEGORY_MAP: [RegExp, HappeningCategory][] = [
  [/pub|bar|nightclub|distiller/, "nightlife"],
  [/cafe|café|bakery|restaurant|chippy|eats|food|market|ice cream/, "food"],
  [/music|venue/, "music"],
  [/comedy/, "comedy"],
  [/cinema/, "cinema"],
  [/gallery|arts/, "arts"],
  [/museum|library|historic|cathedral|church|abbey|cemetery|landmark|attraction/, "museum"],
  [/park|garden|viewpoint|walking|golf|harbour|street|beach|hill|nature/, "outdoors"],
  [/stadium|bowling|sport/, "sports"],
  [/festival/, "festival"],
  [/community centre/, "family"],
];

function normalizeCategory(category: string | null | undefined): string {
  return (category ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
}

/** The HappeningCategory whose default photo fits a place's free-text category, or null. */
export function placeImageCategory(category: string | null | undefined): HappeningCategory | null {
  const c = normalizeCategory(category);
  if (!c) return null;
  for (const [pattern, slug] of CATEGORY_MAP) if (pattern.test(c)) return slug;
  return null;
}

/** Bundled fallback photo path for a place with no photo, or null when nothing fits. */
export function placeDefaultImage(place: { category?: string | null; name?: string | null }): string | null {
  const name = place.name ?? "";
  for (const [pattern, image] of NAME_THEMES) if (pattern.test(name)) return image;
  const c = normalizeCategory(place.category);
  for (const [pattern, image] of CATEGORY_IMAGES) if (pattern.test(c)) return image;
  const slug = placeImageCategory(c);
  return slug ? categoryDefaultImage(slug) : null;
}
