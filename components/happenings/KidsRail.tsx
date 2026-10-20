"use client";

import Link from "next/link";
import { Icon, ScrollRail } from "@/components/ui";
import { FeedListCard } from "@/components/happenings/FeedListCard";
import { weekendCardKey } from "@/lib/happenings/weekend";
import type { FeedCardData } from "@/lib/happenings/feed-types";

export interface KidsRailProps {
  cards: FeedCardData[];
  className?: string;
}

/**
 * Home's "Out with the kids" horizontal rail (lib/happenings/kids-rail.ts picks
 * the cards): the same ScrollRail + FeedListCard pair other rails use, each
 * card a fixed width so the next one peeks in. Rendered only for a visitor who
 * said "I've got kids", and only with enough cards to read as a list.
 */
export function KidsRail({ cards, className = "" }: KidsRailProps) {
  return (
    <section className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between gap-2 px-1">
        <h3 className="flex items-center gap-2 text-headline-sm font-extrabold tracking-tight text-on-surface">
          <Icon name="family_restroom" size={20} className="text-accent" />
          Out with the kids
        </h3>
        <Link
          href="/kids"
          className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-container-lowest/80 px-2.5 py-1 text-label-sm font-semibold text-primary backdrop-blur-sm transition-opacity hover:opacity-80"
        >
          See all
          <Icon name="chevron_right" size={16} />
        </Link>
      </div>
      <ScrollRail scrollerClassName="-mx-4 items-stretch gap-3 px-4 pb-1 lg:mx-0 lg:px-0">
        {cards.map((card, i) => (
          <div key={weekendCardKey(card)} className="w-[17.5rem] shrink-0">
            <FeedListCard card={card} surface="home_kids_rail" position={i} />
          </div>
        ))}
      </ScrollRail>
    </section>
  );
}

export default KidsRail;
