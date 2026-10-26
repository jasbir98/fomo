/**
 * Fomo Happenings — "Today's deals" selection.
 *
 * Pure derivation over the `deals` section GET /api/feed already returns
 * (lib/happenings/feed-types.ts's `DealsSection`) — no new API, no schema
 * change. The point of the Home strip this feeds is "give students a reason
 * to open the app every day", so the ranking favours the deals that are
 * specifically ABOUT today (a weekly Tuesday offer) over deals that merely
 * happen to also be valid today (a standing `always` deal, valid every day
 * and therefore not really a "today" signal at all). Within a tier the
 * steals go first (lib/happenings/deal-score.ts's `dealStealScore`: deep
 * discount, tied to a day or two of the week, local over national chain), so
 * a chain's every-day student discount doesn't lead a local Tuesday-only one.
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
import { whoGroupForEligibility, type DealWhoGroup } from "@/lib/happenings/groups";
import { groupDealsByVenue, type RankedDealItem } from "@/lib/happenings/venue-deals";
import type { DealCardData, DealsSection } from "@/lib/happenings/feed-types";

export interface TodaysDealsOptions {
  /** The visitor's own deal-eligibility profile (lib/useSaved.ts's `useSaved().who`) — used only to RANK eligible ("You qualify") deals first within each tier, never to hide ineligible ones. */
  who?: readonly DealWhoGroup[];
  timeZone?: string;
  /** Hard cap on the returned list, applied after ranking/top-up. */
  limit?: number;
}

/** Never returned with fewer than this many items — tiers 1+2 are topped up with `always` deals until this many, so the strip never reads as "just one thing". Measured in CARDS before venue-grouping (see `todaysDeals`'s own doc comment on why grouping runs last), matching the pre-grouping topup this always did. */
const TOPUP_TARGET = 3;

/** Below this, the whole strip is pointless (a single card doesn't read as "today's deals") — the caller renders nothing. Measured in rendered ITEMS (post-grouping): a venue's 3 deals collapsed to 1 card still reads fine alongside one more, but a single lone card never does. */
const MIN_RENDER_COUNT = 2;

const DEFAULT_LIMIT = 10;

/** Flattened, NOT grouped — every individual deal card, so the tier/
 *  eligibility ranking below can see and rank each one on its own merits.
 *  Venue grouping happens once, at the very end, over the final ranked
 *  list — see `todaysDeals`'s own doc comment and lib/happenings/
 *  venue-deals.ts's module doc for why re-grouping a pre-grouped section
 *  here would be wrong (this function may only pick SOME of a venue's
 *  deals into today's list, or drop its highest tier while keeping a
 *  lower one). */
function dealsList(deals: DealsSection): DealCardData[] {
  return [...deals.venueGroups.flatMap((g) => g.offers), ...deals.singles];
}

function qualifies(card: DealCardData, who: readonly DealWhoGroup[]): boolean {
  const group = whoGroupForEligibility(card.happening.eligibility);
  return group != null && who.includes(group);
}

/** A dated deal with this many days or fewer left sorts ahead of the rest of its tier, whatever its steal score ("ends soon"). */
const ENDS_SOON_DAYS = 2;

/** Stable sort, best deal first by `dealStealScore`; equal scores keep their input order. */
function sortByStealScore(list: DealCardData[]): DealCardData[] {
  return list
    .map((card, index) => ({ card, index, score: dealStealScore(card.happening) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.card);
}

/** Stable partition — qualifying-first, both halves keeping their relative order — so a tier's own internal ranking (steal score, "ends soon" for dated deals) survives the eligibility re-sort. */
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
 *  2. Dated deals (once/dates/annual) active today: ending within
 *     ENDS_SOON_DAYS days first ("ends soon"), then by steal score.
 *  3. `always` deals — excluded UNLESS tiers 1+2 total fewer than
 *     TOPUP_TARGET, in which case they top the list up so it's never a
 *     single card.
 *
 * Within each tier (weekly, `always`, and the rest of dated) deals are ordered
 * by `dealStealScore`, best first, then eligible ("You qualify") deals rank
 * first without hiding ineligible ones. Capped at `limit` (default 10) BEFORE venue
 * grouping (see `groupDealsByVenue`'s call below) — venue grouping runs
 * LAST, over this final ranked/capped list, so a venue with several deals
 * collapses into one card at the position of its best-ranked offer rather
 * than rendering once per deal (the "Camera Obscura ×3" bug this fixes —
 * see lib/happenings/venue-deals.ts's module doc). Returns `[]` when the
 * final grouped list would have fewer than MIN_RENDER_COUNT items — the
 * caller hides the strip entirely rather than rendering a token single card.
 */
export function todaysDeals(deals: DealsSection, at: Date, options: TodaysDealsOptions = {}): RankedDealItem[] {
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

  const dated = datedToday
    .map((x, index) => ({ ...x, index, score: dealStealScore(x.card.happening), endsSoon: x.daysLeft <= ENDS_SOON_DAYS }))
    .sort((a, b) => Number(b.endsSoon) - Number(a.endsSoon) || b.score - a.score || a.index - b.index)
    .map((x) => x.card);

  const weeklyRanked = rankQualifyingFirst(sortByStealScore(weeklyToday), who);
  const datedRanked = rankQualifyingFirst(dated, who);

  let result = [...weeklyRanked, ...datedRanked];

  if (result.length < TOPUP_TARGET) {
    const alwaysRanked = rankQualifyingFirst(sortByStealScore(always), who);
    for (const card of alwaysRanked) {
      if (result.length >= TOPUP_TARGET) break;
      result.push(card);
    }
  }

  result = result.slice(0, limit);
  const grouped = groupDealsByVenue(result);
  if (grouped.length < MIN_RENDER_COUNT) return [];
  return grouped;
}
