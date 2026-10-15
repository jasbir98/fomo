"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Icon } from "@/components/ui";
import { track } from "@/lib/analytics/track";
import { addToBasket, inBasket, removeFromBasket, usePlanBasket, type BasketItem } from "@/lib/plans/basket";
import { PLAN_MAX_ITEMS } from "@/lib/plans/types";

export interface AddToPlanButtonProps {
  item: BasketItem;
  /** `plan_item_added`'s `surface`: "weekend", "happening_detail", "event_detail". */
  surface: string;
  /** "card": a small pill in a feed card's footer. "header": a taller pill for a detail page's top bar. */
  variant?: "card" | "header";
  className?: string;
}

/**
 * Adds a happening or event to the weekend plan being built (lib/plans/basket.ts),
 * or takes it out again. Shows "Plan full" for a moment when there are
 * already four picks. Works signed out.
 */
export function AddToPlanButton({ item, surface, variant = "card", className = "" }: AddToPlanButtonProps) {
  const basket = usePlanBasket();
  const added = inBasket(basket, item.kind, item.id);
  const [full, setFull] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function handleClick(e: MouseEvent) {
    // Cards are links (NavCard): the tap must not open the detail page.
    e.stopPropagation();
    e.preventDefault();
    if (added) {
      removeFromBasket(item.kind, item.id);
      track("plan_item_removed", { kind: item.kind, id: item.id, surface });
      return;
    }
    if (addToBasket(item) === "full") {
      setFull(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFull(false), 2200);
      return;
    }
    track("plan_item_added", { kind: item.kind, id: item.id, surface, count: Math.min(basket.length + 1, PLAN_MAX_ITEMS) });
  }

  const label = full ? "Plan full" : added ? "In plan" : "Plan";
  const size = variant === "header" ? "h-10 px-3.5 text-label-md" : "h-8 px-2.5 text-label-sm";
  const tone = added
    ? "bg-primary text-on-primary"
    : full
      ? "bg-error-container text-on-error-container"
      : "bg-surface-container text-on-surface hover:bg-surface-container-high";

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={added}
      aria-label={added ? "Remove from your weekend plan" : full ? `Your plan already has ${PLAN_MAX_ITEMS} things` : "Add to your weekend plan"}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full font-bold transition-colors active:scale-95 ${size} ${tone} ${className}`}
    >
      <Icon name={added ? "check" : full ? "block" : "add"} size={variant === "header" ? 18 : 16} />
      {label}
    </button>
  );
}

export default AddToPlanButton;
