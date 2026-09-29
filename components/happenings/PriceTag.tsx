import type { PriceLabel } from "@/lib/happenings/price-label";

export interface PriceTagProps {
  label: PriceLabel | null;
  /** "card" (default) — the outlined pill used beside a list row's title
   *  (HappeningRow, SeriesRow, EventRow); "banner" — filled pill for use
   *  over an image banner, where the card variant's border/surface tint
   *  would disappear (FestivalRow's hero card); "compact" — the smaller,
   *  borderless tag used on a thumbnail row (VenueDealCard, FreeAnyTimeRow).
   *  All three are the same text in the same relative position — only the
   *  chrome changes to fit the card it sits on. */
  variant?: "card" | "banner" | "compact";
  className?: string;
}

/**
 * The ONE price pill every card renders (PM decision 2026-09-26, see
 * lib/happenings/price-label.ts's module doc) — "FREE" / "£4" / "20% off" /
 * "2-for-1" / "From £12", always in the same shape, wherever a card decides
 * to put it. Renders nothing when `label` is null — the caller never has to
 * gate on it separately, matching every other optional-badge pattern in
 * this codebase ({badge ? <span>...</span> : null}).
 */
export function PriceTag({ label, variant = "card", className = "" }: PriceTagProps) {
  if (!label) return null;

  const variantClass =
    variant === "banner"
      ? "rounded-full border border-on-primary/20 bg-primary-container px-3 py-1 text-label-md text-on-primary-container shadow-xs"
      : variant === "compact"
        ? "rounded-full bg-surface-container px-2 py-0.5 text-label-sm font-medium text-primary"
        : "rounded-full border border-hairline-strong bg-surface-container px-2.5 py-1 text-label-md text-primary shadow-xs";

  return (
    <span
      className={`shrink-0 whitespace-nowrap font-extrabold ${variantClass} ${className}`}
      aria-label={`Price: ${label.text.toLowerCase()}`}
    >
      {label.text}
    </span>
  );
}

export default PriceTag;
