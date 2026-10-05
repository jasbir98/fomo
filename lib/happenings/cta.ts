import type { Happening } from "@/lib/happenings/types";

/**
 * The primary button's label for a happening — says what the button actually
 * does. A source-supplied `cta_label` wins; otherwise "Claim Offer" is only
 * honest for an actual deal (a free open mic or museum isn't an offer).
 * Shared by the detail page and Home's hero card so they never disagree.
 */
export function happeningCtaLabel(
  h: Pick<Happening, "cta_label" | "is_free" | "promo_code" | "kind" | "booking_url">
): string {
  if (h.cta_label) return h.cta_label;
  if (h.is_free) return "Plan your visit";
  if (h.promo_code || h.kind === "deal") return "Get the deal";
  if (h.booking_url || h.kind === "festival" || h.kind === "event") return "Get tickets";
  return "Official info";
}
