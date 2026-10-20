/**
 * The "For you" tab's recommendations (docs/plans/2026-10-12-fomo-finds.md).
 *
 * The page shows two groups, Deals & offers (`kind: "deal"`, as on the
 * Deals tab) and Events (everything else), each with its own two lists,
 * built from what the page already has: the live Finds (the
 * hand-approved weekly steals, lib/finds/*) and the feed's own cards (What's
 * on, Any day and every deal, from both feed windows).
 *
 *  - `picks`: every live Find, re-ranked for this visitor. The editorial
 *    Fomo level still leads; the visitor's taste (lib/personalise/score.ts's
 *    `personalBoost`) can lift a Find past one level but never two, and an offer the visitor
 *    can't use (a student price for someone who said they work) drops to
 *    the bottom. Nothing is hidden: there are only ~12 Finds and they are
 *    the point of the tab.
 *  - `more`: up to MORE_LIMIT non-Find cards per group in the next MORE_DAYS days.
 *    The base is the Home hero's recommendation score (lib/happenings/hero.ts)
 *    so a weak card never wins on taste alone; taste is weighted on top.
 *    With prefs or save history, only cards that match them count, topped up
 *    from the best of the rest when fewer than MORE_MIN match. Without any,
 *    the list is the best of the week, titled "Popular this week" so it
 *    doesn't pretend to know the visitor. Offers the visitor can't use are
 *    left out here (it's a recommendation), and no interest fills more than
 *    MAX_PER_INTEREST slots so one taste doesn't take over the list.
 *
 * Every entry carries a short `reason` ("You're into Comedy", "Student
 * offer", "Free") so the recommendation explains itself.
 *
 * Pure and not `server-only`: prefs and save history live in the browser
 * (usePrefs / localStorage), so the page calls this client-side after mount.
 */
import { CITY } from "@/lib/city";
import { cardDayDate } from "@/lib/happenings/card-days";
import { eventRecommendationScore, happeningRecommendationScore } from "@/lib/happenings/hero";
import { addDays, localDayDate, nextOccurrence } from "@/lib/happenings/occurrence";
import type { DealCardData, FeedCardData } from "@/lib/happenings/feed-types";
import type { DealWhoGroup } from "@/lib/happenings/groups";
import type { FindItem } from "@/lib/finds/types";
import type { AffinityMap } from "./affinity";
import { INTEREST_LABEL } from "./interests";
import { cardInterest, cardWho, fitsBudget, kidsBoost, personalBoost, type BoostPrefs } from "./score";

type Card = FeedCardData | DealCardData;

/** Recommendations per group (Deals & offers, Events). */
export const MORE_LIMIT = 6;
/** Below this many taste matches in a group, its `more` is topped up from the best of the rest. */
export const MORE_MIN = 4;
export const MORE_DAYS = 7;
export const MAX_PER_INTEREST = 3;

/** Taste may beat one Fomo level step but never two: an interest match
 *  (boost 4 × 3 = 12) lifts a level-4 comedy Find over a level-5 food Find
 *  for a comedy fan, and the cap keeps a level-3 Find below a level-5 one
 *  however well it matches. */
const FIND_LEVEL_WEIGHT = 10;
const FIND_BOOST_WEIGHT = 3;
const FIND_BOOST_CAP = 15;
/** Enough to sink an unusable Find below every usable one. */
const FIND_INELIGIBLE_PENALTY = 100;
/** Hero scores run roughly 0–100; a full taste match (≤ 12) is worth ~70 on top. */
const MORE_BOOST_WEIGHT = 6;

const WHO_REASON: Record<DealWhoGroup, string> = {
  students: "Student offer",
  residents: "For EH residents",
  under_26: "Under-26 offer",
  over_60: "Over-60 offer",
  families: "Family offer",
};

export interface ForYouEntry {
  /** Stable React key, "happening:<id>" / "event:<id>" / "series:<key>" / "recurring:<key>". */
  key: string;
  card: Card;
  /** Set on `picks` entries only. */
  find: FindItem | null;
  /** Why this visitor sees it; null when nothing is worth saying. */
  reason: string | null;
  score: number;
}

export type ForYouGroupKey = "deals" | "events";

/** One of the page's two groups. Each has its own picks and its own recommendations. */
export interface ForYouGroup {
  key: ForYouGroupKey;
  title: "Deals & offers" | "Events";
  picks: ForYouEntry[];
  more: ForYouEntry[];
}

export interface ForYouResult {
  /** True when the visitor has prefs or save history to personalise from. */
  personalised: boolean;
  /** Deals & offers first, then Events; a group with nothing in it is left out. */
  groups: ForYouGroup[];
  /** Every group's picks, best first. */
  picks: ForYouEntry[];
  /** Every group's recommendations, group by group. */
  more: ForYouEntry[];
  moreTitle: "More for you" | "Popular this week";
}

export interface ForYouInput {
  finds: readonly FindItem[];
  /** Feed cards from both windows, in any order; duplicates are fine. */
  cards: readonly Card[];
  prefs: BoostPrefs;
  affinity: AffinityMap;
  /** The visitor has answered "I'm a…" (or has groups), so an empty
   *  `prefs.who` means "none of these groups", not "unknown". Defaults to
   *  `prefs.who.length > 0`. */
  whoKnown?: boolean;
  now?: Date;
  timeZone?: string;
}

export function hasTaste(prefs: BoostPrefs, affinity: AffinityMap): boolean {
  return (
    prefs.interests.length > 0 ||
    prefs.budget !== "any" ||
    prefs.who.length > 0 ||
    prefs.kids === true ||
    Object.values(affinity).some((n) => (n ?? 0) > 0)
  );
}

/** The subject a card is about, for de-duplicating against Finds and across windows. */
export function subjectKey(card: Card): string {
  if (card.kind === "happening") return `happening:${card.happening.id}`;
  if (card.kind === "event") return `event:${card.event.id}`;
  if (card.kind === "series") return `series:${card.key}`;
  return `recurring:${card.key}`;
}

/** Deals & offers = `kind: "deal"` happenings, the same rows the Deals tab lists; everything else (events, free entry, tours, festivals) is Events. */
export function groupOf(card: Card): ForYouGroupKey {
  if (card.kind === "event") return "events";
  if (card.kind === "series") return card.lead.kind === "deal" ? "deals" : "events";
  if (card.kind === "recurring") return groupOf(card.lead);
  return card.happening.kind === "deal" ? "deals" : "events";
}

/** Subject keys a card covers: a series or recurring card also covers its lead, so a Find's lead isn't shown twice. */
function coveredKeys(card: Card): string[] {
  if (card.kind === "series") return [subjectKey(card), `happening:${card.lead.id}`];
  if (card.kind === "recurring") return [subjectKey(card), subjectKey(card.lead)];
  return [subjectKey(card)];
}

/** An offer only some groups can use, and the visitor told us they're in none of them. An unknown visitor is never ineligible. */
function ineligible(card: Card, prefs: BoostPrefs, whoKnown: boolean): boolean {
  const who = cardWho(card);
  return who !== null && whoKnown && !prefs.who.includes(who);
}

/** The visitor-facing reason, strongest signal first. */
export function personalReason(card: Card, prefs: BoostPrefs, affinity: AffinityMap): string | null {
  const interest = cardInterest(card);
  if (interest && prefs.interests.includes(interest)) return `You're into ${INTEREST_LABEL[interest]}`;
  const who = cardWho(card);
  if (who && prefs.who.includes(who)) return WHO_REASON[who];
  if (prefs.kids && kidsBoost(card) > 0) return "Good with kids";
  if (fitsBudget(card, prefs.budget)) return prefs.budget === "free" ? "Free" : "Under £10";
  if (interest && (affinity[interest] ?? 0) > 0) return "Like things you've saved";
  return null;
}

/** Home hero's score and reason for any card shape; series and recurring cards are scored by their lead. */
function baseScore(card: Card, prefs: BoostPrefs, now: Date, timeZone: string): { score: number; reason: string | null } {
  if (card.kind === "event") return eventRecommendationScore(card.event, now, timeZone);
  if (card.kind === "happening") return happeningRecommendationScore(card.happening, card.occurrence, now, timeZone, prefs.who);
  if (card.kind === "series") return happeningRecommendationScore(card.lead, card.occurrence, now, timeZone, prefs.who);
  return baseScore(card.lead, prefs, now, timeZone);
}

/** A Find as a feed card, so it can go through the same taste checks. Null when a happening has no occurrence left in the next year. */
function findCard(find: FindItem, now: Date, timeZone: string): Card | null {
  if (find.kind === "event") return { kind: "event", event: find.event };
  const occurrence = nextOccurrence(find.happening, now, new Date(now.getTime() + 366 * 86_400_000), timeZone);
  return occurrence ? { kind: "happening", happening: find.happening, occurrence } : null;
}

export function buildForYou({
  finds,
  cards,
  prefs,
  affinity,
  whoKnown = prefs.who.length > 0,
  now = new Date(),
  timeZone = CITY.timezone,
}: ForYouInput): ForYouResult {
  const personalised = hasTaste(prefs, affinity) || whoKnown;

  const picks: ForYouEntry[] = [];
  const findKeys = new Set<string>();
  finds.forEach((find, index) => {
    findKeys.add(`${find.kind}:${find.kind === "event" ? find.event.id : find.happening.id}`);
    const card = findCard(find, now, timeZone);
    if (!card) return;
    const boost = personalBoost(card, prefs, affinity);
    const score =
      find.fomoLevel * FIND_LEVEL_WEIGHT +
      Math.min(boost * FIND_BOOST_WEIGHT, FIND_BOOST_CAP) -
      (ineligible(card, prefs, whoKnown) ? FIND_INELIGIBLE_PENALTY : 0) -
      index / 1000; // keep the API's order on ties
    picks.push({ key: subjectKey(card), card, find, reason: personalReason(card, prefs, affinity), score });
  });
  picks.sort((a, b) => b.score - a.score);

  const lastDay = addDays(localDayDate(now, timeZone), MORE_DAYS - 1);
  const seen = new Set<string>();
  const pool: { entry: ForYouEntry; matches: boolean }[] = [];
  for (const card of cards) {
    const keys = coveredKeys(card);
    if (keys.some((k) => seen.has(k) || findKeys.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    if (cardDayDate(card as FeedCardData) > lastDay || ineligible(card, prefs, whoKnown)) continue;
    const base = baseScore(card, prefs, now, timeZone);
    const boost = personalised ? personalBoost(card, prefs, affinity) : 0;
    pool.push({
      matches: boost > 0,
      entry: {
        key: subjectKey(card),
        card,
        find: null,
        reason: (personalised ? personalReason(card, prefs, affinity) : null) ?? base.reason,
        score: base.score + boost * MORE_BOOST_WEIGHT,
      },
    });
  }
  pool.sort((a, b) => b.entry.score - a.entry.score);

  /** Up to MORE_LIMIT from one group's pool, each interest capped at MAX_PER_INTEREST. */
  const recommend = (groupPool: typeof pool): ForYouEntry[] => {
    const perInterest = new Map<string, number>();
    const out: ForYouEntry[] = [];
    const take = (entries: ForYouEntry[]) => {
      for (const entry of entries) {
        if (out.length >= MORE_LIMIT) return;
        const interest = cardInterest(entry.card) ?? "none";
        const used = perInterest.get(interest) ?? 0;
        if (interest !== "none" && used >= MAX_PER_INTEREST) continue;
        perInterest.set(interest, used + 1);
        out.push(entry);
      }
    };
    if (personalised) {
      take(groupPool.filter((p) => p.matches).map((p) => p.entry));
      if (out.length < MORE_MIN) {
        const taken = new Set(out.map((e) => e.key));
        take(groupPool.filter((p) => !taken.has(p.entry.key)).map((p) => p.entry));
      }
    } else {
      take(groupPool.map((p) => p.entry));
    }
    return out;
  };

  const GROUPS: { key: ForYouGroupKey; title: ForYouGroup["title"] }[] = [
    { key: "deals", title: "Deals & offers" },
    { key: "events", title: "Events" },
  ];
  const groups: ForYouGroup[] = GROUPS.map(({ key, title }) => ({
    key,
    title,
    picks: picks.filter((e) => groupOf(e.card) === key),
    more: recommend(pool.filter((p) => groupOf(p.entry.card) === key)),
  })).filter((g) => g.picks.length > 0 || g.more.length > 0);
  const more = groups.flatMap((g) => g.more);

  return {
    personalised,
    groups,
    picks,
    more,
    moreTitle: personalised ? "More for you" : "Popular this week",
  };
}
