/**
 * Fomo Happenings — the ONE price label every card shows, PM decision
 * 2026-09-26: no more multi-tier price chips, just a single consistent
 * "FREE" / "£4" / "20% off" / "2-for-1" / "From £12" label in the same spot
 * on every card (deal, happening, event, series, venue-deal, free-any-time,
 * Explore pin). Rules, in order:
 *
 *   1. `is_free` (or a provider event's own `is_free`) → "FREE".
 *   2. A deal-shaped happening (`saving_label`/`saving_amount`) → the same
 *      short badge `savingBadgeLabel` already derives ("20% off", "2-for-1",
 *      "£4 tickets") — reused as-is rather than re-implemented, so the two
 *      never drift.
 *   3. A priced event (`price_from`) → `formatEventPrice`'s "From £N" — kept
 *      as "From", never a bare "£N", because `price_from` is a documented
 *      FLOOR (the cheapest ticket tier a provider reported), not a single
 *      confirmed price; presenting it as exact would be a guess the PM's own
 *      "unknown price → render nothing, never guess" rule forbids.
 *   4. Nothing resolvable → `null`. The caller renders no pill at all.
 *
 * Deliberately NOT `server-only` — every consumer (FeedListCard,
 * VenueDealCard, FreeAnyTimeRow, the deals/weekend/whats-on "Free only"
 * toggles) is a client component, same exclusion as lib/happenings/format.ts.
 */
import { moneyLabel, savingBadgeLabel } from "@/lib/happenings/format";
import { formatEventPrice } from "@/lib/events/format";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import type { FeedCardData } from "@/lib/happenings/feed-types";

export type PriceLabelKind = "free" | "deal" | "price";

export interface PriceLabel {
  /** The exact text to render — "FREE", "20% off", "From £12", … */
  text: string;
  /** Styling hook only (PriceTag colours "free" slightly differently from a plain price/deal) — never used for filtering logic, which reads `is_free`/`price_from` directly. */
  kind: PriceLabelKind;
}

type HappeningPriceFields = Pick<Happening, "is_free" | "saving_label" | "saving_amount" | "currency">;
type EventPriceFields = Pick<EventItem, "is_free" | "price_from" | "currency">;

/** True is_free only — `null`/`false` both read as "price unknown or not free", never assumed free. */
export function isFreeHappening(h: Pick<Happening, "is_free">): boolean {
  return h.is_free === true;
}

export function isFreeEvent(e: Pick<EventItem, "is_free">): boolean {
  return e.is_free === true;
}

/** Shared by `priceLabelForCard` and every page's "Free only" toggle — the toggle and the FREE label can never disagree about what counts as free because both read this one function. */
export function isFreeCard(card: FeedCardData): boolean {
  if (card.kind === "event") return isFreeEvent(card.event);
  if (card.kind === "recurring") return isFreeCard(card.lead);
  const happening = card.kind === "series" ? card.lead : card.happening;
  return isFreeHappening(happening);
}

export function priceLabelForHappening(h: HappeningPriceFields): PriceLabel | null {
  if (isFreeHappening(h)) return { text: "FREE", kind: "free" };
  const label = savingBadgeLabel(h);
  // savingBadgeLabel's own is_free fallback is unreachable here (already
  // handled above), so anything it returns at this point is a genuine
  // discount-shaped label, never the free case.
  if (label) return { text: label, kind: "deal" };
  return null;
}

export function priceLabelForEvent(e: EventPriceFields): PriceLabel | null {
  if (isFreeEvent(e)) return { text: "FREE", kind: "free" };
  if (e.price_from == null) return null;
  const text = formatEventPrice(e); // "From £N" — never bare, see module doc.
  return text ? { text, kind: "price" } : null;
}

/** One entry point for every `FeedCardData` shape (happening / series / event) — the card renderer's single source for its price pill. */
export function priceLabelForCard(card: FeedCardData): PriceLabel | null {
  if (card.kind === "event") return priceLabelForEvent(card.event);
  if (card.kind === "recurring") return priceLabelForCard(card.lead);
  const happening = card.kind === "series" ? card.lead : card.happening;
  return priceLabelForHappening(happening);
}

/** Re-exported so a caller that already imported `moneyLabel` for something else doesn't need a second import for the rare case (VenueDealCard's own "best saving" picker) that wants the raw money string rather than a full `PriceLabel`. */
export { moneyLabel };
