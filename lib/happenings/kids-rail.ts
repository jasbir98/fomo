/**
 * Home's "Out with the kids" rail: the kid-friendly cards on today and this
 * weekend, photo-led first, for a visitor who said "I've got kids"
 * (lib/personalise/usePrefs.ts). Pure and not `server-only`; Home calls it
 * client-side because the pref only exists in the browser.
 */
import { cardOnDay } from "@/lib/happenings/card-days";
import { isKidFriendly } from "@/lib/happenings/family";
import type { FeedCardData, FeedResponse } from "@/lib/happenings/feed-types";
import type { DealWhoGroup } from "@/lib/happenings/groups";
import { leadWithPhotos } from "@/lib/happenings/hero";
import { weekendCardKey } from "@/lib/happenings/weekend";
import { CITY } from "@/lib/city";

/** Most cards on the rail. */
export const KIDS_RAIL_MAX = 10;
/** Fewer than this and the rail is not worth a heading, so Home hides it. */
export const KIDS_RAIL_MIN = 3;

/**
 * `now` is the Today window's feed, `later` the Coming up one (undefined until
 * it loads; the weekend then falls back to whatever Today holds). Today's
 * dated cards, then the weekend's, then the always-on (Any day) ones, each kept
 * only when kid-friendly and counted once; the best photo-led cards lead (the
 * same `leadWithPhotos` order Home's What's on uses). Capped at KIDS_RAIL_MAX.
 */
export function kidsRailCards(
  now: FeedResponse | null | undefined,
  later: FeedResponse | null | undefined,
  weekend: { saturday: string; sunday: string },
  who: readonly DealWhoGroup[] = [],
  at: Date = new Date(),
  timeZone: string = CITY.timezone
): FeedCardData[] {
  if (!now) return [];
  const seen = new Set<string>();
  const pool: FeedCardData[] = [];
  const add = (card: FeedCardData) => {
    const key = weekendCardKey(card);
    if (seen.has(key) || !isKidFriendly(card)) return;
    seen.add(key);
    pool.push(card);
  };
  const todayCards = now.whatsOn[0]?.cards ?? [];
  todayCards.forEach(add);
  for (const card of [...todayCards, ...(later?.whatsOn[0]?.cards ?? [])]) {
    if (cardOnDay(card, weekend.saturday) || cardOnDay(card, weekend.sunday)) add(card);
  }
  (now.anyDay?.cards ?? []).forEach(add);
  return leadWithPhotos(pool, at, timeZone, who, KIDS_RAIL_MAX).slice(0, KIDS_RAIL_MAX);
}
