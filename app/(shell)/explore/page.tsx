"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  isSaved,
  recordCardSignal,
  saveItem,
  unsaveItem,
} from "@/lib/db";
import { useSelectedCity } from "@/lib/useSelectedCity";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { buildDirectionsUrl } from "@/lib/maps/links";
import { buildAskFomoHref } from "@/lib/chat-seed";
import type { Place } from "@/lib/types";
import { sortByDistance, useGeolocation, type Coordinates } from "@/lib/geo";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { BottomSheet, Chip, Icon, SmartImage } from "@/components/ui";

const MapCanvas = dynamic(() => import("@/components/explore/MapCanvas").then((mod) => mod.MapCanvas), {
  ssr: false,
  loading: () => (
    <div className="h-64 w-full animate-pulse rounded-xl border border-outline-variant/60 bg-surface-container" />
  ),
});


/** Place coordinate extractor for sortByDistance. */
function placeCoords(place: Place): Coordinates | null {
  return place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null;
}

/** Category chip → the slug the /api/places route understands. */
const CATEGORY_FILTERS: { label: string; icon: string; slug: string }[] = [
  { label: "Food", icon: "restaurant", slug: "food" },
  { label: "Photo spots", icon: "camera_alt", slug: "photo" },
  { label: "Lockers", icon: "vpn_key", slug: "lockers" },
  { label: "Transport", icon: "directions_transit", slug: "transport" },
];

// Matches /api/places' new default (app/api/places/route.ts) — sent
// explicitly so the Explore page's page size stays visible here rather than
// depending on whatever the route defaults to.
const PLACES_LIMIT = 24;

interface PlacesResponse {
  center: { lat: number; lng: number } | null;
  places: Place[];
  degraded?: string;
}

/** Defensively pull the first tip string out of a jsonb `tips` column. */
function firstTip(tips: unknown): string | null {
  if (!Array.isArray(tips) || tips.length === 0) return null;
  const first = tips[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const obj = first as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  return null;
}

export default function MapDiscoveryPage() {
  const db = supabaseBrowserAuth();
  const pathname = usePathname();
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  // Ask Fomo / Save action-row state — mirrors components/fomo/Card.tsx's
  // own `saved`/`busy` local state, since the sheet hand-rolls the same four
  // actions rather than rendering FomoCard directly (see handleToggleSave).
  const [saved, setSaved] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);

  const { coords } = useGeolocation();

  const { city } = useSelectedCity();
  const destination = city.name;

  // Fetch places whenever the destination, category, or free-text search
  // changes. Debounced 300ms so typing doesn't fire a request per keystroke —
  // `visiblePlaces` below gives an instant local narrowing while this is in
  // flight. Non-empty search drives a real Google Text Search (not
  // constrained to the active category, since free-text intent overrides it);
  // an empty search falls back to the existing category fetch.
  useEffect(() => {
    if (!destination) return; // guards the initial mount — loading stays true
    let cancelled = false;
    const trimmedSearch = search.trim();
    // Explicitly send `limit` — see the null-vs-0 guard comment in
    // app/api/places/route.ts: relying on the route's own default here would
    // work today, but pinning it keeps this page's page-size decision
    // visible and independent of the API's default changing later.
    const params = new URLSearchParams({ destination, limit: String(PLACES_LIMIT) });
    if (trimmedSearch) {
      params.set("q", trimmedSearch);
    } else if (activeSlug) {
      params.set("category", activeSlug);
    }
    const timer = setTimeout(() => {
      (async () => {
        setLoading(true);
        try {
          const res = await fetch(`/api/places?${params.toString()}`);
          const data = (await res.json()) as PlacesResponse;
          if (cancelled) return;
          setPlaces(data.places ?? []);
          setCenter(data.center);
          setDegraded(data.degraded ?? null);
        } catch (err) {
          if (!cancelled) console.error("[map] places load failed", err);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destination, activeSlug, search]);

  // Instant local narrowing over the currently loaded places (name/category/
  // address) while the debounced search fetch above is in flight.
  //
  // NOTE: this deliberately does NOT also re-filter by `activeSlug` client
  // side. `place.category` is not a consistent slug across sources — curated
  // seed/DB rows store the filter slug ("food"), but live Google-sourced
  // rows store a humanized Google place type ("japanese restaurant",
  // "tourist attraction", etc, see lib/places/google.ts's humanizeType). An
  // exact-match client filter against `activeSlug` would silently blank out
  // every live-Google result. The server is the correct place to enforce the
  // category scope (it already does, across all three places.ts code paths:
  // live searchPlaces(category), listPlacesByCategory(category) DB fallback,
  // and — for search — searchPlacesByName) so no client-side re-filter here.
  const visiblePlaces = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return places;
    return places.filter((p) =>
      [p.name, p.category, p.address]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q))
    );
  }, [places, search]);

  // Nearest-to-farthest from the device's live location; unchanged order
  // when location is unavailable/denied. Only the "Nearby Places" list order
  // changes -- map pins/centering stay destination-driven, unrelated to this.
  const sortedVisiblePlaces = useMemo(
    () => sortByDistance(visiblePlaces, coords, placeCoords),
    [visiblePlaces, coords]
  );
  const nearbyRootRef = useRef<HTMLDivElement>(null);
  const nearbySentinelRef = useRef<HTMLDivElement>(null);
  const nearbyVisibleCount = useProgressiveReveal(
    sortedVisiblePlaces.length,
    nearbyRootRef,
    nearbySentinelRef
  );

  // Memoized so it's a stable reference into MapCanvas's marker-creation
  // effect deps — otherwise every re-render (e.g. the sheet opening/closing)
  // would re-drop all markers.
  const handleMarkerClick = useCallback(
    (place: Place) => {
      setSelectedPlace(place);
      setSaved(false);
      // Seed the Save toggle's current state the same way.
      isSaved(db, "place", place.id)
        .then(setSaved)
        .catch((err) => console.error("[map] saved lookup failed", err));
    },
    [db]
  );

  function closePlaceSheet() {
    setSelectedPlace(null);
  }

  // handleAddToTrip lived here. Fomo has no itinerary — a map pin's only
  // contextual action is now the save toggle below, plus Directions.

  /** Save toggle — same upsert/delete semantics as FomoCard's `handleSave`. */
  async function handleToggleSave() {
    if (!selectedPlace || saveBusy) return;
    setSaveBusy(true);
    try {
      if (saved) {
        await unsaveItem(db, "place", selectedPlace.id);
        setSaved(false);
      } else {
        await saveItem(db, {
          subject_type: "place",
          subject_id: selectedPlace.id,
          note: null,
        });
        setSaved(true);
        void recordCardSignal(db, {
          card_type: "map",
          subject_type: "place",
          subject_id: selectedPlace.id,
          action: "saved",
        });
      }
    } catch (err) {
      console.error("[map] save toggle failed", err);
    } finally {
      setSaveBusy(false);
    }
  }

  // "Ask Fomo" deep-link for the currently-open place-detail sheet — same
  // helper/params FomoCard uses, seeded from the raw Place row.
  const askHref = selectedPlace
    ? buildAskFomoHref({
        type: "place",
        id: selectedPlace.id,
        name: selectedPlace.name ?? "This place",
        coords: placeCoords(selectedPlace),
        returnTo: pathname,
      })
    : null;

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* Top app bar */}
      <header className="sticky top-0 z-40 flex min-h-[48px] items-center justify-between bg-background/90 px-5 pt-safe backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Icon name="explore" className="shrink-0 text-primary" />
        </div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-outline-variant bg-surface-container-lowest">
          <Icon name="person" size={18} className="text-on-surface-variant" />
        </div>
      </header>

      <div className="flex flex-col gap-4 px-5">
        {/* TODO(deals): the design replaces this with an All Places ⇄ Deals
            toggle once happenings land on the map. */}
        <>
            {/* Search bar — free-text place search (debounced, queries Google) */}
            <div className="flex h-12 items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 shadow-sm">
              <Icon name="search" size={20} className="text-primary" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search places…"
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

            {/* Category filter chips — drive the /api/places query */}
            <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [&::-webkit-scrollbar]:hidden">
              {CATEGORY_FILTERS.map((c) => (
                <Chip
                  key={c.slug}
                  label={c.label}
                  leadingIcon={c.icon}
                  selected={activeSlug === c.slug}
                  onClick={() =>
                    setActiveSlug((prev) => (prev === c.slug ? null : c.slug))
                  }
                />
              ))}
            </div>
        </>

        {/* Real Mapbox map (or a token-missing placeholder) */}
        <MapCanvas
          center={center}
          places={sortedVisiblePlaces}
          activeSlug={activeSlug}
          onMarkerClick={handleMarkerClick}
        />

        {degraded ? (
          <p className="text-label-sm text-on-surface-variant">
            {degraded === "no-google-key"
              ? "Showing sample places — add GOOGLE_PLACES_API_KEY for live data."
              : degraded === "cache-unavailable"
                ? "Live places shown; run the places migration to enable full detail links."
                : "Couldn't reach live places — showing samples."}
          </p>
        ) : null}

      </div>

      {/* Nearby place cards */}
      <section className="flex flex-col gap-3 pt-2">
        <h2 className="px-5 text-headline-md text-primary">Nearby Places</h2>
        {loading ? (
          <div className="flex justify-center px-5 py-6">
            <Icon name="hourglass_top" size={28} className="animate-pulse text-primary" />
          </div>
        ) : sortedVisiblePlaces.length === 0 ? (
          <p className="px-5 text-body-md text-on-surface-variant">
            {search ? "No places found for that search." : "No places nearby yet."}
          </p>
        ) : (
          <div
            ref={nearbyRootRef}
            className="flex gap-4 overflow-x-auto px-5 pb-2 snap-x snap-mandatory [&::-webkit-scrollbar]:hidden"
          >
            {sortedVisiblePlaces.slice(0, nearbyVisibleCount).map((place) => {
              const tip = firstTip(place.tips);
              return (
                <Link
                  key={place.id}
                  href={`/place/${place.id}`}
                  className="flex w-[85vw] max-w-[300px] shrink-0 snap-center flex-col overflow-hidden rounded-lg border border-l-4 border-outline-variant/60 border-l-primary bg-surface-container-lowest shadow-md transition-shadow hover:shadow-lg"
                >
                  <div className="relative h-[120px] w-full bg-surface-container">
                    {place.image_url ? (
                      <SmartImage
                        src={place.image_url}
                        alt={place.name ?? ""}
                        width={300}
                        height={120}
                        sizes="(max-width: 300px) 85vw, 300px"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Icon name="image" className="text-outline" />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 p-4">
                    <h3 className="text-headline-sm text-on-surface">{place.name}</h3>
                    <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">
                      {place.rating ? (
                        <span className="flex items-center gap-0.5 text-secondary">
                          <Icon name="star" filled size={14} /> {place.rating}
                        </span>
                      ) : null}
                      {place.rating && place.category ? <span>&bull;</span> : null}
                      {place.category ? <span className="capitalize">{place.category}</span> : null}
                    </div>
                    {tip ? (
                      <div className="mt-2 flex items-start gap-2 rounded-lg border border-primary-fixed-dim bg-primary-fixed p-2 text-on-primary-fixed-variant">
                        <Icon name="info" size={16} className="mt-0.5 text-primary" />
                        <p className="text-label-md">{tip}</p>
                      </div>
                    ) : null}
                  </div>
                </Link>
              );
            })}
            <div ref={nearbySentinelRef} className="w-px shrink-0" />
          </div>
        )}
      </section>

      {/* Marker tap → quick place card (view details / add to trip) */}
      <BottomSheet
        open={selectedPlace !== null}
        onClose={closePlaceSheet}
        title={selectedPlace?.name ?? ""}
      >
        {selectedPlace ? (
          <div className="flex flex-col gap-3">
            {/* Photo — same field (Place.image_url) as the Nearby Places
                cards and the place detail hero, so any place that has a
                photo there has one here too. */}
            <div className="relative h-[140px] w-full overflow-hidden rounded-xl bg-surface-container">
              {selectedPlace.image_url ? (
                <SmartImage
                  src={selectedPlace.image_url}
                  alt={selectedPlace.name ?? ""}
                  width={480}
                  height={140}
                  sizes="(max-width: 480px) 100vw, 480px"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Icon name="image" size={28} className="text-outline" />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 text-label-sm text-on-surface-variant">
              {selectedPlace.rating ? (
                <span className="flex items-center gap-0.5 text-secondary">
                  <Icon name="star" filled size={14} /> {selectedPlace.rating}
                </span>
              ) : null}
              {selectedPlace.rating && selectedPlace.category ? <span>&bull;</span> : null}
              {selectedPlace.category ? (
                <span className="capitalize">{selectedPlace.category}</span>
              ) : null}
            </div>
            {/* Short description — same fallback text pattern as the place
                detail page (app/(shell)/place/[id]/page.tsx) for places with
                no editorial description yet. */}
            <p className="text-body-md text-on-surface-variant">
              {selectedPlace.description ??
                `${selectedPlace.category ?? "Spot"} near ${selectedPlace.station ?? "your route"} — a Fomo pick worth the detour.`}
            </p>
            {selectedPlace.address ? (
              <p className="flex items-start gap-2 text-body-md text-on-surface-variant">
                <Icon name="location_on" size={18} className="mt-0.5 shrink-0 text-primary" />
                {selectedPlace.address}
              </p>
            ) : null}
            {/* Same action-row shape as FomoCard's hero variant: primary
                contextual verb / Ask Fomo / Directions / Save. The map pin
                keeps this inline (v1.1 W3's one legitimate map exception)
                rather than sending the user to /place/[id] for it — "View
                full details" below is the one that does. */}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {askHref ? (
                <Link
                  href={askHref}
                  onClick={() =>
                    void recordCardSignal(db, {
                                  card_type: "map",
                      subject_type: "place",
                      subject_id: selectedPlace.id,
                      action: "opened",
                    })
                  }
                  className="flex min-h-[44px] flex-1 basis-[45%] items-center justify-center gap-2 rounded-xl border border-outline-variant px-4 text-label-md font-semibold text-primary transition-opacity hover:opacity-90"
                >
                  <Icon name="chat" size={18} />
                  Ask Fomo
                </Link>
              ) : null}
              {buildDirectionsUrl(selectedPlace) ? (
                <a
                  href={buildDirectionsUrl(selectedPlace) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Get directions"
                  className="flex min-h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-outline-variant text-primary transition-opacity hover:opacity-90"
                >
                  <Icon name="directions" size={20} />
                </a>
              ) : null}
              <button
                type="button"
                aria-label={saved ? "Remove from saved" : "Save"}
                onClick={handleToggleSave}
                disabled={saveBusy}
                className="flex min-h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-outline-variant text-primary transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                <Icon name={saved ? "bookmark" : "bookmark_add"} filled={saved} size={20} />
              </button>
            </div>
            <Link
              href={`/place/${selectedPlace.id}`}
              className="text-center text-label-md font-semibold text-primary hover:underline"
            >
              View full details
            </Link>
          </div>
        ) : null}
      </BottomSheet>
    </div>
  );
}
