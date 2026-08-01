import type { Experience } from "@/lib/types";

/**
 * Approximate, display-only USD→GBP rate. Providers (mostly Viator) mostly
 * price in USD, but this app is GBP-first (matches Events/Skiddle) — not a
 * live rate, just good enough for a price preview. Checkout itself happens
 * on the provider's own booking_url, in their native currency.
 */
const USD_TO_GBP = 0.75;

/** Round a rating to one decimal place, e.g. 4.666667 -> "4.7". */
export function formatExperienceRating(rating: number): string {
  return rating.toFixed(1);
}

/** "From £42" (USD converted to GBP) or "From €42" / "From JPY 4200" as-is. */
export function formatExperiencePrice(
  experience: Pick<Experience, "price_from" | "currency">
): string | null {
  if (experience.price_from == null) return null;
  const currency = (experience.currency ?? "USD").toUpperCase();
  let amount = experience.price_from;
  let symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : `${currency} `;
  if (currency === "USD") {
    amount = amount * USD_TO_GBP;
    symbol = "£";
  }
  const rounded = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `From ${symbol}${rounded}`;
}
