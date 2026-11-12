/**
 * Section selection for the /kids landing page (app/(shell)/kids/page.tsx).
 *
 * Everything here is pure: it takes the two feed windows the server already
 * loaded (`now` = the rest of today, `coming_up` = tomorrow onwards) and picks
 * the kid-friendly slice of each. "Kid-friendly" is always asked through
 * lib/happenings/family.ts — never by reading category/eligibility directly.
 *
 * A section with nothing in it comes back empty and the page hides it, so thin
 * data (the `family_fit` column isn't in prod yet) never leaves an empty heading.
 */
import { cardDayDate, cardOnDay } from "@/lib/happenings/card-days";
import { familyFitForHappening, isKidFriendly } from "@/lib/happenings/family";
import type {
  DealCardData,
  FeedCardData,
  FeedResponse,
  FreeAnyTimeItem,
  HappeningCardData,
} from "@/lib/happenings/feed-types";
import { addDays } from "@/lib/happenings/occurrence";
import { weekendCardKey, weekendCards } from "@/lib/happenings/weekend";

/** Items shown per section; "See all" links carry the rest. */
export const KIDS_SECTION_MAX = 12;

/** How far "Coming up" looks ahead — long enough to reach the next school holiday week. */
export const COMING_UP_DAYS = 31;

export interface KidsSections {
  /** Kid-friendly cards on this Saturday or Sunday. */
  weekend: FeedCardData[];
  /** Kids-go-free / kids-eat-free and other kid-friendly deals, as happening cards. */
  deals: HappeningCardData[];
  /** Free any-time places and things with a family fit (museums, parks, playparks). */
  freeAnyTime: FreeAnyTimeItem[];
  /** Kid-friendly dated cards after this weekend, within COMING_UP_DAYS. */
  comingUp: FeedCardData[];
  /** Full counts before the per-section cap, for "See all N" buttons. */
  totals: { weekend: number; deals: number; freeAnyTime: number; comingUp: number };
}

/** Every deal in the feed as a plain happening card, each happening once. */
export function flattenDeals(deals: FeedResponse["deals"] | null | undefined): DealCardData[] {
  if (!deals) return [];
  const seen = new Set<string>();
  const out: DealCardData[] = [];
  for (const d of [...deals.venueGroups.flatMap((g) => g.offers), ...deals.singles]) {
    if (seen.has(d.happening.id)) continue;
    seen.add(d.happening.id);
    out.push(d);
  }
  return out;
}

/**
 * Kid-friendly deals, most relevant first: offers only a family can use
 * (eligibility `family`: "kids eat free") ahead of merely kid-friendly ones,
 * then soonest occurrence, then title for a stable order.
 */
export function kidsDeals(deals: FeedResponse["deals"] | null | undefined): HappeningCardData[] {
  return flattenDeals(deals)
    .filter((d) => d.who === "families" || d.happening.eligibility === "family" || familyFitForHappening(d.happening) !== null)
    .sort((a, b) => {
      const aFamily = a.happening.eligibility === "family" || a.who === "families" ? 0 : 1;
      const bFamily = b.happening.eligibility === "family" || b.who === "families" ? 0 : 1;
      if (aFamily !== bFamily) return aFamily - bFamily;
      if (a.occurrence.dayDate !== b.occurrence.dayDate) return a.occurrence.dayDate < b.occurrence.dayDate ? -1 : 1;
      return a.happening.title.localeCompare(b.happening.title);
    })
    .map((d) => ({ kind: "happening", happening: d.happening, occurrence: d.occurrence }));
}

/** Free any-time items with a family fit; ones aimed at children first, feed order otherwise. */
export function kidsFreeAnyTime(items: FreeAnyTimeItem[] | null | undefined): FreeAnyTimeItem[] {
  const fit = (items ?? []).filter((i) => (i.familyFit ?? null) !== null);
  return [...fit.filter((i) => i.familyFit === "kids"), ...fit.filter((i) => i.familyFit !== "kids")];
}

/**
 * Kid-friendly dated cards after this weekend. Takes today's remaining cards
 * first, then everything from tomorrow on, keeps those inside the lookahead and
 * not already on the weekend list, each card once, in date order.
 */
export function kidsComingUp(
  now: FeedResponse,
  later: FeedResponse,
  today: string,
  saturday: string,
  sunday: string,
  days: number = COMING_UP_DAYS,
): FeedCardData[] {
  const lastDay = addDays(today, days);
  const seen = new Set<string>();
  const out: FeedCardData[] = [];
  for (const card of [...(now.whatsOn[0]?.cards ?? []), ...(later.whatsOn[0]?.cards ?? [])]) {
    if (!isKidFriendly(card)) continue;
    const key = weekendCardKey(card);
    if (seen.has(key)) continue;
    seen.add(key);
    if (cardOnDay(card, saturday) || cardOnDay(card, sunday)) continue;
    if (cardDayDate(card) > lastDay) continue;
    out.push(card);
  }
  return out.sort((a, b) => (cardDayDate(a) < cardDayDate(b) ? -1 : cardDayDate(a) > cardDayDate(b) ? 1 : 0));
}

export function selectKidsSections(
  now: FeedResponse,
  later: FeedResponse,
  today: string,
  saturday: string,
  sunday: string,
  max: number = KIDS_SECTION_MAX,
): KidsSections {
  const weekend = weekendCards(now, later, saturday, sunday, isKidFriendly);
  const deals = kidsDeals(later.deals ?? now.deals);
  const freeAnyTime = kidsFreeAnyTime(now.freeAnyTime);
  const comingUp = kidsComingUp(now, later, today, saturday, sunday);
  return {
    weekend: weekend.slice(0, max),
    deals: deals.slice(0, max),
    freeAnyTime: freeAnyTime.slice(0, max),
    comingUp: comingUp.slice(0, max),
    totals: { weekend: weekend.length, deals: deals.length, freeAnyTime: freeAnyTime.length, comingUp: comingUp.length },
  };
}
