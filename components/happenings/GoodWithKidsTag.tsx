import type { FamilyFit } from "@/lib/happenings/types";
import { Icon } from "@/components/ui";

/**
 * Whether a card or detail page gets the "Good with kids" tag: it has a family
 * fit (lib/happenings/family.ts) and nothing nearby already says so — the
 * "Kids free" price badge (lib/happenings/format.ts) or the "With kids"
 * eligibility line of a family-only offer.
 */
export function showGoodWithKids(
  fit: FamilyFit | null | undefined,
  opts: { priceText?: string | null; familyOffer?: boolean } = {}
): boolean {
  return fit != null && !opts.familyOffer && opts.priceText !== "Kids free";
}

/** The one small "Good with kids" tag, styled like the eligibility pill beside it. */
export function GoodWithKidsTag({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-container px-2 py-0.5 text-label-sm font-bold text-secondary ${className}`}
    >
      <Icon name="family_restroom" size={12} className="shrink-0" />
      Good with kids
    </span>
  );
}

export default GoodWithKidsTag;
