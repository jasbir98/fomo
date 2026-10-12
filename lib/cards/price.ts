// Not `server-only`: pure, no secrets, and lib/happenings/hero.ts (which
// imports it) also runs in the For you tab, scripts/finds.ts and tests.
import type { EventItem } from "@/lib/types";

// ---------------------------------------------------------------------------
// Split out of the old lib/now/price.ts (the /api/now ranker, removed in the
// 2026-09 Fomo cleanup) — only the pieces app/api/feed/route.ts and
// lib/happenings/hero.ts still need. `priceSignalForPlace`,
// `priceSignalForExperience` and `priceFit` were ranker-only and went with it.
// ---------------------------------------------------------------------------

export type PriceSignal = "cheap" | "moderate" | "expensive" | null;

/** Same currency-naive caveat as the old priceSignalForExperience: EventItem.price_from carries no currency normalization. `is_free` is authoritative when present. */
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
