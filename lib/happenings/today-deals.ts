/**
 * Fomo Happenings — "Today's deals" selection.
 *
 * Pure derivation over the `deals` section GET /api/feed already returns
 * (lib/happenings/feed-types.ts's `DealsSection`) — no new API, no schema
 * change. The point of the Home strip this feeds is "give students a reason
 * to open the app every day", so the ranking favours the deals that are
 * specifically ABOUT today (a weekly Tuesday offer) over deals that merely
 * happen to also be valid today (a standing `always` deal, valid every day
 * and therefore not really a "today" signal at all).
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
import { whoGroupForEligibility, type DealWhoGroup } from "@/lib/happenings/groups";
import type { DealCardData, DealsSection } from "@/lib/happenings/feed-types";

export interface TodaysDealsOptions {
  /** The visitor's own deal-eligibility profile (lib/useSaved.ts's `useSaved().who`) — used only to RANK eligible ("You qualify") deals first within each tier, never to hide ineligible ones. */
  who?: readonly DealWhoGroup[];
  timeZone?: string;
  /** Hard cap on the returned list, applied after ranking/top-up. */
  limit?: number;
}

/** Never returned with fewer than this many items — tiers 1+2 are topped up with `always` deals until this many, so the strip never reads as "just one thing". */
const TOPUP_TARGET = 3;

/** Below this, the whole strip is pointless (a single card doesn't read as "today's deals") — the caller renders nothing. */
const MIN_RENDER_COUNT = 2;

const DEFAULT_LIMIT = 10;

function dealsList(deals: DealsSection): DealCardData[] {
  return [...deals.venueGroups.flatMap((g) => g.offers), ...deals.singles];
}

function qualifies(card: DealCardData, who: readonly DealWhoGroup[]): boolean {
  const group = whoGroupForEligibility(card.happening.eligibility);
  return group != null && who.includes(group);
}

/** Stable partition — qualifying-first, both halves keeping their relative order — so a tier's own internal ranking (e.g. "ends soon" for dated deals) survives the eligibility re-sort. */
function rankQualifyingFirst(list: DealCardData[], who: readonly DealWhoGroup[]): DealCardData[] {
  const qualifying: DealCardData[] = [];
  const rest: DealCardData[] = [];
  for (const card of list) (qualifies(card, who) ? qualifying : rest).push(card);
  return [...qualifying, ...rest];
}

/**
 * Deals valid TODAY in `timeZone`, ranked for the Home "Today's deals" strip.
 *
 * Tiers (see the task brief this implements):
 *  1. Weekly deals whose `recurrence.days` includes today's weekday, not
 *     past a set `until`, and not ended — these rank first, they're what
 *     makes the strip feel "today" ("Tuesday: £5 pizza...").
 *  2. Dated deals (once/dates/annual) active today, "ends soon" first.
 *  3. `always` deals — excluded UNLESS tiers 1+2 total fewer than
 *     TOPUP_TARGET, in which case they top the list up so it's never a
 *     single card.
 *
 * Within each tier, eligible ("You qualify") deals rank first without
 * hiding ineligible ones. Capped at `limit` (default 10). Returns `[]` when
 * the final list would have fewer than MIN_RENDER_COUNT items — the caller
 * hides the strip entirely rather than rendering a token single card.
 */
export function todaysDeals(deals: DealsSection, at: Date, options: TodaysDealsOptions = {}): DealCardData[] {
  const timeZone = options.timeZone ?? CITY.timezone;
  const who = options.who ?? [];
  const limit = options.limit ?? DEFAULT_LIMIT;

  const today = localDayDate(at, timeZone);
  const todayWeekday = weekdayOf(today);

  const weeklyToday: DealCardData[] = [];
  const datedToday: { card: DealCardData; daysLeft: number }[] = [];
  const always: DealCardData[] = [];

  for (const card of dealsList(deals)) {
    if (happeningHasEnded(card.happening, at, timeZone)) continue;

    const rec = normalizeRecurrence(card.happening.recurrence);
    if (rec.type === "weekly") {
      if (!rec.days.includes(todayWeekday)) continue;
      if (rec.until && rec.until < today) continue;
      weeklyToday.push(card);
    } else if (rec.type === "always") {
      always.push(card);
    } else {
      // once / annual / dates
      if (!isActiveNow(card.happening, at, timeZone)) continue;
      const occ = nextOccurrence(card.happening, at, at, timeZone);
      const daysLeft = occ ? daysUntilLastChance(occ, at, timeZone) : Number.POSITIVE_INFINITY;
      datedToday.push({ card, daysLeft });
    }
  }

  datedToday.sort((a, b) => a.daysLeft - b.daysLeft);

  const weeklyRanked = rankQualifyingFirst(weeklyToday, who);
  const datedRanked = rankQualifyingFirst(
    datedToday.map((x) => x.card),
    who
  );

  let result = [...weeklyRanked, ...datedRanked];

  if (result.length < TOPUP_TARGET) {
    const alwaysRanked = rankQualifyingFirst(always, who);
    for (const card of alwaysRanked) {
      if (result.length >= TOPUP_TARGET) break;
      result.push(card);
    }
  }

  result = result.slice(0, limit);
  if (result.length < MIN_RENDER_COUNT) return [];
  return result;
}
