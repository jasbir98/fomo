/**
 * Fomo Happenings — recurring-listing collapse for What's on.
 *
 * A single real show/exhibition/club night regularly turns up in the feed as
 * SEVERAL separate `happening`/`event` rows, one per date — a weekly
 * Ticketmaster/Skiddle listing ("The Comedy Cellar Edinburgh Live Stand-Up
 * Comedy" at The Canons Gait, live 46 times in the current `coming_up`
 * catalog) or a per-date-entered exhibition. Each one is a genuinely
 * separate row with its own id/booking link — nextOccurrence/dedupeProvider-
 * Events don't touch this, they only ever pick ONE occurrence per row or
 * collapse same-DAY duplicates — so without this pass the same thing floods
 * the list once per date.
 *
 * NOT the same problem as lib/happenings/series.ts: a series is one thing at
 * several different LOCATIONS (the three parkruns) that stays several
 * distinct rows even after collapsing, one lead standing in for all. This is
 * one thing at the SAME location on several different DATES, collapsed into
 * one card that names its next date plus a count ("Tue 29 Sep + 3 more
 * dates" — see components/happenings/FeedListCard.tsx's `RecurringRow`).
 *
 * MATCH RULE — deliberately EXACT, not fuzzy, unlike merge-events.ts's
 * provider/curated dedupe: exact normalised title (lib/happenings/
 * merge-events.ts's `normalizeText`) AND the same venue (`place_id` when a
 * happening has one, else normalised `venue_name`), AND the same card kind
 * ("happening" only ever groups with "happening", "event" with "event" —
 * never mixed, since a same-day happening/event pair is already merged by
 * mergeProviderEventsIntoCards before this ever runs). A near-miss title
 * ("Line Dance Class" vs "Line Dance Class - Intermediate Level" — two
 * genuinely different classes in the live catalog) must never merge, so
 * there's no Jaccard/containment threshold here at all, just equality —
 * the task's own "Never merge different shows" rule taken literally. `series`
 * cards and `deal`/`festival`-kind happenings are never eligible (deals are
 * grouped by venue separately — see groups.ts/buildDealsSection; a festival
 * renders as the wide civic banner, not a per-date repeat pattern).
 *
 * ORDER: run this AFTER the caller's own ranking/chronological sort, over
 * that already-ordered list. Grouping is a stable first-occurrence pass —
 * a group lands at whichever position its FIRST (earliest, best-ranked)
 * member already had, and every later member's slot is simply dropped —
 * so nothing needs to be resorted afterwards.
 */
import { normalizeText } from "@/lib/happenings/merge-events";
import { localDayDate } from "@/lib/happenings/occurrence";
import type { EventCardData, FeedCardData, HappeningCardData, RecurringCardData } from "@/lib/happenings/feed-types";

type RecurringEligibleCard = HappeningCardData | EventCardData;

function isEligible(card: FeedCardData): card is RecurringEligibleCard {
  if (card.kind === "series" || card.kind === "recurring") return false;
  if (card.kind === "happening" && (card.happening.kind === "festival" || card.happening.kind === "deal")) return false;
  return true;
}

function titleOf(card: RecurringEligibleCard): string {
  return card.kind === "happening" ? card.happening.title : card.event.name;
}

/** `place_id` when a happening has one (the strongest signal); otherwise a
 *  normalised `venue_name` for either card kind. `null` when neither is
 *  available — a card with no resolvable venue never groups with anything,
 *  matching the task's own "same venue" requirement (no venue, no group). */
function venueKeyOf(card: RecurringEligibleCard): string | null {
  if (card.kind === "happening") {
    if (card.happening.place_id) return `place:${card.happening.place_id}`;
    return card.happening.venue_name ? `venue:${normalizeText(card.happening.venue_name)}` : null;
  }
  return card.event.venue_name ? `venue:${normalizeText(card.event.venue_name)}` : null;
}

function dayDateOf(card: RecurringEligibleCard, timeZone: string): string {
  return card.kind === "happening" ? card.occurrence.dayDate : localDayDate(new Date(card.event.starts_at), timeZone);
}

/** `kind|normalised title|venue key`, or `null` when the card isn't a
 *  grouping candidate at all (wrong kind, or no title/venue to key on). */
function groupKeyOf(card: FeedCardData): string | null {
  if (!isEligible(card)) return null;
  const title = normalizeText(titleOf(card));
  const venueKey = venueKeyOf(card);
  if (!title || !venueKey) return null;
  return `${card.kind}|${title}|${venueKey}`;
}

function buildRecurringCard(key: string, members: RecurringEligibleCard[], timeZone: string): RecurringCardData {
  const sorted = [...members].sort((a, b) => dayDateOf(a, timeZone).localeCompare(dayDateOf(b, timeZone)));
  const lead = sorted[0];
  const dates = Array.from(new Set(sorted.map((m) => dayDateOf(m, timeZone)))).sort();
  return { kind: "recurring", key, title: titleOf(lead), lead, dates };
}

/**
 * Collapses `cards` (already ranked/sorted by the caller) into recurring
 * groups where 2+ members share a `groupKeyOf` key. Every other card passes
 * through unchanged, in its original position.
 */
export function groupRecurringCards(cards: FeedCardData[], timeZone: string): FeedCardData[] {
  const keys = cards.map(groupKeyOf);
  const counts = new Map<string, number>();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);

  const result: FeedCardData[] = [];
  const firstIndexOfKey = new Map<string, number>();
  const membersByKey = new Map<string, RecurringEligibleCard[]>();

  cards.forEach((card, i) => {
    const key = keys[i];
    if (!key || (counts.get(key) ?? 0) < 2) {
      result.push(card);
      return;
    }
    if (!membersByKey.has(key)) {
      membersByKey.set(key, []);
      firstIndexOfKey.set(key, result.length);
      result.push(card); // placeholder — replaced below once every member is collected
    }
    membersByKey.get(key)!.push(card as RecurringEligibleCard);
  });

  for (const [key, members] of membersByKey) {
    result[firstIndexOfKey.get(key)!] = buildRecurringCard(key, members, timeZone);
  }

  return result;
}
