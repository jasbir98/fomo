/**
 * Fomo personalisation — ranking boost, never hiding content (task brief
 * §3). `personalBoost` scores one feed/deal card against a visitor's prefs
 * (lib/personalise/usePrefs.ts); `reorderWithBoost` uses it to nudge Home's
 * lists (What's on, Today's deals, /deals) without ever moving a card up by
 * more than `MAX_MOVE_UP` positions — the brief's own "keep it gentle... the
 * time-ordered feel of What's on survives" — and without dropping anything:
 * every card that went in comes back out, same set, just re-positioned.
 *
 * Deliberately NOT `server-only` — every caller (Home, /deals, /whats-on)
 * is a client component, same exclusion as lib/happenings/price-label.ts.
 */
import type { DealCardData, FeedCardData } from "@/lib/happenings/feed-types";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import { isFreeCard } from "@/lib/happenings/price-label";
import { whoGroupForEligibility, type DealWhoGroup } from "@/lib/happenings/groups";
import { interestForEventCategory, interestForHappeningCategory, type InterestKey } from "./interests";
import { affinityBonus, readAffinity } from "./affinity";
import type { FomoBudget } from "./usePrefs";

type Card = FeedCardData | DealCardData;

/** Minimal shape `personalBoost` needs off a prefs object — structurally compatible with the full `FomoPrefs` (plus its derived `who`), kept narrow so a test doesn't need to construct one. */
export interface BoostPrefs {
  interests: readonly InterestKey[];
  budget: FomoBudget;
  who: readonly DealWhoGroup[];
}

const INTEREST_MATCH_BOOST = 4;
const BUDGET_FIT_BOOST = 3;
const ELIGIBILITY_MATCH_BOOST = 3;

/** The one happening a card is "about", for category/eligibility matching — `null` for a bare `EventItem` card (an event has its own, separate category vocabulary, see `cardEvent`). */
function cardHappening(card: Card): Happening | null {
  if (card.kind === "event") return null;
  if (card.kind === "series") return card.lead;
  if (card.kind === "recurring") return card.lead.kind === "happening" ? card.lead.happening : null;
  return card.happening;
}

function cardEvent(card: Card): EventItem | null {
  if (card.kind === "event") return card.event;
  if (card.kind === "recurring" && card.lead.kind === "event") return card.lead.event;
  return null;
}

function cardInterest(card: Card): InterestKey | null {
  const happening = cardHappening(card);
  if (happening) return interestForHappeningCategory(happening.category);
  const event = cardEvent(card);
  return event ? interestForEventCategory(event.category) : null;
}

/** Deal cards (lib/happenings/feed-types.ts's `DealCardData`) already carry their own precomputed `who` facet — reuse it instead of re-deriving from `eligibility` so this never disagrees with lib/happenings/groups.ts's own `matchesDealFilters`. */
function cardWho(card: Card): DealWhoGroup | null {
  if ("who" in card) return card.who;
  const happening = cardHappening(card);
  return happening ? whoGroupForEligibility(happening.eligibility) : null;
}

/** Cheap/free fit for the visitor's budget pref — `"any"` never boosts (it's
 *  the "no preference" default, not "prefers expensive"). Events carry a
 *  real `price_from` floor; happenings (deals/free_access/activities) only
 *  ever carry `is_free`, no comparable numeric "what would I actually pay"
 *  figure (a deal's `saving_amount` is an amount OFF, not a price) — so
 *  "under10" only ever tightens further on an event's `price_from`. */
function fitsBudget(card: Card, budget: FomoBudget): boolean {
  if (budget === "any") return false;
  if (isFreeCard(card as FeedCardData)) return true;
  if (budget === "free") return false;
  const event = cardEvent(card as FeedCardData);
  return event?.price_from != null && event.price_from <= 10;
}

/**
 * Pure score for one card — higher sorts earlier. 0 for a card that matches
 * none of the visitor's prefs, and 0 across the board for a visitor with no
 * prefs at all (every `includes`/`fitsBudget` check is vacuously false) —
 * which is what makes "no prefs → order unchanged" hold in
 * `reorderWithBoost` below without a separate early-return special case.
 */
export function personalBoost(card: Card, prefs: BoostPrefs, affinity = readAffinity()): number {
  let score = 0;
  const interest = cardInterest(card);
  if (interest && prefs.interests.includes(interest)) score += INTEREST_MATCH_BOOST;
  if (fitsBudget(card, prefs.budget)) score += BUDGET_FIT_BOOST;
  const who = cardWho(card);
  if (who && prefs.who.includes(who)) score += ELIGIBILITY_MATCH_BOOST;
  score += affinityBonus(interest, affinity);
  return score;
}

/** Max positions a boosted card may move up the list — task brief §3: "a boosted card can move up at most ~5 positions". */
export const MAX_MOVE_UP = 5;

/**
 * Stable, bounded reorder. Each card gets a sort key of
 * `originalIndex - min(MAX_MOVE_UP, originalIndex)` when it has any
 * positive boost, or `originalIndex` when it doesn't — so an unboosted
 * card's relative order among itself never changes (ties broken by
 * original index), while a boosted one can jump ahead of at most
 * `MAX_MOVE_UP` immediately-preceding, unboosted neighbours. Every input
 * card appears exactly once in the output (a reorder, never a filter).
 *
 * Generic over `T` (a feed card, a deal card, or a wrapper like /deals'
 * venue-or-single `DealListItem`) rather than constrained to `Card` — every
 * caller passes its own `boostOf` that knows how to pull the representative
 * card out of its own item shape and score it via `personalBoost`.
 */
export function reorderWithBoost<T>(cards: readonly T[], boostOf: (card: T) => number): T[] {
  const scored = cards.map((card, index) => ({ card, index, score: boostOf(card) }));
  return scored
    .map((entry) => ({ ...entry, key: entry.index - Math.min(MAX_MOVE_UP, entry.score > 0 ? MAX_MOVE_UP : 0, entry.index) }))
    .sort((a, b) => a.key - b.key || b.score - a.score || a.index - b.index)
    .map((entry) => entry.card);
}
