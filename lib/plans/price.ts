/**
 * Plan prices and the receipt total. Same honesty rules as
 * lib/happenings/price-label.ts (unknown price → say so, never guess):
 *
 *   - `is_free === true` → £0.
 *   - an event's `price_from` → that amount, flagged `from` (it's the
 *     cheapest tier a provider reported, a floor, not a confirmed price).
 *   - a happening's `price_text` only when it is nothing but a price
 *     ("£5", "From £12"); anything wordier ("£20 for two") stays a label.
 *   - otherwise the card's own pill text ("20% off", "2-for-1") with no
 *     amount, counted as "TBC" in the total.
 *
 * Pure and client-safe: the plan bar, the landing page and the OG image all
 * read it.
 */
import { priceLabelForEvent, priceLabelForHappening } from "@/lib/happenings/price-label";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import type { PlanPrice } from "./types";

const FREE: PlanPrice = { label: "FREE", amount: 0, from: false };

/** "£7" / "£7.50" — whole pounds without pence, like the cards. */
export function poundsLabel(amount: number): string {
  return `£${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}

/** "£7.00" — the receipt's till-roll style. */
export function receiptMoney(amount: number): string {
  return `£${amount.toFixed(2)}`;
}

const PLAIN_PRICE = /^\s*(from\s+)?£\s*(\d+(?:\.\d{1,2})?)\s*$/i;

export function priceForHappening(h: Pick<Happening, "is_free" | "price_text" | "saving_label" | "saving_amount" | "currency">): PlanPrice {
  if (h.is_free === true) return FREE;
  const plain = h.price_text?.match(PLAIN_PRICE);
  if (plain && (h.currency ?? "GBP") === "GBP") {
    const amount = Number(plain[2]);
    const from = Boolean(plain[1]);
    return { label: from ? `From ${poundsLabel(amount)}` : poundsLabel(amount), amount, from };
  }
  return { label: priceLabelForHappening(h)?.text ?? null, amount: null, from: false };
}

export function priceForEvent(e: Pick<EventItem, "is_free" | "price_from" | "currency">): PlanPrice {
  if (e.is_free === true) return FREE;
  if (e.price_from != null && (e.currency ?? "GBP") === "GBP") {
    return { label: `From ${poundsLabel(e.price_from)}`, amount: e.price_from, from: true };
  }
  return { label: priceLabelForEvent(e)?.text ?? null, amount: null, from: false };
}

export interface PlanTotal {
  /** Sum of every known amount. */
  amount: number;
  /** Any known amount is a floor. */
  from: boolean;
  /** How many lines have no amount. */
  unknown: number;
  /** "£7 total", "From £7", "£7 + 1 TBC". */
  label: string;
  /** The headline form: "£7", "From £7", "£7+". */
  short: string;
}

export function planTotal(prices: PlanPrice[]): PlanTotal {
  let amount = 0;
  let from = false;
  let unknown = 0;
  for (const p of prices) {
    if (p.amount == null) unknown += 1;
    else {
      amount += p.amount;
      if (p.from) from = true;
    }
  }
  amount = Math.round(amount * 100) / 100;
  const money = poundsLabel(amount);
  const label = unknown > 0 ? `${money} + ${unknown} TBC` : from ? `From ${money}` : `${money} total`;
  const short = unknown > 0 ? `${money}+` : from ? `From ${money}` : money;
  return { amount, from, unknown, label, short };
}
