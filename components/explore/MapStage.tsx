"use client";

import { forwardRef } from "react";
import type { ExplorePin } from "@/lib/explore/types";
import {
  MapCanvas,
  type MapBounds,
  type MapCanvasHandle,
  type MapCanvasProps,
} from "@/components/explore/MapCanvas";
import { Icon } from "@/components/ui";

export interface MapStageProps {
  center: { lat: number; lng: number } | null;
  pins: ExplorePin[];
  selectedPinId: string | null;
  onPinClick: (pin: ExplorePin) => void;
  onBoundsChange: (bounds: MapBounds) => void;
  showSearchThisArea: boolean;
  onSearchThisArea: () => void;
  onNearMe: () => void;
  nearMeAvailable: boolean;
  /** Map box sizing. Defaults to the phone hero's ~52vh; the desktop workspace passes `h-full`. */
  heightClassName?: string;
  /** Extra classes for the wrapper (the desktop workspace passes `h-full`). */
  className?: string;
  /** Edge-to-edge map (no rounded corners / border) for the desktop workspace. */
  flush?: boolean;
  // Desktop workspace pass-throughs to MapCanvas; see its props for details.
  picks?: MapCanvasProps["picks"];
  highlightedPickKey?: MapCanvasProps["highlightedPickKey"];
  onPickClick?: MapCanvasProps["onPickClick"];
  onPickHover?: MapCanvasProps["onPickHover"];
  onMapReady?: MapCanvasProps["onMapReady"];
  dimPins?: MapCanvasProps["dimPins"];
  hidePins?: MapCanvasProps["hidePins"];
  highlightedPinId?: MapCanvasProps["highlightedPinId"];
}

/**
 * The map-first hero of Explore: a taller (~52vh) rounded MapCanvas plus two
 * floating controls per the task brief — "Near me" (bottom-right, always
 * available; disabled look when location isn't granted) and "Search this
 * area" (top-center, only appears once `onBoundsChange` has fired from a
 * real user pan — see MapCanvas's moveend guard). Kept as its own component
 * so the imperative flyTo/fitToPins ref (page.tsx needs it for neighbourhood
 * chips, collections, and the results list's card-tap-to-highlight) has one
 * clear owner: this component forwards its ref straight through to the
 * underlying MapCanvas instead of wrapping it in a second handle shape.
 */
export const MapStage = forwardRef<MapCanvasHandle, MapStageProps>(function MapStage(
  {
    center,
    pins,
    selectedPinId,
    onPinClick,
    onBoundsChange,
    showSearchThisArea,
    onSearchThisArea,
    onNearMe,
    nearMeAvailable,
    heightClassName = "h-[52vh] min-h-[320px]",
    className = "",
    flush = false,
    picks,
    highlightedPickKey,
    onPickClick,
    onPickHover,
    onMapReady,
    dimPins,
    hidePins,
    highlightedPinId,
  },
  ref
) {
  return (
    <div className={className ? `relative ${className}` : "relative"}>
      <MapCanvas
        ref={ref}
        center={center}
        pins={pins}
        selectedPinId={selectedPinId}
        onPinClick={onPinClick}
        onBoundsChange={onBoundsChange}
        heightClassName={heightClassName}
        flush={flush}
        picks={picks}
        highlightedPickKey={highlightedPickKey}
        onPickClick={onPickClick}
        onPickHover={onPickHover}
        onMapReady={onMapReady}
        dimPins={dimPins}
        hidePins={hidePins}
        highlightedPinId={highlightedPinId}
      />

      {showSearchThisArea ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <button
            type="button"
            onClick={onSearchThisArea}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-label-md font-semibold text-on-primary shadow-lg transition-opacity hover:opacity-90"
          >
            <Icon name="search" size={18} />
            Search this area
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onNearMe}
        aria-label="Recentre on my location"
        disabled={!nearMeAvailable}
        className="absolute bottom-3 right-3 flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-lowest text-primary shadow-lg transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        <Icon name="my_location" size={22} />
      </button>
    </div>
  );
});

export default MapStage;
