"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { CITY } from "@/lib/city";
import { useExploreState } from "@/lib/explore/useExploreState";
import { useIsDesktop } from "@/lib/useMediaQuery";
import { LayerSwitch } from "@/components/explore/LayerSwitch";
import { NeighbourhoodChips } from "@/components/explore/NeighbourhoodChips";
import { CategoryChips } from "@/components/explore/CategoryChips";
import { CollectionsRail } from "@/components/explore/CollectionsRail";
import { SearchAutocomplete } from "@/components/explore/SearchAutocomplete";
import { ExploreSheet } from "@/components/explore/ExploreSheet";
import { MapStatusPill, PlaceCardOverlay } from "@/components/explore/MapOverlays";
import { ExploreWorkspace } from "@/components/explore/desktop/ExploreWorkspace";
import { AppHeader } from "@/components/shell/AppHeader";

const MapStage = dynamic(() => import("@/components/explore/MapStage").then((mod) => mod.MapStage), {
  ssr: false,
  loading: () => (
    <div className="h-[52vh] min-h-[320px] w-full animate-pulse rounded-xl border border-outline-variant/60 bg-surface-container" />
  ),
});

/** The phone Explore page: a map hero with chips and a pin bottom sheet. */
function MobileExplore() {
  const {
    layer,
    categories,
    search,
    setSearch,
    neighbourhood,
    pendingBounds,
    setPendingBounds,
    pins,
    sortedPins,
    loading,
    degraded,
    showStatusPill,
    isRainy,
    selectedPinId,
    sheetPin,
    setSheetPin,
    placeCard,
    setPlaceCard,
    geoStatus,
    mapRef,
    mapAnchorRef,
    handleLayerChange,
    toggleCategory,
    handleNeighbourhoodSelect,
    handleNearMe,
    handleSearchThisArea,
    handleCollectionSelect,
    handlePinClick,
    handleAutocompletePinSelect,
    handleGooglePlaceSelect,
    handleWidenSearch,
  } = useExploreState();

  return (
    <div className="flex flex-col gap-4 overflow-x-clip pb-6">
      <AppHeader title="Explore Edinburgh" />

      <div className="flex flex-col gap-4 px-4">
        {/* Search — free-text across places, deals, events and free things, plus an "On Fomo" / "Places" suggestions dropdown */}
        <SearchAutocomplete
          search={search}
          onSearchChange={setSearch}
          pins={pins}
          onSelectPin={handleAutocompletePinSelect}
          onSelectGooglePlace={handleGooglePlaceSelect}
        />

        <div ref={mapAnchorRef} className="flex flex-col gap-3">
          <LayerSwitch value={layer} onChange={handleLayerChange} />

          <div className="relative">
            <MapStage
              ref={mapRef}
              center={CITY.center}
              pins={sortedPins}
              selectedPinId={selectedPinId}
              onPinClick={handlePinClick}
              onBoundsChange={setPendingBounds}
              showSearchThisArea={pendingBounds !== null}
              onSearchThisArea={handleSearchThisArea}
              onNearMe={handleNearMe}
              nearMeAvailable={geoStatus !== "denied" && geoStatus !== "unsupported"}
            />

            {/* Loading / no-matches feedback, moved here from the removed ResultsList
                (task: "don't show the list of events/places on the Explore page"). */}
            {showStatusPill ? <MapStatusPill loading={loading} onWiden={handleWidenSearch} /> : null}

            {placeCard ? <PlaceCardOverlay card={placeCard} onDismiss={() => setPlaceCard(null)} /> : null}
          </div>
        </div>

        <NeighbourhoodChips selected={neighbourhood} onSelect={handleNeighbourhoodSelect} />
        <CategoryChips selected={categories} onToggle={toggleCategory} />

        <div className="flex flex-col gap-2">
          <h2 className="text-headline-sm text-primary">Collections</h2>
          <CollectionsRail isRainy={isRainy} onSelect={handleCollectionSelect} />
        </div>

        {degraded === "explore-error" ? (
          <p className="text-label-sm text-on-surface-variant">
            Couldn&apos;t reach live data. Showing what we have.
          </p>
        ) : null}
      </div>

      <ExploreSheet pin={sheetPin} onClose={() => setSheetPin(null)} />
    </div>
  );
}

function ExploreContent() {
  const isDesktop = useIsDesktop();
  // Only one of the two trees is ever mounted (so only one map instance). Until
  // the media query resolves (server render + first client render) the phone
  // tree renders wrapped in `lg:hidden`, so a desktop visitor never sees a
  // phone-layout flash; on phones that class does nothing.
  if (isDesktop === true) return <ExploreWorkspace initialTab="browse" />;
  return (
    <div className="lg:hidden">
      <MobileExplore />
    </div>
  );
}

export default function ExplorePage() {
  return (
    <Suspense fallback={null}>
      <ExploreContent />
    </Suspense>
  );
}
