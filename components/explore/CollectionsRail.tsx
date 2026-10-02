"use client";

import { EXPLORE_COLLECTIONS, type ExploreCollection } from "@/lib/explore/collections";
import { Icon } from "@/components/ui";

export interface CollectionsRailProps {
  /** True when /api/weather reports today as disruptive (rain/storm) — promotes the `rainPick` card to the front, per the task brief. */
  isRainy: boolean;
  onSelect: (collection: ExploreCollection) => void;
}

/** "Free museums · Rainy-day ideas · Cheap eats · Best viewpoints · Deals near you · This weekend" preset rail. Each card applies a layer/category/sort combo (see ExploreCollection) and scrolls to the map — wired up by the page, this component only renders + reorders. */
export function CollectionsRail({ isRainy, onSelect }: CollectionsRailProps) {
  const ordered = isRainy
    ? [...EXPLORE_COLLECTIONS].sort((a, b) => (b.rainPick ? 1 : 0) - (a.rainPick ? 1 : 0))
    : EXPLORE_COLLECTIONS;

  return (
    <div className="-mx-4 flex touch-pan-x snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain scroll-pl-4 px-4 pb-1 [&::-webkit-scrollbar]:hidden lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
      {ordered.map((c) => (
        <button
          key={c.slug}
          type="button"
          onClick={() => onSelect(c)}
          className="flex w-[132px] shrink-0 snap-start flex-col items-start gap-2 rounded-xl border border-outline-variant bg-surface-container-lowest p-3 text-left shadow-sm transition-shadow hover:shadow-md"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
            <Icon name={c.icon} size={20} />
          </span>
          <span className="text-label-md font-semibold leading-snug text-on-surface">{c.label}</span>
          {c.rainPick && isRainy ? (
            <span className="text-label-sm text-secondary">Good call today</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export default CollectionsRail;
