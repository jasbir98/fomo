/**
 * Flattens feed responses into the one card list the "For you" engine reads
 * (lib/personalise/for-you.ts `buildForYou`): each window's What's on cards,
 * its Any day cards, and every deal (the singles plus every venue group's
 * offers). Pure and client-safe, shared by the /for-you server page (first
 * paint) and FindsClient (the live `feed:now` / `feed:coming_up` cache entries).
 *
 * The engine only looks MORE_DAYS ahead, so `trimForYouCards` drops the rest on
 * the server: the `coming_up` window runs ~90 days and would otherwise ship
 * hundreds of full happening rows to a page that shows ten.
 */
import { cardDayDate } from "@/lib/happenings/card-days";
import type { DealCardData, FeedCardData, FeedResponse } from "@/lib/happenings/feed-types";
import { addDays, localDayDate } from "@/lib/happenings/occurrence";
import { MORE_DAYS } from "@/lib/personalise/for-you";

export type ForYouCard = FeedCardData | DealCardData;

export function forYouCards(responses: readonly (FeedResponse | null | undefined)[]): ForYouCard[] {
  const out: ForYouCard[] = [];
  for (const res of responses) {
    if (!res) continue;
    // `whatsOn` is a single bucket per window (feed-types.ts); `[0]` is all of it.
    out.push(...(res.whatsOn[0]?.cards ?? []), ...(res.anyDay?.cards ?? []));
    out.push(...res.deals.singles);
    for (const group of res.deals.venueGroups) out.push(...group.offers);
  }
  return out;
}

/** Keeps only the cards the engine could use (today + MORE_DAYS - 1 days). */
export function trimForYouCards(cards: readonly ForYouCard[], now: Date = new Date()): ForYouCard[] {
  const lastDay = addDays(localDayDate(now), MORE_DAYS - 1);
  return cards.filter((card) => cardDayDate(card as FeedCardData) <= lastDay);
}
