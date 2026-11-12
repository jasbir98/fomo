/**
 * The cards on the This weekend page, shared by the page's client component
 * (built from the two feed windows it fetches) and its server component
 * (built from the same two windows at render time for the first paint).
 *
 * The feed's two date windows are disjoint (`now` = the rest of today,
 * `coming_up` = tomorrow onwards), so on Fri-Sun the weekend straddles both.
 * Merge them, dedupe, and keep cards on this Saturday or Sunday.
 *
 * Pure and not `server-only`: the client component imports it too.
 */
import { cardDayDate, cardOnDay } from "@/lib/happenings/card-days";
import { DEDUPE_MAX_START_GAP_MS, isSameVenue, isTitleMatchAtVenue } from "@/lib/happenings/merge-events";
import type { FeedCardData, FeedResponse } from "@/lib/happenings/feed-types";

export function weekendCardKey(card: FeedCardData): string {
  if (card.kind === "happening") return `happening-${card.happening.id}`;
  if (card.kind === "series") return `series-${card.key}`;
  if (card.kind === "recurring") return `recurring-${card.key}`;
  return `event-${card.event.id}`;
}

/** `keep` filters before same-night duplicates are collapsed, so a card a page drops (an adult listing on the kids page) never absorbs its twin that the page keeps. */
export function weekendCards(
  now: FeedResponse,
  later: FeedResponse,
  saturday: string,
  sunday: string,
  keep?: (card: FeedCardData) => boolean,
): FeedCardData[] {
  const seen = new Set<string>();
  const out: FeedCardData[] = [];
  for (const card of [...(now.whatsOn[0]?.cards ?? []), ...(later.whatsOn[0]?.cards ?? [])]) {
    const key = weekendCardKey(card);
    if (seen.has(key) || !(cardOnDay(card, saturday) || cardOnDay(card, sunday))) continue;
    if (keep && !keep(card)) continue;
    seen.add(key);
    out.push(card);
  }
  return collapseSameVenueDuplicates(out);
}

/** How many deals and offers are running: standalone deals plus every offer inside a venue group. */
export function countDeals(deals: FeedResponse["deals"]): number {
  return deals.singles.length + deals.venueGroups.reduce((n, g) => n + g.offers.length, 0);
}

/** What the server hands the This weekend page for its first paint. */
export interface WeekendInitial {
  saturday: string;
  sunday: string;
  cards: FeedCardData[];
  dealCount: number | null;
}

/** A card's venue and start, when it is a single listing (not a series or a recurring run). */
function singleListing(card: FeedCardData): { title: string; venue: string | null; startsAt: string | null; hasImage: boolean } | null {
  if (card.kind === "event") {
    return { title: card.event.name, venue: card.event.venue_name, startsAt: card.event.starts_at, hasImage: Boolean(card.event.image_url) };
  }
  if (card.kind === "happening") {
    return { title: card.happening.title, venue: card.happening.venue_name, startsAt: card.occurrence.startsAt, hasImage: Boolean(card.happening.image_url) };
  }
  return null;
}

/** A start stored as bare midnight UTC is a date with no time. */
const DATE_ONLY_START = /T00:00:00(?:\.0+)?(?:Z|\+00:00)$/;

/**
 * Collapses the same night listed twice: two single cards on the same day at
 * the same venue whose titles are one event ("Big Cheese Student Club Night"
 * and "Big Cheese" at Potterrow). Uses merge-events.ts's venue-aware title
 * match, which needs the titles to be the same bar descriptor words, one
 * wholly inside the other, or near-identical; two different events at one
 * venue are never merged. Two listings with real start times more than
 * `DEDUPE_MAX_START_GAP_MS` apart stay separate (a matinee and an evening
 * show). The copy with a photo wins; otherwise the first. Series and recurring
 * cards pass through untouched. Order is kept.
 */
export function collapseSameVenueDuplicates(cards: readonly FeedCardData[]): FeedCardData[] {
  const out: FeedCardData[] = [];
  for (const card of cards) {
    const a = singleListing(card);
    const idx = a
      ? out.findIndex((other) => {
          const b = singleListing(other);
          if (!b || cardDayDate(card) !== cardDayDate(other)) return false;
          if (!isSameVenue(a.venue, b.venue) || !isTitleMatchAtVenue(a.title, a.venue, b.title, b.venue)) return false;
          if (a.startsAt && b.startsAt && !DATE_ONLY_START.test(a.startsAt) && !DATE_ONLY_START.test(b.startsAt)) {
            return Math.abs(Date.parse(a.startsAt) - Date.parse(b.startsAt)) <= DEDUPE_MAX_START_GAP_MS;
          }
          return true;
        })
      : -1;
    if (idx === -1) {
      out.push(card);
      continue;
    }
    const kept = singleListing(out[idx]);
    if (a && kept && a.hasImage && !kept.hasImage) out[idx] = card;
  }
  return out;
}
