/**
 * Fomo Happenings — "Today's deals" selection.
 *
 * Pure derivation over the `deals` section GET /api/feed already returns
 * (lib/happenings/feed-types.ts's `DealsSection`) — no new API, no schema
 * change. The point of the Home strip this feeds is "give students a reason
 * to open the app every day", so it has to change every day. It used to be a
 * fixed ranking: weekly deals for today's weekday, then dated deals, and
 * standing `always` deals only as a top-up — so the same ~10 deals led every
 * day and most of the catalogue (the `always` deals) never showed at all.
 *
 * Now the strip has two parts. A short lead of deals that are news TODAY
 * (a one-or-two-day weekly offer like "2-for-1 Tuesdays", a dated deal
 * ending within two days, a deal added in the last week), then a daily
 * rotation through every other good deal valid today, so yesterday's cards
 * don't come back tomorrow and the whole pool comes round every week or two.
 * "Good" is lib/happenings/deal-score.ts's `dealStealScore` at or above
 * GOOD_FLOOR, which keeps national chains and 10%-off filler out unless the
 * day is too thin without them.
 *
 * Timezone: every date comparison goes through lib/happenings/occurrence.ts's
 * helpers, which resolve "today" in `timeZone` (default `CITY.timezone`,
 * i.e. Europe/London) — never the visitor's device timezone.
 */
import { CITY } from "@/lib/city";
import {
  daysUntilLastChance,
  happeningHasEnded,
  isActiveNow,
  localDayDate,
  nextOccurrence,
  normalizeRecurrence,
  weekdayOf,
} from "@/lib/happenings/occurrence";
import { dealStealScore } from "@/lib/happenings/deal-score";
import type { Happening } from "@/lib/happenings/types";
import { whoGroupForEligibility, type DealWhoGroup } from "@/lib/happenings/groups";
import { groupDealsByVenue, type RankedDealItem } from "@/lib/happenings/venue-deals";
import type { DealCardData, DealsSection } from "@/lib/happenings/feed-types";

export interface TodaysDealsOptions {
  /** The visitor's own deal-eligibility profile (lib/useSaved.ts's `useSaved().who`) — used only to RANK eligible ("You qualify") deals first within each part, never to hide ineligible ones. */
  who?: readonly DealWhoGroup[];
  timeZone?: string;
  /** Hard cap on the returned list, applied after ranking/top-up. */
  limit?: number;
}

/** Never returned with fewer than this many items — the lead and rotation are topped up with below-floor deals until this many, so the strip never reads as "just one thing". Measured in CARDS before venue-grouping (see `todaysDeals`'s own doc comment on why grouping runs last), matching the pre-grouping topup this always did. */
const TOPUP_TARGET = 3;

/** Below this, the whole strip is pointless (a single card doesn't read as "today's deals") — the caller renders nothing. Measured in rendered ITEMS (post-grouping): a venue's 3 deals collapsed to 1 card still reads fine alongside one more, but a single lone card never does. */
const MIN_RENDER_COUNT = 2;

const DEFAULT_LIMIT = 10;

/** Flattened, NOT grouped — every individual deal card, so the lead/
 *  eligibility ranking below can see and rank each one on its own merits.
 *  Venue grouping happens once, at the very end, over the final ranked
 *  list — see `todaysDeals`'s own doc comment and lib/happenings/
 *  venue-deals.ts's module doc for why re-grouping a pre-grouped section
 *  here would be wrong (this function may only pick SOME of a venue's
 *  deals into today's list, or drop its best offer while keeping a
 *  lower one). */
function dealsList(deals: DealsSection): DealCardData[] {
  return [...deals.venueGroups.flatMap((g) => g.offers), ...deals.singles];
}

function qualifies(card: DealCardData, who: readonly DealWhoGroup[]): boolean {
  const group = whoGroupForEligibility(card.happening.eligibility);
  return group != null && who.includes(group);
}

/** Stable partition — qualifying-first, both halves keeping their relative order — so each part's own ranking survives the eligibility re-sort. */
function rankQualifyingFirst(list: DealCardData[], who: readonly DealWhoGroup[]): DealCardData[] {
  const qualifying: DealCardData[] = [];
  const rest: DealCardData[] = [];
  for (const card of list) (qualifies(card, who) ? qualifying : rest).push(card);
  return [...qualifying, ...rest];
}

/** A dated deal with this many days or fewer left leads the strip ("ends soon"). */
const ENDS_SOON_DAYS = 1;

/** A deal added this many days ago or fewer leads the strip and gets a "New" tag. */
const NEW_DAYS = 3;

/** A weekly deal that runs on this many weekdays or fewer is "today's" news on its days ("2-for-1 Tuesdays"). */
const TODAY_ONLY_MAX_DAYS = 2;

/** At most this many lead cards, so a busy Sunday of one-day offers still leaves room for the rotation. */
const LEAD_MAX = 4;

/** `dealStealScore` at or above this is a good deal: a 2-for-1, a £-ticket, 25%+ off, a local one-day offer. Most 10%-off deals and national chains fall below it. */
export const GOOD_FLOOR = 15;

/** True when the deal was added in the last NEW_DAYS days. */
export function isNewDeal(h: Pick<Happening, "created_at">, at: Date): boolean {
  if (!h.created_at) return false;
  const age = at.getTime() - new Date(h.created_at).getTime();
  return age >= 0 && age <= NEW_DAYS * 86_400_000;
}

/** FNV-1a, 32-bit. Gives each deal a fixed place in the rotation that doesn't depend on its score. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Days since 1970-01-01 for a `YYYY-MM-DD` local day. */
function dayNumber(dayDate: string): number {
  const [y, m, d] = dayDate.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

interface Candidate {
  card: DealCardData;
  score: number;
  endsSoon: boolean;
  lead: boolean;
}

/** Best first: ending soon, then steal score; equal ones keep their input order. */
function ranked(list: Candidate[]): Candidate[] {
  return list
    .map((c, index) => ({ c, index }))
    .sort((a, b) => Number(b.c.endsSoon) - Number(a.c.endsSoon) || b.c.score - a.c.score || a.index - b.index)
    .map((x) => x.c);
}

/**
 * Today's `count` cards out of `pool`. Every deal has one day in each cycle
 * of `cycle` days (its hashed id), so its turn doesn't move when other deals
 * come and go, and two days in a row don't share a card. A day whose turn is
 * short is filled from the turn half a cycle away, which is as far from
 * yesterday and tomorrow as it gets. The turns are reshuffled every cycle,
 * so a deal cut from a crowded day gets another chance next time round.
 */
function rotate(pool: Candidate[], count: number, cycle: number, dayDate: string): Candidate[] {
  if (pool.length <= count) return ranked(pool);
  const day = dayNumber(dayDate);
  const lap = Math.floor(day / cycle);
  const turn = (offset: number) => ranked(pool.filter((c) => hash(`${lap}:${c.card.happening.id}`) % cycle === (day + offset) % cycle));
  const picks = turn(0).slice(0, count);
  for (const c of [...turn(Math.floor(cycle / 2)), ...ranked(pool)]) {
    if (picks.length >= count) break;
    if (!picks.includes(c)) picks.push(c);
  }
  return ranked(picks);
}

/**
 * Deals valid TODAY in `timeZone`, picked and ordered for the Home
 * "Today's deals" strip.
 *
 *  1. Lead (up to LEAD_MAX): good deals that are news today — a weekly deal
 *     on at most TODAY_ONLY_MAX_DAYS weekdays, a dated deal ending within
 *     ENDS_SOON_DAYS days, or one added in the last NEW_DAYS days. Ending
 *     soon first, then by steal score.
 *  2. Rotation: today's turn of every other good deal valid today (see
 *     `rotate`; the cycle is about a tenth of the good deals, in days),
 *     best steal score first.
 *  3. Top-up: when 1 + 2 come to fewer than TOPUP_TARGET, the best of the
 *     below-floor deals fill in, so a thin day still shows something.
 *
 * Within each part, deals the visitor qualifies for ("You qualify") go first
 * without hiding the rest. Capped at `limit` (default 10) BEFORE venue
 * grouping, which runs last so a venue with several deals collapses into one
 * card at its best-ranked offer's position (the "Camera Obscura ×3" bug —
 * see lib/happenings/venue-deals.ts). Returns `[]` when the grouped list
 * would have fewer than MIN_RENDER_COUNT items — the caller hides the strip
 * entirely rather than rendering a token single card.
 */
export function todaysDeals(deals: DealsSection, at: Date, options: TodaysDealsOptions = {}): RankedDealItem[] {
  const timeZone = options.timeZone ?? CITY.timezone;
  const who = options.who ?? [];
  const limit = options.limit ?? DEFAULT_LIMIT;

  const today = localDayDate(at, timeZone);
  const todayWeekday = weekdayOf(today);

  const candidates: Candidate[] = [];
  // Good deals that haven't ended, valid today or not: sets the cycle length, so it only moves when the catalogue does.
  let catalogue = 0;
  for (const card of dealsList(deals)) {
    if (happeningHasEnded(card.happening, at, timeZone)) continue;
    const score = dealStealScore(card.happening);
    if (score >= GOOD_FLOOR) catalogue++;

    const rec = normalizeRecurrence(card.happening.recurrence);
    let todayOnly = false;
    let endsSoon = false;
    if (rec.type === "weekly") {
      if (!rec.days.includes(todayWeekday)) continue;
      if (rec.until && rec.until < today) continue;
      todayOnly = rec.days.length <= TODAY_ONLY_MAX_DAYS;
    } else if (rec.type !== "always") {
      // once / annual / dates
      if (!isActiveNow(card.happening, at, timeZone)) continue;
      const occ = nextOccurrence(card.happening, at, at, timeZone);
      endsSoon = (occ ? daysUntilLastChance(occ, at, timeZone) : Number.POSITIVE_INFINITY) <= ENDS_SOON_DAYS;
    }
    const lead = score >= GOOD_FLOOR && (todayOnly || endsSoon || isNewDeal(card.happening, at));
    candidates.push({ card, score, endsSoon, lead });
  }

  const leadAll = ranked(candidates.filter((c) => c.lead));
  const lead = leadAll.slice(0, LEAD_MAX);
  // Lead cards past LEAD_MAX go back into the rotation rather than vanishing.
  const pool = candidates.filter((c) => c.score >= GOOD_FLOOR && !lead.includes(c));
  const cycle = Math.max(2, Math.round(catalogue / limit));
  const rotation = rotate(pool, Math.max(limit - lead.length, 0), cycle, today);

  const cards = (list: Candidate[]) => list.map((c) => c.card);
  let result = [...rankQualifyingFirst(cards(lead), who), ...rankQualifyingFirst(cards(rotation), who)];

  if (result.length < TOPUP_TARGET) {
    const weak = cards(ranked(candidates.filter((c) => c.score < GOOD_FLOOR)));
    for (const card of rankQualifyingFirst(weak, who)) {
      if (result.length >= TOPUP_TARGET) break;
      result.push(card);
    }
  }

  result = result.slice(0, limit);
  const grouped = groupDealsByVenue(result);
  if (grouped.length < MIN_RENDER_COUNT) return [];
  return grouped;
}
