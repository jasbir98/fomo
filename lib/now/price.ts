import "server-only";
import type { BudgetBand } from "@/lib/now/persona";
import type { EventItem, Experience, Place } from "@/lib/types";

// ---------------------------------------------------------------------------
// Phase 6 (plan §D.1, §D.5) — one owner for "is this cheap or expensive" and
// "how much should that move the score for this budget persona". Split out
// of lib/now/rank.ts into its own file, rather than exported from rank.ts as
// the plan's prose suggests, because lib/now/generators.ts (experience_pick,
// experience_leadtime, event_tonight) also needs it and rank.ts already
// imports `generateCandidates` from generators.ts — exporting this from
// rank.ts would make that import cycle back on itself. Both rank.ts's
// `budgetFit` and the generators above import from here instead, so there's
// exactly one band-fit formula, not two drifting copies.
// ---------------------------------------------------------------------------

export type PriceSignal = "cheap" | "moderate" | "expensive" | null;

/** Google's price_level scale: 0 free .. 4 very expensive. No signal when the field is null (most live-Google fallback rows still carry it; curated seed rows mostly don't). */
export function priceSignalForPlace(place: Place): PriceSignal {
  if (place.price_level == null) return null;
  if (place.price_level <= 1) return "cheap";
  if (place.price_level >= 3) return "expensive";
  return "moderate";
}

/**
 * Currency-naive thresholds — Experience.price_from carries a provider
 * `currency` alongside it, but nothing in this codebase normalizes across
 * currencies today, and doing that properly (live FX, PPP-adjustment) is out
 * of scope for this phase. Treated as a flat numeric band regardless of
 * currency, which is a known, documented approximation, not a real
 * cross-currency comparison.
 */
export function priceSignalForExperience(exp: Experience): PriceSignal {
  if (exp.price_from == null) return null;
  if (exp.price_from <= 20) return "cheap";
  if (exp.price_from >= 100) return "expensive";
  return "moderate";
}

/** Same currency-naive caveat as `priceSignalForExperience`. `is_free` is authoritative when present. */
export function priceSignalForEvent(event: EventItem): PriceSignal {
  if (event.is_free) return "cheap";
  if (event.price_from == null) return null;
  if (event.price_from <= 15) return "cheap";
  if (event.price_from >= 50) return "expensive";
  return "moderate";
}

/**
 * Categories the What's on section (app/api/feed/route.ts) lets through
 * regardless of price — user's explicit call, 2026-09-14: sports fixtures
 * should surface in What's on even when unpriced (every live Ticketmaster
 * sports row currently carries `price_from: null`, and Skiddle's SPORT rows
 * are much the same), unlike every other category, which still has to pass
 * the ordinary "cheap" gate below. The card still shows an honest price
 * badge — "From £X" / "Free" / nothing when unknown — this only changes
 * whether the row is admitted, never what it claims about cost.
 */
export const WHATS_ON_PRICE_EXEMPT_CATEGORIES: readonly string[] = ["sports"];

/**
 * Shoestring/treat multiplier (plan §D.1). Neutral (1.0) whenever there's no
 * price signal, the signal is merely "moderate", or the persona's budget is
 * "middle" — this is what makes an unanswered budget question, or a candidate
 * with no price data, a true no-op rather than a hidden default.
 * `treat` never punishes `cheap` hard (0.95, not <1) — a treat-budget
 * traveller still eats at the ramen counter sometimes.
 */
export function priceFit(budget: BudgetBand, signal: PriceSignal): number {
  if (signal == null || signal === "moderate") return 1.0;
  if (budget === "shoestring") return signal === "cheap" ? 1.2 : 0.7;
  if (budget === "treat") return signal === "expensive" ? 1.15 : 0.95;
  return 1.0;
}
