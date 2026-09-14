/**
 * Fomo Explore — neighbourhood quick-jump chips.
 *
 * Hardcoded centre/zoom per the task brief (no geocoding round trip needed
 * for ten fixed, well-known Edinburgh areas) — tapping one flies the map
 * there and narrows the results list to within `NEIGHBOURHOOD_RADIUS_KM` of
 * its centre. That narrowing happens client-side, over whatever pins
 * /api/explore already returned (lib/geo.ts's `distanceKm`), rather than as
 * a server query param — the pin set is already small (capped at 300) and a
 * radius filter is a cheap client-side pass, so there's no need to teach the
 * route a second area-filtering shape alongside `bbox`.
 */
import type { Coordinates } from "@/lib/geo";

export interface Neighbourhood {
  slug: string;
  label: string;
  center: Coordinates;
  /** Mapbox zoom level to fly to. */
  zoom: number;
}

/** ~1km — a walkable "you are basically standing in this neighbourhood" radius. */
export const NEIGHBOURHOOD_RADIUS_KM = 1;

export const NEIGHBOURHOODS: Neighbourhood[] = [
  { slug: "old-town", label: "Old Town", center: { lat: 55.9486, lng: -3.1907 }, zoom: 15 },
  { slug: "new-town", label: "New Town", center: { lat: 55.9560, lng: -3.1970 }, zoom: 15 },
  { slug: "leith", label: "Leith", center: { lat: 55.9750, lng: -3.1700 }, zoom: 14.5 },
  { slug: "stockbridge", label: "Stockbridge", center: { lat: 55.9601, lng: -3.2081 }, zoom: 15 },
  { slug: "bruntsfield-marchmont", label: "Bruntsfield & Marchmont", center: { lat: 55.9370, lng: -3.1990 }, zoom: 15 },
  { slug: "southside", label: "Southside", center: { lat: 55.9400, lng: -3.1830 }, zoom: 15 },
  { slug: "west-end", label: "West End", center: { lat: 55.9490, lng: -3.2130 }, zoom: 15 },
  { slug: "dean-village", label: "Dean Village", center: { lat: 55.9520, lng: -3.2200 }, zoom: 15.5 },
  { slug: "portobello", label: "Portobello", center: { lat: 55.9520, lng: -3.1150 }, zoom: 14.5 },
  { slug: "morningside", label: "Morningside", center: { lat: 55.9290, lng: -3.2070 }, zoom: 15 },
];

export function findNeighbourhood(slug: string | null): Neighbourhood | null {
  if (!slug) return null;
  return NEIGHBOURHOODS.find((n) => n.slug === slug) ?? null;
}
