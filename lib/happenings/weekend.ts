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
import { cardOnDay } from "@/lib/happenings/card-days";
import type { FeedCardData, FeedResponse } from "@/lib/happenings/feed-types";

export function weekendCardKey(card: FeedCardData): string {
  if (card.kind === "happening") return `happening-${card.happening.id}`;
  if (card.kind === "series") return `series-${card.key}`;
  if (card.kind === "recurring") return `recurring-${card.key}`;
  return `event-${card.event.id}`;
}

export function weekendCards(now: FeedResponse, later: FeedResponse, saturday: string, sunday: string): FeedCardData[] {
  const seen = new Set<string>();
  const out: FeedCardData[] = [];
  for (const card of [...(now.whatsOn[0]?.cards ?? []), ...(later.whatsOn[0]?.cards ?? [])]) {
    const key = weekendCardKey(card);
    if (seen.has(key) || !(cardOnDay(card, saturday) || cardOnDay(card, sunday))) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
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
