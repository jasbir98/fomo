/**
 * Fomo Explore — "Collections" rail presets.
 *
 * Each card applies a layer + optional category filter (+ a couple of
 * collection-specific narrowings that don't fit the general chip model) and
 * scrolls the page to the map, per the task brief. Kept as data rather than
 * one-off handlers so the rail is a plain `.map()` over this list.
 */
import type { ExploreLayer } from "@/lib/explore/types";
import type { ExploreCategorySlug } from "@/lib/explore/categories";

export interface ExploreCollection {
  slug: string;
  label: string;
  icon: string;
  layer: ExploreLayer;
  /** OR'd together — a pin need only match one. Omitted = no category narrowing. */
  categories?: ExploreCategorySlug[];
  /** Place pins only: `price_level <= this`. Google's 0-4 scale — 1 is "inexpensive". */
  maxPriceLevel?: number;
  /** Client-side result-list sort to apply once pins are back. */
  sort?: "distance" | "rating";
  /** Narrows the Events layer to Saturday/Sunday occurrences only (client-side, see the page's `isWeekend` check). */
  weekendOnly?: boolean;
  /** This is the one card the Explore page promotes to the front of the rail when /api/weather reports rain — see the page's own rain check, not this file (this module has no `server-only` and must stay a plain data list). */
  rainPick?: boolean;
}

export const EXPLORE_COLLECTIONS: ExploreCollection[] = [
  {
    slug: "free-museums",
    label: "Free museums",
    icon: "museum",
    layer: "free",
    categories: ["museums_galleries"],
  },
  {
    slug: "rainy-day-ideas",
    label: "Rainy-day ideas",
    icon: "umbrella",
    layer: "places",
    categories: ["museums_galleries", "culture", "shopping", "cafes"],
    rainPick: true,
  },
  {
    slug: "cheap-eats",
    label: "Cheap eats",
    icon: "lunch_dining",
    layer: "places",
    categories: ["food_drink", "cafes"],
    maxPriceLevel: 1,
  },
  {
    slug: "best-viewpoints",
    label: "Best viewpoints",
    icon: "landscape",
    layer: "places",
    categories: ["parks_views"],
    sort: "rating",
  },
  {
    slug: "deals-near-you",
    label: "Deals near you",
    icon: "sell",
    layer: "deals",
    sort: "distance",
  },
  {
    slug: "this-weekend",
    label: "This weekend",
    icon: "weekend",
    layer: "events",
    weekendOnly: true,
  },
];
