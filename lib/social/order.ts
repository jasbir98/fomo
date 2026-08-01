// Ordering helpers for reel feeds. The scraper often returns several reels of
// the *same* spot (multiple creators filming one shrine / cafe), and a plain
// likes-desc sort clusters them together — so both the home carousel and the
// swipe stack showed the same place over and over in a row. These helpers
// group by place and spread the groups out.
import type { SocialPost } from "@/lib/types";

/**
 * Stable grouping key for "which spot is this reel about". Prefers the
 * explicit place_id, then a normalized location string; reels with neither
 * fall back to their own id so they stay independent (never merged by
 * accident with an unrelated reel).
 */
export function reelPlaceKey(reel: SocialPost): string {
  if (reel.place_id) return `place:${reel.place_id}`;
  const location = reel.location?.trim().toLowerCase();
  // A location that is just the destination ("Tokyo" on a Tokyo trip) says
  // nothing about *which* spot the reel shows — grouping on it would merge
  // unrelated reels and hide all but one of them from the carousel.
  if (location && !isGenericLocation(location, reel.destination)) {
    return `loc:${location}`;
  }
  return `reel:${reel.id}`;
}

/** True when `location` is just the trip destination (or its city segment). */
function isGenericLocation(location: string, destination: string | null): boolean {
  const dest = destination?.trim().toLowerCase();
  if (!dest) return false;
  return dest === location || dest.startsWith(`${location},`);
}

/** Groups reels by place key, preserving the incoming (likes-desc) order. */
function groupByPlace<T extends SocialPost>(reels: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const reel of reels) {
    const key = reelPlaceKey(reel);
    const bucket = groups.get(key);
    if (bucket) bucket.push(reel);
    else groups.set(key, [reel]);
  }
  return Array.from(groups.values());
}

/**
 * Round-robins one reel per place before returning to a place's second reel.
 * Groups keep their relative strength (the incoming order is likes-desc, so
 * the first group is the most-liked spot), and within a group the most-liked
 * reel comes first. Consecutive reels are therefore never from the same place
 * unless only one place still has reels left, which can only happen at the
 * tail of the feed.
 */
export function diversifyReelsByPlace<T extends SocialPost>(reels: T[]): T[] {
  const groups = groupByPlace(reels);
  if (groups.length <= 1) return reels;

  const out: T[] = [];
  for (let round = 0; out.length < reels.length; round++) {
    for (const group of groups) {
      if (round < group.length) out.push(group[round]);
    }
  }
  return out;
}

/**
 * One reel per place — the most-liked one. For summary surfaces (the home
 * "Trending on Social" carousel) where repeats of a spot are pure noise.
 */
export function oneReelPerPlace<T extends SocialPost>(reels: T[]): T[] {
  return groupByPlace(reels).map((group) => group[0]);
}
