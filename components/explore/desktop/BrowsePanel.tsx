"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import type { ExploreLayer, ExplorePin } from "@/lib/explore/types";
import { PIN_TYPE_STYLE } from "@/lib/explore/pin-style";
import type { ExploreCategorySlug } from "@/lib/explore/categories";
import type { ExploreCollection } from "@/lib/explore/collections";
import { Icon, SmartImage } from "@/components/ui";
import { SearchAutocomplete, type ResolvedPlace } from "@/components/explore/SearchAutocomplete";
import { LayerSwitch } from "@/components/explore/LayerSwitch";
import { NeighbourhoodChips } from "@/components/explore/NeighbourhoodChips";
import { CategoryChips } from "@/components/explore/CategoryChips";
import { CollectionsRail } from "@/components/explore/CollectionsRail";

/** Rows rendered before "Show more" — a full Edinburgh result set is several hundred pins. */
const PAGE_SIZE = 60;

export interface BrowsePanelProps {
  search: string;
  onSearchChange: (value: string) => void;
  pins: ExplorePin[];
  onSelectPin: (pin: ExplorePin) => void;
  onSelectGooglePlace: (result: ResolvedPlace) => void;
  layer: ExploreLayer;
  onLayerChange: (layer: ExploreLayer) => void;
  neighbourhood: string | null;
  onNeighbourhoodSelect: (slug: string | null) => void;
  categories: ExploreCategorySlug[];
  onToggleCategory: (slug: ExploreCategorySlug) => void;
  sortedPins: ExplorePin[];
  loading: boolean;
  degraded: string | null;
  selectedPinId: string | null;
  onHoverPin: (id: string | null) => void;
  onOpenPin: (pin: ExplorePin) => void;
  onWiden: () => void;
  isRainy: boolean;
  onCollectionSelect: (c: ExploreCollection) => void;
  visibleCount: number;
  onShowMore: () => void;
}

export { PAGE_SIZE as BROWSE_PAGE_SIZE };

/** One compact result row: thumb, title, category and the deal/price badge. Hover lights its map pin. */
function PinRow({
  pin,
  selected,
  onHover,
  onOpen,
}: {
  pin: ExplorePin;
  selected: boolean;
  onHover: (id: string | null) => void;
  onOpen: (pin: ExplorePin) => void;
}) {
  const style = PIN_TYPE_STYLE[pin.type];
  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    // Let the browser handle new-tab / download style clicks.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(pin);
  }
  return (
    <li>
      <Link
        href={pin.href}
        data-pin-id={pin.id}
        onClick={handleClick}
        onMouseEnter={() => onHover(pin.id)}
        onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(pin.id)}
        onBlur={() => onHover(null)}
        className={`flex items-center gap-3 rounded-xl border p-2 transition-colors hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary ${
          selected ? "border-primary bg-surface-container-low" : "border-transparent"
        }`}
      >
        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-container">
          <SmartImage src={pin.image} alt="" width={56} height={56} className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-label-md font-bold text-on-surface">{pin.title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-label-sm text-on-surface-variant">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: style.color }}
            />
            <span className="truncate">{pin.category ?? style.label}</span>
          </p>
        </div>
        {pin.badge ? (
          <span className="shrink-0 rounded-full bg-surface-container px-2.5 py-1 text-label-sm font-extrabold text-primary">
            {pin.badge}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function RowSkeletons() {
  return (
    <ul aria-hidden="true" className="flex flex-col gap-1">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center gap-3 p-2">
          <div className="h-14 w-14 shrink-0 animate-pulse rounded-lg bg-surface-container" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-3 w-3/4 animate-pulse rounded bg-surface-container" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-surface-container" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The desktop "Browse" tab: search, layer, chips, the pin list and collections. */
export function BrowsePanel(props: BrowsePanelProps) {
  const {
    search,
    onSearchChange,
    pins,
    onSelectPin,
    onSelectGooglePlace,
    layer,
    onLayerChange,
    neighbourhood,
    onNeighbourhoodSelect,
    categories,
    onToggleCategory,
    sortedPins,
    loading,
    degraded,
    selectedPinId,
    onHoverPin,
    onOpenPin,
    onWiden,
    isRainy,
    onCollectionSelect,
    visibleCount,
    onShowMore,
  } = props;
  const shown = sortedPins.slice(0, visibleCount);

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <SearchAutocomplete
        search={search}
        onSearchChange={onSearchChange}
        pins={pins}
        onSelectPin={onSelectPin}
        onSelectGooglePlace={onSelectGooglePlace}
      />
      {/* The 388px panel is too narrow for icon + label in each of the five segments (labels truncate), so drop the icons. Targets the icon's wrapper span: Icon sets its own inline display, which beats a class on the icon itself. */}
      <div className="[&_[role=tab]>span:has(.material-symbols-outlined)]:hidden">
        <LayerSwitch value={layer} onChange={onLayerChange} />
      </div>
      <NeighbourhoodChips selected={neighbourhood} onSelect={onNeighbourhoodSelect} />
      <CategoryChips selected={categories} onToggle={onToggleCategory} />

      <section aria-label="Results" className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-headline-sm text-primary">
          In view · {sortedPins.length}
          {loading && sortedPins.length > 0 ? (
            <Icon name="progress_activity" size={16} className="animate-spin text-on-surface-variant" />
          ) : null}
        </h2>
        {loading && sortedPins.length === 0 ? (
          <RowSkeletons />
        ) : sortedPins.length === 0 ? (
          <div className="flex items-center gap-2 rounded-xl bg-surface-container px-4 py-3 text-label-md text-on-surface">
            <Icon name="search_off" size={18} className="text-on-surface-variant" />
            <span>No matches here</span>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={onWiden} className="font-semibold text-primary hover:underline">
              Widen search
            </button>
          </div>
        ) : (
          <>
            <ul className="-mx-2 flex flex-col gap-0.5">
              {shown.map((pin) => (
                <PinRow
                  key={pin.id}
                  pin={pin}
                  selected={pin.id === selectedPinId}
                  onHover={onHoverPin}
                  onOpen={onOpenPin}
                />
              ))}
            </ul>
            {sortedPins.length > shown.length ? (
              <button
                type="button"
                onClick={onShowMore}
                className="self-center rounded-full bg-surface-container px-4 py-2 text-label-md font-semibold text-primary transition-colors hover:bg-surface-container-high"
              >
                Show more ({sortedPins.length - shown.length})
              </button>
            ) : null}
          </>
        )}
        {degraded === "explore-error" ? (
          <p className="text-label-sm text-on-surface-variant">Couldn&apos;t reach live data. Showing what we have.</p>
        ) : null}
      </section>

      <section aria-label="Collections" className="flex flex-col gap-2 pb-2">
        <h2 className="text-headline-sm text-primary">Collections</h2>
        <CollectionsRail isRainy={isRainy} onSelect={onCollectionSelect} />
      </section>
    </div>
  );
}
