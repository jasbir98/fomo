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
import { ResultsList } from "@/components/explore/ResultsList";
import { ExploreSheet } from "@/components/explore/ExploreSheet";
import { PageHeader, Icon } from "@/components/ui";

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
  }

  function toggleCategory(slug: ExploreCategorySlug) {
    setCategories((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
    clearCollectionPreset();
  }

  function handleNeighbourhoodSelect(slug: string | null) {
    setNeighbourhood(slug);
    setBbox(null);
    setPendingBounds(null);
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
    mapAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleCardSelect(pin: ExplorePin) {
    setSelectedPinId(pin.id);
    mapRef.current?.flyTo({ lat: pin.lat, lng: pin.lng }, 16);
  }

  function handlePinClick(pin: ExplorePin) {
    setSelectedPinId(pin.id);
    setSheetPin(pin);
  }

  function handleWidenSearch() {
    setBbox(null);
    setPendingBounds(null);
    setNeighbourhood(null);
    setCategories([]);
    setSearch("");
  }

  return (
    <div className="flex flex-col gap-4 pb-6">
      <PageHeader title="Explore Edinburgh" />

      <div className="flex flex-col gap-4 px-5">
        {/* Search — free-text across places, deals, events and free things */}
        <div className="flex h-12 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 shadow-sm">
          <Icon name="search" size={20} className="text-primary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Edinburgh…"
            className="flex-1 bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant outline-none"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="text-on-surface-variant transition-colors hover:text-primary"
            >
              <Icon name="close" size={20} />
            </button>
          ) : null}
        </div>

        <div ref={mapAnchorRef} className="flex flex-col gap-3">
          <LayerSwitch value={layer} onChange={handleLayerChange} />

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

      <div className="px-5">
        <ResultsList
          pins={sortedPins}
          loading={loading}
          degraded={degraded}
          userCoords={coords}
          selectedPinId={selectedPinId}
          onCardSelect={handleCardSelect}
          onWidenSearch={handleWidenSearch}
        />
      </div>

      <ExploreSheet pin={sheetPin} onClose={() => setSheetPin(null)} />
    </div>
  );
}
