/**
 * Pure helpers over approved "Under the radar" picks: validate what the
 * database returned, pick this week's featured one, order the rest.
 */
import type { Place } from "@/lib/types";
import { currentWeekStart } from "@/lib/radar/week";
import type { RadarPick } from "@/lib/radar/types";

/** A place counts as a pick only with both the approval stamp and a reason line. */
export function isRadarPick(place: Place): place is RadarPick {
  return Boolean(place.radar_picked_at) && typeof place.radar_why === "string" && place.radar_why.trim().length > 0;
}

/** Approved picks only, newest approval first, then name, then id, so the order is stable. */
export function orderPicks(places: readonly Place[]): RadarPick[] {
  return places
    .filter(isRadarPick)
    .sort(
      (a, b) =>
        b.radar_picked_at.localeCompare(a.radar_picked_at) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.id.localeCompare(b.id)
    );
}

/** The pick featured for the week containing `now`, or null. */
export function featuredPick(picks: readonly RadarPick[], now: Date): RadarPick | null {
  const week = currentWeekStart(now);
  return picks.find((p) => p.radar_featured_week === week) ?? null;
}

/** This week's featured pick first (if any), then the rest in `orderPicks` order. */
export function featuredFirst(picks: readonly RadarPick[], now: Date): RadarPick[] {
  const featured = featuredPick(picks, now);
  return featured ? [featured, ...picks.filter((p) => p.id !== featured.id)] : [...picks];
}
