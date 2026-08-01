"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  getCurrentTrip,
  createItem,
  deleteItem,
  isSaved,
  listItems,
  listPlacesByIds,
  recordCardSignal,
  saveItem,
  unsaveItem,
} from "@/lib/db";
import { useDeviceId } from "@/lib/device";
import { buildDirectionsUrl } from "@/lib/maps/links";
import { buildAskRoameoHref } from "@/lib/chat-seed";
import type { ItineraryItem, Place, Trip } from "@/lib/types";
import { sortByDistance, useGeolocation, type Coordinates } from "@/lib/geo";
import { useProgressiveReveal } from "@/lib/useProgressiveReveal";
import { BottomSheet, Chip, Icon, SegmentedControl } from "@/components/ui";
import { TripSwitcher } from "@/components/shell/TripSwitcher";

type MapMode = "explore" | "itinerary";

/** Place coordinate extractor for sortByDistance. */
function placeCoords(place: Place): Coordinates | null {
  return place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null;
}

function parseDate(d: string): Date {
  return new Date(`${d}T00:00:00`);
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Same day-range walk as app/(shell)/plan/page.tsx's eachDateInRange. */
function eachDateInRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = parseDate(start);
  const last = parseDate(end);
  while (cur.getTime() <= last.getTime()) {
    out.push(toISODate(cur));
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return out;
}

function formatDayLabel(iso: string): { weekday: string; day: string } {
  const d = parseDate(iso);
  return {
    weekday: d.toLocaleDateString("en-US", { weekday: "short" }),
    day: String(d.getDate()),
  };
}

/** Category chip → the slug the /api/places route understands. */
const CATEGORY_FILTERS: { label: string; icon: string; slug: string }[] = [
  { label: "Food", icon: "restaurant", slug: "food" },
  { label: "Photo spots", icon: "camera_alt", slug: "photo" },
  { label: "Lockers", icon: "vpn_key", slug: "lockers" },
  { label: "Transport", icon: "directions_transit", slug: "transport" },
];

/** Marker tint per category slug (default-marker color). */
const CATEGORY_COLOR: Record<string, string> = {
  food: "#fc8a40", // sunset orange
  photo: "#2f6f6f",
  lockers: "#6b5bd2",
  transport: "#0b7285",
};
const DEFAULT_MARKER_COLOR = "#031632"; // navy
const ITINERARY_MARKER_COLOR = "#22c55e"; // green — matches the "Activity" legend dot on /plan

/** Fallback center (Tokyo) when geocoding is unavailable. */
const DEFAULT_CENTER: [number, number] = [139.767, 35.681];

// Matches /api/places' new default (app/api/places/route.ts) — sent
// explicitly so the Map page's page size stays visible here rather than
// depending on whatever the route defaults to.
const PLACES_LIMIT = 24;

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

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
  const deviceId = useDeviceId();
  const pathname = usePathname();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [tripChecked, setTripChecked] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [addState, setAddState] = useState<
    "idle" | "adding" | "added" | "removing" | "error"
  >("idle");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  // Ask Roameo / Save action-row state — mirrors components/roameo/Card.tsx's
  // own `saved`/`busy` local state, since the sheet hand-rolls the same four
  // actions rather than rendering RoameoCard directly (see handleToggleSave).
  const [saved, setSaved] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);

  // "My itinerary" mode — shows only places already saved to the trip
  // (scoped to a day) instead of the nearby-places search above.
  const [mapMode, setMapMode] = useState<MapMode>("explore");
  const [items, setItems] = useState<ItineraryItem[]>([]);
  const [itineraryDay, setItineraryDay] = useState<string | null>(null);
  const [placesById, setPlacesById] = useState<Record<string, Place>>({});
  const { coords } = useGeolocation();

  const destination = trip?.destination ?? null;

  // Load the active trip. No auto-seed — a device with no trip gets an empty
  // state that routes into the create-trip flow.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const t = await getCurrentTrip(deviceId);
        if (!cancelled) setTrip(t);
      } catch (err) {
        console.error("[map] trip load failed", err);
      } finally {
        if (!cancelled) setTripChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

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

  // Days spanned by the trip, for the "My itinerary" day scroller — same
  // derivation as app/(shell)/plan/page.tsx.
  const tripStartDate = trip?.start_date ?? null;
  const tripEndDate = trip?.end_date ?? null;
  const days = useMemo(
    () => (tripStartDate && tripEndDate ? eachDateInRange(tripStartDate, tripEndDate) : []),
    [tripStartDate, tripEndDate]
  );

  // Default to today if the trip covers it, else the trip's first day —
  // matches the "how far are today's spots" use case without extra taps.
  // Adjusting state during render (converging: the guard is false once set)
  // mirrors app/(shell)/plan/page.tsx's selectedDay default, and avoids the
  // extra render + effect a useEffect version would need for the same result.
  if (!itineraryDay && days.length > 0) {
    const today = toISODate(new Date());
    setItineraryDay(days.includes(today) ? today : days[0]);
  }

  // Load the trip's itinerary items once the trip is known, and refetch on
  // tab focus — items get added from chat/place-detail/90-minute-wins too,
  // same "reload on focus" pattern as app/(shell)/plan/page.tsx (items only
  // ever loaded once on mount otherwise, so adds elsewhere wouldn't show up
  // here without a hard reload).
  useEffect(() => {
    if (!deviceId || !trip) return;
    let cancelled = false;
    async function refetch() {
      if (!deviceId || !trip) return;
      try {
        const rows = await listItems(deviceId, trip.id);
        if (!cancelled) setItems(rows);
      } catch (err) {
        console.error("[map] itinerary load failed", err);
      }
    }
    void refetch();
    function onVisibilityChange() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
    };
  }, [deviceId, trip]);

  // Resolve the distinct place_ids referenced by the trip's items into full
  // Place rows (lat/lng, name, etc.) — items only store a place_id, not
  // coordinates directly.
  useEffect(() => {
    const ids = Array.from(new Set(items.map((it) => it.place_id).filter((id): id is string => !!id)));
    let cancelled = false;
    (async () => {
      if (ids.length === 0) {
        if (!cancelled) setPlacesById({});
        return;
      }
      try {
        const rows = await listPlacesByIds(ids);
        if (cancelled) return;
        setPlacesById(Object.fromEntries(rows.map((p) => [p.id, p])));
      } catch (err) {
        console.error("[map] itinerary place resolve failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  // Fallback for items with no place_id (manually-typed / seeded items,
  // predating the Google-Places item-form search): resolve their free-text
  // `location` (or `title` if no location) via /api/places?q= — the same
  // destination-scoped Google Places Text Search the item form's picker
  // uses. Deliberately NOT /api/geocode (unbiased worldwide Mapbox place
  // geocoding) — a bare business name like "Nagi Shokudo" or "Hama-rikyu
  // Gardens" has no city context on its own and Mapbox will happily match it
  // to some unrelated place on the other side of the planet; scoping the
  // search to `destination` (as /api/places does) is what keeps the match in
  // Tokyo. Keyed by query string so a day with repeated locations only
  // resolves once.
  const [geocodedByQuery, setGeocodedByQuery] = useState<Record<string, { lat: number; lng: number }>>({});

  useEffect(() => {
    if (!destination) return;
    const pending = Array.from(
      new Set(
        items
          .filter((it) => !it.place_id)
          .map((it) => (it.location || it.title || "").trim())
          .filter((q) => q && !(q in geocodedByQuery))
      )
    );
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        pending.map(async (q) => {
          try {
            // Only the first hit is used below — limit=1 keeps this
            // per-item geocode resolve cheap instead of pulling a full page.
            const params = new URLSearchParams({ destination, q, limit: "1" });
            const res = await fetch(`/api/places?${params.toString()}`);
            const data = (await res.json()) as { places?: Place[] };
            const hit = data.places?.[0];
            return [
              q,
              hit && typeof hit.lat === "number" && typeof hit.lng === "number"
                ? { lat: hit.lat, lng: hit.lng }
                : null,
            ] as const;
          } catch (err) {
            console.error("[map] itinerary place resolve failed", q, err);
            return [q, null] as const;
          }
        })
      );
      if (cancelled) return;
      setGeocodedByQuery((prev) => {
        const next = { ...prev };
        for (const [q, center] of entries) if (center) next[q] = center;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [items, geocodedByQuery, destination]);

  // Places to plot in "My itinerary" mode: the selected day's items, each
  // resolved either from its linked `place_id` (exact) or, failing that, a
  // geocoded approximation of its free-text location. Only an item with
  // neither a place_id nor any location/title text to geocode is skipped.
  const itineraryPlaces = useMemo(() => {
    if (!itineraryDay) return [];
    const out: Place[] = [];
    for (const it of items) {
      if (it.day_date !== itineraryDay) continue;
      if (it.place_id) {
        const p = placesById[it.place_id];
        if (p) out.push(p);
        continue;
      }
      const query = (it.location || it.title || "").trim();
      const center = query ? geocodedByQuery[query] : undefined;
      if (!center) continue;
      out.push({
        id: it.id,
        name: it.title,
        category: it.category,
        rating: null,
        image_url: null,
        distance_label: null,
        tips: [],
        reviews: [],
        hours: null,
        station: null,
        badges: [],
        google_place_id: null,
        lat: center.lat,
        lng: center.lng,
        address: it.location,
        price_level: null,
        destination: null,
        source: "itinerary-geocode",
        fetched_at: null,
        city: null,
        prefecture: null,
        country: null,
        description: null,
        last_verified_at: null,
        hours_status: null,
        opening_hours: null,
        mention_count: 0,
        mention_sources: null,
        detail_line: null,
        image_quality: null,
      });
    }
    return out;
  }, [items, itineraryDay, placesById, geocodedByQuery]);

  // Memoized so it's a stable reference into MapCanvas's marker-creation
  // effect deps — otherwise every re-render (e.g. the sheet opening/closing)
  // would re-drop all markers.
  const handleMarkerClick = useCallback(
    (place: Place) => {
      setSelectedPlace(place);
      setAddState("idle");
      setSelectedItemId(null);
      setSaved(false);
      // Seed "already added" state so a place added on a previous tap shows
      // "Remove from trip" instead of a clickable "Add" with no way back.
      if (deviceId && trip) {
        listItems(deviceId, trip.id)
          .then((items) => {
            const match = items.find(
              (it) => it.title?.trim().toLowerCase() === place.name?.trim().toLowerCase()
            );
            if (match) {
              setAddState("added");
              setSelectedItemId(match.id);
            }
          })
          .catch((err) => console.error("[map] itinerary lookup failed", err));
      }
      // Seed the Save toggle's current state the same way.
      if (deviceId) {
        isSaved(deviceId, "place", place.id)
          .then(setSaved)
          .catch((err) => console.error("[map] saved lookup failed", err));
      }
    },
    [deviceId, trip]
  );

  function closePlaceSheet() {
    setSelectedPlace(null);
  }

  /**
   * Primary contextual action — "Add to today", matching RoameoCard's
   * `handleAdd` semantics (components/roameo/Card.tsx): scheduled at today's
   * date / right now, not the trip's start date, since a user tapping this
   * from a live map pin means "put it on today", not "put it on day one".
   */
  async function handleAddToTrip() {
    if (!deviceId || !trip || !selectedPlace || addState === "adding" || addState === "added") return;
    setAddState("adding");
    try {
      const now = new Date();
      const created = await createItem(deviceId, {
        trip_id: trip.id,
        place_id: selectedPlace.id,
        title: selectedPlace.name,
        category: selectedPlace.category,
        location: selectedPlace.station ?? selectedPlace.name,
        day_date: toISODate(now),
        time_label: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        starts_at: now.toISOString(),
      });
      setSelectedItemId(created.id);
      setAddState("added");
      void recordCardSignal({
        device_id: deviceId,
        trip_id: trip.id,
        card_type: "map",
        subject_type: "place",
        subject_id: selectedPlace.id,
        action: "planned",
      });
    } catch (err) {
      console.error("[map] add to trip failed", err);
      setAddState("error");
    }
  }

  /** Save toggle — same upsert/delete semantics as RoameoCard's `handleSave`. */
  async function handleToggleSave() {
    if (!deviceId || !selectedPlace || saveBusy) return;
    setSaveBusy(true);
    try {
      if (saved) {
        await unsaveItem(deviceId, "place", selectedPlace.id);
        setSaved(false);
      } else {
        await saveItem({
          device_id: deviceId,
          trip_id: trip?.id ?? null,
          subject_type: "place",
          subject_id: selectedPlace.id,
          note: null,
        });
        setSaved(true);
        void recordCardSignal({
          device_id: deviceId,
          trip_id: trip?.id ?? null,
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

  /** Un-add: same `deleteItem` used by the chat and reel-detail remove flows
   * — no new itinerary-removal code needed, just wiring it up here too. */
  async function handleRemoveFromTrip() {
    if (!deviceId || !selectedItemId || addState === "removing") return;
    setAddState("removing");
    try {
      await deleteItem(deviceId, selectedItemId);
      setSelectedItemId(null);
      setAddState("idle");
    } catch (err) {
      console.error("[map] remove from trip failed", err);
      setAddState("error");
    }
  }

  // "Ask Roameo" deep-link for the currently-open place-detail sheet — same
  // helper/params RoameoCard uses, seeded from the raw Place row.
  const askHref = selectedPlace
    ? buildAskRoameoHref({
        type: "place",
        id: selectedPlace.id,
        name: selectedPlace.name ?? "This place",
        coords: placeCoords(selectedPlace),
        returnTo: pathname,
      })
    : null;

  // No active trip — invite the traveler to create one (map needs a destination).
  if (tripChecked && !trip) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-40 flex min-h-[48px] items-center gap-3 bg-background/90 px-5 pt-safe backdrop-blur-sm">
          <Icon name="explore" className="text-primary" />
          <h1 className="text-headline-sm text-primary">Map</h1>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-fixed text-primary">
            <Icon name="map" size={40} filled />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-headline-md text-primary">No trip to explore yet</h2>
            <p className="text-body-lg text-on-surface-variant">
              Create a trip and Roameo will map the best spots around your
              destination.
            </p>
          </div>
          <Link
            href="/plan/new-trip"
            className="mt-2 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
          >
            <Icon name="add" size={20} />
            Create a trip
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* Top app bar */}
      <header className="sticky top-0 z-40 flex min-h-[48px] items-center justify-between bg-background/90 px-5 pt-safe backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Icon name="explore" className="shrink-0 text-primary" />
          <TripSwitcher currentTrip={trip} />
        </div>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-outline-variant bg-surface-container-lowest">
          <Icon name="person" size={18} className="text-on-surface-variant" />
        </div>
      </header>

      <div className="flex flex-col gap-4 px-5">
        {/* Explore (nearby search) ⇄ My itinerary (saved trip places only) */}
        <SegmentedControl<MapMode>
          value={mapMode}
          onChange={setMapMode}
          options={[
            { value: "explore", label: "Explore", icon: "explore" },
            { value: "itinerary", label: "My itinerary", icon: "map" },
          ]}
          className="w-full"
        />

        {mapMode === "explore" ? (
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
        ) : (
          /* Day scroller — scopes "My itinerary" pins to one day at a time,
             same horizontal-chip pattern as app/(shell)/plan/page.tsx. */
          <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 pb-1">
            {days.map((iso) => {
              const { weekday, day } = formatDayLabel(iso);
              const active = iso === itineraryDay;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => setItineraryDay(iso)}
                  className={`flex h-14 min-w-[56px] shrink-0 flex-col items-center justify-center rounded-xl transition-all ${
                    active
                      ? "scale-105 bg-primary text-on-primary shadow-md"
                      : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container"
                  }`}
                >
                  <span className="text-[10px] font-medium uppercase tracking-wider">{weekday}</span>
                  <span className="mt-0.5 text-base font-bold">{day}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Real Mapbox map (or a token-missing placeholder) */}
        <MapCanvas
          center={center}
          places={mapMode === "explore" ? sortedVisiblePlaces : itineraryPlaces}
          activeSlug={activeSlug}
          markerColor={mapMode === "itinerary" ? ITINERARY_MARKER_COLOR : undefined}
          fitToPlaces={mapMode === "itinerary"}
          onMarkerClick={handleMarkerClick}
        />

        {mapMode === "explore" && degraded ? (
          <p className="text-label-sm text-on-surface-variant">
            {degraded === "no-google-key"
              ? "Showing sample places — add GOOGLE_PLACES_API_KEY for live data."
              : degraded === "cache-unavailable"
                ? "Live places shown; run the places migration to enable full detail links."
                : "Couldn't reach live places — showing samples."}
          </p>
        ) : null}

        {mapMode === "itinerary" && itineraryPlaces.length === 0 ? (
          <p className="text-label-sm text-on-surface-variant">
            No mappable places for this day yet — add an item with a searched
            location to see it here.
          </p>
        ) : null}
      </div>

      {/* Nearby place cards */}
      {mapMode === "explore" ? (
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
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={place.image_url}
                        alt={place.name ?? ""}
                        loading="lazy"
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
      ) : null}

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
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selectedPlace.image_url}
                  alt={selectedPlace.name ?? ""}
                  loading="lazy"
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
                `${selectedPlace.category ?? "Spot"} near ${selectedPlace.station ?? "your route"} — a Roameo pick worth the detour.`}
            </p>
            {selectedPlace.address ? (
              <p className="flex items-start gap-2 text-body-md text-on-surface-variant">
                <Icon name="location_on" size={18} className="mt-0.5 shrink-0 text-primary" />
                {selectedPlace.address}
              </p>
            ) : null}
            {/* Same four-action row as RoameoCard everywhere else: primary
                contextual verb / Ask Roameo / Directions / Save. */}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {trip ? (
                <button
                  type="button"
                  onClick={addState === "added" ? handleRemoveFromTrip : handleAddToTrip}
                  disabled={addState === "adding" || addState === "removing"}
                  className={`flex min-h-[44px] flex-1 basis-[45%] items-center justify-center gap-2 rounded-xl border px-4 text-label-md font-semibold transition-opacity hover:opacity-90 disabled:opacity-60 ${
                    addState === "added"
                      ? "border-error bg-error text-on-error"
                      : "border-outline-variant bg-secondary-container text-on-secondary-container"
                  }`}
                >
                  <Icon
                    name={addState === "added" ? "delete" : "add"}
                    size={18}
                  />
                  {addState === "added"
                    ? "Remove"
                    : addState === "adding"
                      ? "Adding…"
                      : addState === "removing"
                        ? "Removing…"
                        : addState === "error"
                          ? "Retry add"
                          : "Add to today"}
                </button>
              ) : null}
              {askHref ? (
                <Link
                  href={askHref}
                  onClick={() =>
                    deviceId &&
                    void recordCardSignal({
                      device_id: deviceId,
                      trip_id: trip?.id ?? null,
                      card_type: "map",
                      subject_type: "place",
                      subject_id: selectedPlace.id,
                      action: "opened",
                    })
                  }
                  className="flex min-h-[44px] flex-1 basis-[45%] items-center justify-center gap-2 rounded-xl border border-outline-variant px-4 text-label-md font-semibold text-primary transition-opacity hover:opacity-90"
                >
                  <Icon name="chat" size={18} />
                  Ask Roameo
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

/**
 * The Mapbox GL canvas. Renders a clear placeholder when
 * NEXT_PUBLIC_MAPBOX_TOKEN is unset so the app never crashes. Initializes the
 * map once (guarded against React's dev double-effect), recenters when the
 * geocoded center arrives, and re-drops markers when the place set changes.
 */
function MapCanvas({
  center,
  places,
  activeSlug,
  markerColor,
  fitToPlaces,
  onMarkerClick,
}: {
  center: { lat: number; lng: number } | null;
  places: Place[];
  activeSlug: string | null;
  /** Overrides the activeSlug/category-derived color — used by "My itinerary" mode. */
  markerColor?: string;
  /** Fit the viewport to `places` instead of relying on the geocoded
   * `center` — "My itinerary" mode's places can be anywhere in a multi-city
   * trip (e.g. a Kyoto day inside a "Tokyo Spring Trip"), nowhere near the
   * trip-destination center the Explore-mode search is biased around. */
  fitToPlaces?: boolean;
  onMarkerClick?: (place: Place) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);

  // Initialize the map exactly once (when a token + container exist).
  useEffect(() => {
    if (!MAPBOX_TOKEN || !containerRef.current || mapRef.current) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: center ? [center.lng, center.lat] : DEFAULT_CENTER,
      zoom: center ? 12 : 9,
      attributionControl: false,
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [center]);

  // Recenter when a geocoded center arrives / changes.
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center.lng, center.lat], zoom: 12, essential: true });
  }, [center]);

  // Re-drop markers when the place set (or category color) changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const color =
      markerColor ??
      (activeSlug ? (CATEGORY_COLOR[activeSlug] ?? DEFAULT_MARKER_COLOR) : DEFAULT_MARKER_COLOR);
    const coords: [number, number][] = [];
    for (const p of places) {
      if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;
      coords.push([p.lng, p.lat]);
      const marker = new mapboxgl.Marker({ color })
        .setLngLat([p.lng, p.lat])
        .setPopup(
          new mapboxgl.Popup({ offset: 24, closeButton: false }).setText(
            p.name ?? ""
          )
        )
        .addTo(map);
      // Tapping the pin opens the richer place card (BottomSheet) in
      // addition to Mapbox's bare default popup — the card is the primary
      // UX for viewing details / adding to trip.
      marker.getElement().addEventListener("click", () => {
        onMarkerClick?.(p);
      });
      markersRef.current.push(marker);
    }
    // "My itinerary" mode: fit the viewport to whatever pins actually exist
    // instead of the Explore-mode destination center, which can be a whole
    // country away from a day's real locations.
    if (fitToPlaces && coords.length > 0) {
      if (coords.length === 1) {
        map.flyTo({ center: coords[0], zoom: 13, essential: true });
      } else {
        const bounds = coords.reduce(
          (b, c) => b.extend(c),
          new mapboxgl.LngLatBounds(coords[0], coords[0])
        );
        map.fitBounds(bounds, { padding: 48, maxZoom: 14, essential: true });
      }
    }
  }, [places, activeSlug, markerColor, fitToPlaces, onMarkerClick]);

  if (!MAPBOX_TOKEN) {
    return (
      <div className="flex h-64 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-outline-variant/70 bg-surface-container text-center">
        <Icon name="map" size={40} className="text-outline-variant" />
        <p className="max-w-[240px] text-label-md text-on-surface-variant">
          Add <span className="font-semibold">NEXT_PUBLIC_MAPBOX_TOKEN</span> to
          your <span className="font-semibold">.env.local</span> to enable the
          live map.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-64 w-full overflow-hidden rounded-xl border border-outline-variant/60 bg-surface-container"
    />
  );
}
