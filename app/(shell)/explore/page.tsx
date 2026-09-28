"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CITY } from "@/lib/city";
import { currentCoordinates, refreshGeolocation, useGeolocation, sortByDistance, distanceKm } from "@/lib/geo";
import type { ExploreLayer, ExplorePin, ExploreResponse } from "@/lib/explore/types";
import type { ExploreCategorySlug } from "@/lib/explore/categories";
import { NEIGHBOURHOOD_RADIUS_KM, findNeighbourhood } from "@/lib/explore/neighbourhoods";
import type { ExploreCollection } from "@/lib/explore/collections";
import type { MapBounds, MapCanvasHandle } from "@/components/explore/MapCanvas";
import { LayerSwitch } from "@/components/explore/LayerSwitch";
import { NeighbourhoodChips } from "@/components/explore/NeighbourhoodChips";
import { CategoryChips } from "@/components/explore/CategoryChips";
import { CollectionsRail } from "@/components/explore/CollectionsRail";
import { SearchAutocomplete, type ResolvedPlace } from "@/components/explore/SearchAutocomplete";
import { ExploreSheet } from "@/components/explore/ExploreSheet";
import { AppHeader } from "@/components/shell/AppHeader";
import { buildSearchMapUrl } from "@/lib/maps/links";
import { Icon } from "@/components/ui";
import { track } from "@/lib/analytics/track";

const MapStage = dynamic(() => import("@/components/explore/MapStage").then((mod) => mod.MapStage), {
  ssr: false,
  loading: () => (
    <div className="h-[52vh] min-h-[320px] w-full animate-pulse rounded-xl border border-outline-variant/60 bg-surface-container" />
  ),
});

/** Approximate rating parsed back out of a place pin's own "★ 4.6" badge
 *  (see app/api/explore/route.ts's `placeBadge`) — the "Best viewpoints"
 *  collection wants a rating sort, and `ExplorePin` deliberately doesn't
 *  carry a raw numeric rating field alongside the pre-formatted badge (see
 *  lib/explore/types.ts's header on why the pin contract stays small).
 *  Null (no sort signal) for any other badge shape ("Free", "Deal", a price). */
function parseRatingFromBadge(badge: string | null): number | null {
  if (!badge) return null;
  const m = /★\s*([\d.]+)/.exec(badge);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** True when `iso` falls on a Saturday or Sunday in the city's own timezone — backs the "This weekend" collection's client-side narrowing (lib/explore/collections.ts's own doc comment). */
function isWeekendStart(iso: string): boolean {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: CITY.timezone, weekday: "short" }).format(
    new Date(iso)
  );
  return weekday === "Sat" || weekday === "Sun";
}

export default function ExplorePage() {
  const [layer, setLayer] = useState<ExploreLayer>("everything");
  const [categories, setCategories] = useState<ExploreCategorySlug[]>([]);
  const [search, setSearch] = useState("");
  const [neighbourhood, setNeighbourhood] = useState<string | null>(null);

  // Collection-preset-only narrowing — cleared whenever the user takes
  // manual control (changes layer or toggles a category chip) so a stale
  // "Cheap eats" price cap doesn't silently keep filtering after that.
  const [maxPriceLevel, setMaxPriceLevel] = useState<number | null>(null);
  const [sortOverride, setSortOverride] = useState<"distance" | "rating" | null>(null);
  const [weekendOnly, setWeekendOnly] = useState(false);

  // `bbox` is what actually goes into the /api/explore request ("Search this
  // area" committed it); `pendingBounds` is just the map's current view after
  // a user pan, driving the button's visibility until it's committed or
  // discarded (neighbourhood jump, Near me, a fresh collection).
  const [bbox, setBbox] = useState<MapBounds | null>(null);
  const [pendingBounds, setPendingBounds] = useState<MapBounds | null>(null);

  const [pins, setPins] = useState<ExplorePin[]>([]);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState<string | null>(null);

  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [sheetPin, setSheetPin] = useState<ExplorePin | null>(null);

  // A fresh (not-yet-cached-as-a-pin) Google search pick — shown as a small
  // dismissible card over the map instead of the pin sheet, since there's no
  // ExplorePin (and so no detail page) for it. Cleared whenever the visitor
  // moves on to a different pin, area, or preset.
  const [placeCard, setPlaceCard] = useState<{ name: string | null; address: string | null; lat: number; lng: number } | null>(
    null
  );

  const [isRainy, setIsRainy] = useState(false);

  const { coords, status: geoStatus } = useGeolocation();
  const mapRef = useRef<MapCanvasHandle>(null);
  const mapAnchorRef = useRef<HTMLDivElement>(null);

  // Today's rain check, once — promotes "Rainy-day ideas" to the front of
  // the Collections rail (task brief §6). Same isDisruptive signal Smart
  // Disruption already reads off /api/weather; a failure just leaves the
  // rail in its default order rather than blocking anything.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/weather?destination=${encodeURIComponent(CITY.name)}`);
        const data = (await res.json()) as { day?: { isDisruptive?: boolean } | null };
        if (!cancelled) setIsRainy(Boolean(data.day?.isDisruptive));
      } catch (err) {
        console.error("[explore] weather lookup failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Pins fetch — layer/category/search/area/price all live server-side
  // (app/api/explore/route.ts); debounced 300ms so typing a search term
  // doesn't fire a request per keystroke.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ layer });
    if (categories.length > 0) params.set("category", categories.join(","));
    const q = search.trim();
    if (q) params.set("q", q);
    if (bbox) params.set("bbox", `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`);
    if (maxPriceLevel != null) params.set("maxPrice", String(maxPriceLevel));

    const timer = setTimeout(() => {
      (async () => {
        setLoading(true);
        try {
          const res = await fetch(`/api/explore?${params.toString()}`);
          const data = (await res.json()) as ExploreResponse;
          if (cancelled) return;
          setPins(data.pins ?? []);
          setDegraded(data.degraded ?? null);
        } catch (err) {
          if (!cancelled) console.error("[explore] pins fetch failed", err);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [layer, categories, search, bbox, maxPriceLevel]);

  // Neighbourhood radius + "this weekend" narrowing, both client-side over
  // whatever /api/explore already returned — see lib/explore/neighbourhoods.ts
  // and lib/explore/collections.ts's own doc comments on why these stay
  // client-side rather than becoming new server query params.
  const scopedPins = useMemo(() => {
    let list = pins;
    if (neighbourhood) {
      const n = findNeighbourhood(neighbourhood);
      if (n) {
        list = list.filter((p) => distanceKm(n.center, { lat: p.lat, lng: p.lng }) <= NEIGHBOURHOOD_RADIUS_KM);
      }
    }
    if (weekendOnly) {
      list = list.filter((p) => p.starts_at != null && isWeekendStart(p.starts_at));
    }
    return list;
  }, [pins, neighbourhood, weekendOnly]);

  // Distance-sorted when location is granted (task brief §7); "Best
  // viewpoints" overrides to a rating sort, "Deals near you" pins the
  // distance sort explicitly even before location resolves (sortByDistance
  // itself is a safe no-op with coords: null either way).
  const sortedPins = useMemo(() => {
    if (sortOverride === "rating") {
      return [...scopedPins].sort(
        (a, b) => (parseRatingFromBadge(b.badge) ?? -1) - (parseRatingFromBadge(a.badge) ?? -1)
      );
    }
    return sortByDistance(scopedPins, coords, (p) => ({ lat: p.lat, lng: p.lng }));
  }, [scopedPins, sortOverride, coords]);

  function clearCollectionPreset() {
    setMaxPriceLevel(null);
    setSortOverride(null);
    setWeekendOnly(false);
  }

  function handleLayerChange(next: ExploreLayer) {
    setLayer(next);
    clearCollectionPreset();
    setSelectedPinId(null);
    setSheetPin(null);
    setPlaceCard(null);
  }

  function toggleCategory(slug: ExploreCategorySlug) {
    setCategories((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
    clearCollectionPreset();
  }

  function handleNeighbourhoodSelect(slug: string | null) {
    setNeighbourhood(slug);
    setBbox(null);
    setPendingBounds(null);
    setPlaceCard(null);
    if (slug) {
      const n = findNeighbourhood(slug);
      if (n) mapRef.current?.flyTo(n.center, n.zoom);
    }
  }

  // Location is never requested on page load (lib/geo.ts) — this tap is the
  // ask, so the permission dialog appears when the visitor wants "near me".
  async function handleNearMe() {
    let target = coords;
    if (!target) {
      await refreshGeolocation();
      target = currentCoordinates();
    }
    if (!target) return;
    setNeighbourhood(null);
    setBbox(null);
    setPendingBounds(null);
    setPlaceCard(null);
    mapRef.current?.flyTo(target, 15);
  }

  function handleSearchThisArea() {
    if (!pendingBounds) return;
    setNeighbourhood(null);
    setBbox(pendingBounds);
    setPendingBounds(null);
  }

  function handleCollectionSelect(c: ExploreCollection) {
    setLayer(c.layer);
    setCategories(c.categories ?? []);
    setMaxPriceLevel(c.maxPriceLevel ?? null);
    setSortOverride(c.sort ?? null);
    setWeekendOnly(Boolean(c.weekendOnly));
    setSelectedPinId(null);
    setSheetPin(null);
    setPlaceCard(null);
    mapAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handlePinClick(pin: ExplorePin) {
    setSelectedPinId(pin.id);
    setSheetPin(pin);
    setPlaceCard(null);
  }

  // Search dropdown "On Fomo" pick — same effect as tapping the pin's own
  // marker (handlePinClick) plus the flyTo a results-list card tap used to
  // do (see the pre-dropdown ResultsList, since removed): the search box is
  // the only way left to jump straight to a pin that isn't in view yet.
  function handleAutocompletePinSelect(pin: ExplorePin) {
    mapRef.current?.flyTo({ lat: pin.lat, lng: pin.lng }, 16);
    setSelectedPinId(pin.id);
    setSheetPin(pin);
    setPlaceCard(null);
    track("search_submitted", { length: search.trim().length });
  }

  // Search dropdown "Places" (Google) pick, already resolved server-side
  // (app/api/places/resolve/route.ts). A pick that turned out to already be
  // one of Fomo's own cached pins opens its sheet like any other pin; a
  // genuinely fresh Google result has no ExplorePin (and so no detail page)
  // — just fly there and show the small floating card instead.
  function handleGooglePlaceSelect(result: ResolvedPlace) {
    if (result.source === "fomo" && result.placeId) {
      const pin = pins.find((p) => p.id === result.placeId);
      if (pin) {
        handleAutocompletePinSelect(pin);
        return;
      }
    }
    if (result.lat == null || result.lng == null) return;
    mapRef.current?.flyTo({ lat: result.lat, lng: result.lng }, 16);
    setSelectedPinId(null);
    setSheetPin(null);
    setPlaceCard({ name: result.name, address: result.address ?? null, lat: result.lat, lng: result.lng });
    track("search_submitted", { length: search.trim().length });
  }

  function handleWidenSearch() {
    setBbox(null);
    setPendingBounds(null);
    setNeighbourhood(null);
    setCategories([]);
    setSearch("");
    setPlaceCard(null);
  }

  const showStatusPill = loading || sortedPins.length === 0;

  return (
    <div className="flex flex-col gap-4 pb-6">
      <AppHeader title="Explore Edinburgh" />

      <div className="flex flex-col gap-4 px-5">
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
                (task: "don't show the list of events/places on the Explore page") —
                offset below MapStage's own "Search this area" pill (same top-centre
                slot) so the two never overlap when both are showing. */}
            {showStatusPill ? (
              <div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center px-4">
                <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-surface-container-lowest/95 px-4 py-2 text-label-md text-on-surface shadow-lg backdrop-blur-sm">
                  {loading ? (
                    <>
                      <Icon name="progress_activity" size={16} className="animate-spin text-primary" />
                      <span>Loading…</span>
                    </>
                  ) : (
                    <>
                      <Icon name="search_off" size={16} className="text-on-surface-variant" />
                      <span>No matches here</span>
                      <button
                        type="button"
                        onClick={handleWidenSearch}
                        className="font-semibold text-primary hover:underline"
                      >
                        Widen search
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {placeCard ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
                <div className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-3 shadow-lg">
                  <Icon name="place" size={20} className="mt-0.5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-label-lg font-semibold text-on-surface">
                      {placeCard.name ?? "Unnamed place"}
                    </p>
                    {placeCard.address ? (
                      <p className="truncate text-label-sm text-on-surface-variant">{placeCard.address}</p>
                    ) : null}
                    <a
                      href={buildSearchMapUrl(placeCard.address ?? placeCard.name ?? `${placeCard.lat},${placeCard.lng}`)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-label-sm font-semibold text-primary hover:underline"
                    >
                      Open in Google Maps
                      <Icon name="open_in_new" size={14} />
                    </a>
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => setPlaceCard(null)}
                    className="shrink-0 text-on-surface-variant transition-colors hover:text-primary"
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>
              </div>
            ) : null}
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
            Couldn&apos;t reach live data — showing what we have.
          </p>
        ) : null}
      </div>

      <ExploreSheet pin={sheetPin} onClose={() => setSheetPin(null)} />
    </div>
  );
}
