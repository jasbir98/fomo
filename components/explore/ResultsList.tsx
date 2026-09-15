"use client";

import { useRef } from "react";
import type { ExplorePin } from "@/lib/explore/types";
import { PIN_TYPE_STYLE } from "@/lib/explore/pin-style";
import { distanceKm, formatDistanceLabel, walkMinutes, type Coordinates } from "@/lib/geo";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { Icon, SmartImage } from "@/components/ui";

export interface ResultsListProps {
  pins: ExplorePin[];
  loading: boolean;
  degraded: string | null;
  userCoords: Coordinates | null;
  selectedPinId: string | null;
  /** Card tap: flies the map to the pin and highlights it (does NOT open the sheet — tapping the highlighted marker on the map does that, per the design). */
  onCardSelect: (pin: ExplorePin) => void;
  onWidenSearch?: () => void;
}

function ResultCard({
  pin,
  selected,
  distanceLabel,
  onSelect,
}: {
  pin: ExplorePin;
  selected: boolean;
  distanceLabel: string | null;
  onSelect: () => void;
}) {
  const style = PIN_TYPE_STYLE[pin.type];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-xl border bg-surface-container-lowest p-2.5 text-left shadow-sm transition-colors ${
        selected ? "border-primary" : "border-outline-variant/60"
      }`}
    >
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-surface-container">
        {pin.image ? (
          <SmartImage
            src={pin.image}
            alt={pin.title}
            width={64}
            height={64}
            sizes="64px"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Icon name={style.icon} size={22} className="text-outline" />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="truncate text-label-lg font-semibold text-on-surface">{pin.title}</h3>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-label-sm text-on-surface-variant">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-white"
            style={{ backgroundColor: style.color }}
          >
            <Icon name={style.icon} size={12} />
            {style.label}
          </span>
          {pin.badge ? <span className="font-medium text-secondary">{pin.badge}</span> : null}
        </div>
        <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">
          {pin.category ? <span className="truncate">{pin.category}</span> : null}
          {pin.category && distanceLabel ? <span>&bull;</span> : null}
          {distanceLabel ? <span className="shrink-0">{distanceLabel}</span> : null}
        </div>
      </div>
      <Icon name="chevron_right" size={20} className="shrink-0 text-outline-variant" />
    </button>
  );
}

/**
 * Compact vertical results list synced to whatever's currently on the map
 * (layer/category/neighbourhood/search filters all narrow the same `pins`
 * array the map draws). Distance-sorted with walking minutes when location
 * is granted; server order (best-of-city / soonest-first, see
 * app/api/explore/route.ts) otherwise. Progressive reveal so a big
 * "Everything" result set doesn't mount 300 image tags at once.
 */
export function ResultsList({
  pins,
  loading,
  degraded,
  userCoords,
  selectedPinId,
  onCardSelect,
  onWidenSearch,
}: ResultsListProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const visibleCount = useProgressiveReveal(pins.length, null, sentinelRef, { vertical: true, step: 12 });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-headline-sm text-primary">
        {pins.length > 0 ? `${pins.length} ${pins.length === 1 ? "result" : "results"}` : "Results"}
      </h2>
      {degraded ? (
        <p className="text-label-sm text-on-surface-variant">
          Couldn&apos;t reach live data — showing what we have.
        </p>
      ) : null}
      {loading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-xl bg-surface-container" />
          ))}
        </div>
      ) : pins.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-outline-variant/70 p-8 text-center">
          <Icon name="explore_off" size={28} className="text-outline" />
          <p className="text-body-md text-on-surface-variant">
            Nothing here yet — try a different layer or area.
          </p>
          {onWidenSearch ? (
            <button
              type="button"
              onClick={onWidenSearch}
              className="text-label-md font-semibold text-primary hover:underline"
            >
              Show the whole city
            </button>
          ) : null}
        </div>
      ) : (
        <div ref={rootRef} className="flex flex-col gap-2.5">
          {pins.slice(0, visibleCount).map((pin) => {
            const distanceLabel = userCoords
              ? (() => {
                  const km = distanceKm(userCoords, { lat: pin.lat, lng: pin.lng });
                  return `${formatDistanceLabel(km)} · ~${walkMinutes(km)} min walk`;
                })()
              : null;
            return (
              <ResultCard
                key={pin.id}
                pin={pin}
                selected={pin.id === selectedPinId}
                distanceLabel={distanceLabel}
                onSelect={() => onCardSelect(pin)}
              />
            );
          })}
          <div ref={sentinelRef} className="h-px w-full" />
        </div>
      )}
    </section>
  );
}

export default ResultsList;
