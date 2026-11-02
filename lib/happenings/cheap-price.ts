/**
 * A fixed price at or below the good-price line for a named item ("£4 cask
 * pints", "£5 IPA with any burger"). `isGenuineDeal` (groups.ts) accepts such
 * a row even though its wording has no discount in it.
 *
 * Kept in step with scraper/deal_sources/gate.py (stated_prices,
 * cheap_price_match, is_cheap_price) so a deal the scraper publishes is not
 * hidden by the Deals tab. The numbers live in price-benchmarks.json, the one
 * shared copy both sides read. Change the logic here and there together.
 *
 * Pure and small (the JSON is under 1 KB): safe to import from client code.
 * Deliberately NOT `server-only`.
 */
import benchmarks from "./price-benchmarks.json";

type BenchmarkItem = { id: string; max_gbp: number; terms: string[] };

export type CheapPriceMatch = { id: string; price: number; max_gbp: number };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole words only: no letter or digit either side ("ipa" must not hit "Ipad").
const ITEMS: { id: string; max_gbp: number; re: RegExp }[] = (benchmarks.items as BenchmarkItem[]).map((item) => ({
  id: item.id,
  max_gbp: item.max_gbp,
  re: new RegExp(
    "(?<![a-z0-9])(?:" +
      [...item.terms]
        .map((t) => t.toLowerCase())
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join("|") +
      ")(?![a-z0-9])",
    "i",
  ),
}));

const POUNDS = /£\s?(\d[\d,]*(?:\.\d+)?)/g;
const OFF_AFTER = /^\s*off\b/i;
const SAVE_BEFORE = /\bsav(?:e|es|ed|ing|ings)\s*(?:up to\s*)?(?:of\s*)?$/i;
const FOR_TWO = /\bfor\s+(?:two|2)\b/i;

/** £ figures in `text` that are a price: not "£5 off" and not "save £5". Halved when the
 *  text says "for two" / "for 2" (the benchmarks are per person). */
export function statedPrices(text: string): number[] {
  let prices: number[] = [];
  for (const m of text.matchAll(POUNDS)) {
    const start = m.index ?? 0;
    if (OFF_AFTER.test(text.slice(start + m[0].length)) || SAVE_BEFORE.test(text.slice(0, start))) continue;
    const n = Number.parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) prices.push(n);
  }
  if (prices.length > 0 && FOR_TWO.test(text)) prices = prices.map((p) => p / 2);
  return prices;
}

/** The benchmark item a fixed price beats, or null. The lowest stated price is compared with
 *  every item named in the text; the item it beats by most (price / max_gbp lowest) wins. */
export function cheapPriceMatch(title: string, savingLabel: string | null): CheapPriceMatch | null {
  const text = `${savingLabel ?? ""} ${title ?? ""}`;
  const prices = statedPrices(text);
  if (prices.length === 0) return null;
  const price = Math.min(...prices);
  let best: CheapPriceMatch | null = null;
  for (const item of ITEMS) {
    if (price <= item.max_gbp && item.re.test(text)) {
      if (best === null || price / item.max_gbp < best.price / best.max_gbp) {
        best = { id: item.id, price, max_gbp: item.max_gbp };
      }
    }
  }
  return best;
}

/** "£4 cask pints", "£5 IPA with any burger". Not a saving: "£5 off pints" has no price,
 *  "cocktails £8" is over the line, "£29 weekday sessions" names no item. */
export function isCheapPrice(title: string, savingLabel: string | null): boolean {
  return cheapPriceMatch(title, savingLabel) !== null;
}
