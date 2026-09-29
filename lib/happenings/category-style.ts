/**
 * Fomo Happenings — category (and kind) visual mapping.
 *
 * Single source of truth for turning a happening's `category` (or `kind`)
 * into a colour, a Material Symbol icon, and a label — added so the feed
 * stops reading as uniformly navy/blue (user feedback: "the homepage is
 * messy, all blue, too much text"). Every accent colour is a literal
 * Tailwind class referencing a `--color-cat-*` token defined in
 * app/globals.css (`bg-cat-music`, `text-cat-music`, …) — classes are
 * written out in full below, never built with string interpolation, so
 * Tailwind's static content scan can find them.
 *
 * Pure and dependency-free (no `server-only`, no fetch) — same testability
 * rationale as lib/happenings/format.ts: both server route handlers and
 * client card components need this, and it should stay a plain function of
 * its input.
 */
import type { HappeningCategory, HappeningKind } from "@/lib/happenings/types";

export interface CategoryStyle {
  label: string;
  /** Material Symbols Outlined ligature name. */
  icon: string;
  /** Solid badge: dark, saturated background + white text — AA-safe on any surface, mirrors the app's existing bg-primary-container/text-on-primary-container pill convention. */
  badgeClass: string;
  /** Text-only accent (icons, dots, section markers) — same hue as the badge background. */
  textClass: string;
  /** Small solid marker dot (e.g. next to a section heading). */
  dotClass: string;
  /** Bundled local default image — public/defaults/happenings/<category>.webp (1600px; next/image resizes per placement) — used when a happening has no image_url and (for venue-grouped cards) no place photo either. */
  defaultImage: string;
}

export const CATEGORY_ORDER: HappeningCategory[] = [
  "music",
  "nightlife",
  "festival",
  "arts",
  "comedy",
  "sports",
  "food",
  "family",
  "museum",
  "cinema",
  "other",
  "wellness",
  "outdoors",
  "tours",
];

export const CATEGORY_STYLE: Record<HappeningCategory, CategoryStyle> = {
  music: {
    label: "Music",
    icon: "music_note",
    badgeClass: "bg-cat-music text-white",
    textClass: "text-cat-music",
    dotClass: "bg-cat-music",
    defaultImage: "/defaults/happenings/music.webp",
  },
  nightlife: {
    label: "Nightlife",
    icon: "nightlife",
    badgeClass: "bg-cat-nightlife text-white",
    textClass: "text-cat-nightlife",
    dotClass: "bg-cat-nightlife",
    defaultImage: "/defaults/happenings/nightlife.webp",
  },
  festival: {
    label: "Festival",
    icon: "festival",
    badgeClass: "bg-cat-festival text-white",
    textClass: "text-cat-festival",
    dotClass: "bg-cat-festival",
    defaultImage: "/defaults/happenings/festival.webp",
  },
  arts: {
    label: "Arts",
    icon: "palette",
    badgeClass: "bg-cat-arts text-white",
    textClass: "text-cat-arts",
    dotClass: "bg-cat-arts",
    defaultImage: "/defaults/happenings/arts.webp",
  },
  comedy: {
    label: "Comedy",
    icon: "theater_comedy",
    badgeClass: "bg-cat-comedy text-white",
    textClass: "text-cat-comedy",
    dotClass: "bg-cat-comedy",
    defaultImage: "/defaults/happenings/comedy.webp",
  },
  sports: {
    label: "Sports",
    icon: "sports_soccer",
    badgeClass: "bg-cat-sports text-white",
    textClass: "text-cat-sports",
    dotClass: "bg-cat-sports",
    defaultImage: "/defaults/happenings/sports.webp",
  },
  food: {
    label: "Food & drink",
    icon: "restaurant",
    badgeClass: "bg-cat-food text-white",
    textClass: "text-cat-food",
    dotClass: "bg-cat-food",
    defaultImage: "/defaults/happenings/food.webp",
  },
  family: {
    label: "Family",
    icon: "family_restroom",
    badgeClass: "bg-cat-family text-white",
    textClass: "text-cat-family",
    dotClass: "bg-cat-family",
    defaultImage: "/defaults/happenings/family.webp",
  },
  museum: {
    label: "Museum",
    icon: "museum",
    badgeClass: "bg-cat-museum text-white",
    textClass: "text-cat-museum",
    dotClass: "bg-cat-museum",
    defaultImage: "/defaults/happenings/museum.webp",
  },
  cinema: {
    label: "Cinema",
    icon: "movie",
    badgeClass: "bg-cat-cinema text-white",
    textClass: "text-cat-cinema",
    dotClass: "bg-cat-cinema",
    defaultImage: "/defaults/happenings/cinema.webp",
  },
  other: {
    label: "Other",
    icon: "category",
    badgeClass: "bg-cat-other text-white",
    textClass: "text-cat-other",
    dotClass: "bg-cat-other",
    defaultImage: "/defaults/happenings/other.webp",
  },
  wellness: {
    label: "Wellness",
    icon: "spa",
    badgeClass: "bg-cat-wellness text-white",
    textClass: "text-cat-wellness",
    dotClass: "bg-cat-wellness",
    defaultImage: "/defaults/happenings/wellness.webp",
  },
  outdoors: {
    label: "Outdoors",
    icon: "hiking",
    badgeClass: "bg-cat-outdoors text-white",
    textClass: "text-cat-outdoors",
    dotClass: "bg-cat-outdoors",
    defaultImage: "/defaults/happenings/outdoors.webp",
  },
  tours: {
    label: "Tours",
    icon: "tour",
    badgeClass: "bg-cat-tours text-white",
    textClass: "text-cat-tours",
    dotClass: "bg-cat-tours",
    defaultImage: "/defaults/happenings/tours.webp",
  },
};

/** Falls back to "other" for a null category — every happening still gets a colour/icon/default image rather than reverting to plain navy. */
export function categoryStyle(category: HappeningCategory | null | undefined): CategoryStyle {
  return category ? CATEGORY_STYLE[category] : CATEGORY_STYLE.other;
}

/** The bundled local default image for a category — last-resort fallback after `image_url` and (where resolved) a linked place's own photo. */
export function categoryDefaultImage(category: HappeningCategory | null | undefined): string {
  return categoryStyle(category).defaultImage;
}

// ---------------------------------------------------------------------------
// Kind badge (deal / free_access / festival / activity / tour / event)
// ---------------------------------------------------------------------------

export interface KindStyle {
  label: string;
  className: string;
}

/** Small badge style per `Happening.kind` — distinct from the category accent above (kind is "what shape of offer is this", category is "what's it about"). Colours deliberately reuse the app's own M3 tokens rather than the categorical palette, since there are only six kinds and they read more like a status than a topic. */
export const KIND_STYLE: Record<HappeningKind, KindStyle> = {
  deal: { label: "Deal", className: "bg-primary-container text-on-primary-container" },
  free_access: { label: "Free", className: "bg-secondary-container text-on-secondary-container" },
  festival: { label: "Festival", className: "bg-cat-festival text-white" },
  activity: { label: "Activity", className: "bg-cat-sports text-white" },
  tour: { label: "Tour", className: "bg-cat-tours text-white" },
  event: { label: "Event", className: "bg-cat-cinema text-white" },
};

export function kindStyle(kind: HappeningKind): KindStyle {
  return KIND_STYLE[kind];
}
