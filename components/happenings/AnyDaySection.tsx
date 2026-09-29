"use client";

import { useState } from "react";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import { FeedListCard, type FeedCardSurface } from "./FeedListCard";

/** Cards shown before the "Show N more" button. */
export const ANY_DAY_CAP = 3;

function cardKey(card: FeedCardData): string {
  if (card.kind === "happening") return `happening-${card.happening.id}`;
  if (card.kind === "series") return `series-${card.key}`;
  if (card.kind === "recurring") return `recurring-${card.key}`;
  return `event-${card.event.id}`;
}

export interface AnyDaySectionProps {
  /** Already filtered/ordered by the caller (personal boost, /whats-on filters). Renders nothing when empty. */
  cards: FeedCardData[];
  /** Distinct per page so `card_opened` analytics can measure Any day clicks apart from the dated list. */
  surface: Extract<FeedCardSurface, "home_any_day" | "whats_on_any_day">;
}

/**
 * The trailing "Any day" section (see lib/happenings/everyday.ts): things on
 * essentially every day, kept out of the dated list so they stop topping it.
 * Compact heading + helper line, first ANY_DAY_CAP cards, then an in-place
 * "Show N more".
 */
export function AnyDaySection({ cards, surface }: AnyDaySectionProps) {
  const [expanded, setExpanded] = useState(false);
  if (cards.length === 0) return null;
  const visible = expanded ? cards : cards.slice(0, ANY_DAY_CAP);
  const hidden = cards.length - ANY_DAY_CAP;

  return (
    <section aria-label="Any day" className="flex flex-col gap-2 pt-1">
      <div className="flex flex-col gap-0.5 px-1">
        <h3 className="text-body-lg font-extrabold tracking-tight text-on-surface">Any day</h3>
        <p className="text-label-sm text-on-surface-variant">Always on, go whenever suits</p>
      </div>
      {visible.map((card, i) => (
        <FeedListCard key={cardKey(card)} card={card} surface={surface} position={i} />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex h-11 w-full items-center justify-center rounded-xl bg-secondary-container px-4 text-label-lg font-semibold text-on-secondary-container transition-opacity hover:opacity-90"
        >
          {expanded ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </section>
  );
}
