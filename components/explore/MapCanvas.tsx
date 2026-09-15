"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Place } from "@/lib/types";
import type { ExplorePin } from "@/lib/explore/types";
import { PIN_TYPE_STYLE } from "@/lib/explore/pin-style";
import { Icon } from "@/components/ui";

/** Marker tint per category slug (default-marker color) — the old Japan-trip
 *  chip slugs (map/page.tsx's own CATEGORY_FILTERS). Unrelated to
 *  PIN_TYPE_STYLE below, which colors Explore's `pins` prop instead. */
const CATEGORY_COLOR: Record<string, string> = {
  food: "#fc8a40",
  photo: "#2f6f6f",
  lockers: "#6b5bd2",
  transport: "#0b7285",
};
const DEFAULT_MARKER_COLOR = "#031632";

/** Fallback center (Edinburgh, [lng, lat]) when nothing else sets the view. */
const DEFAULT_CENTER: [number, number] = [-3.1883, 55.9533];

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

export interface MapBounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export interface MapCanvasHandle {
  /** Fly to a point. Programmatic — does NOT trigger `onBoundsChange` (see the moveend handler below), so callers (neighbourhood chips, "Near me") don't spuriously surface "Search this area". */
  flyTo(center: { lat: number; lng: number }, zoom?: number): void;
  /** Fit the viewport to a set of pins (single pin: pan+zoom in; 2+: fitBounds). No-op on an empty array. */
  fitToPins(pins: { lat: number; lng: number }[]): void;
}

export interface MapCanvasProps {
  center: { lat: number; lng: number } | null;
  /** Legacy Place-based marker set (map/page.tsx). Ignored once `pins` is supplied. */
  places?: Place[];
  activeSlug?: string | null;
  markerColor?: string;
  fitToPlaces?: boolean;
  onMarkerClick?: (place: Place) => void;
  /** Explore's lightweight pin set — colour-coded by `pin.type` via PIN_TYPE_STYLE. Takes over marker rendering from `places` when present (even an empty array). */
  pins?: ExplorePin[];
  /** Fires on a USER-driven pan/zoom (has a real DOM originalEvent — a `flyTo`/`fitBounds` call from this component's own imperative handle does not) with the map's new visible bounds. Backs the "Search this area" button. */
  onBoundsChange?: (bounds: MapBounds) => void;
  /** Highlights this pin's marker (bigger, elevated) — set on results-list card tap. */
  selectedPinId?: string | null;
  onPinClick?: (pin: ExplorePin) => void;
  /** Taller Explore-mode map. Defaults to the legacy h-64 (256px) box. */
  heightClassName?: string;
}

/**
 * The Mapbox GL canvas. Renders a clear placeholder when
 * NEXT_PUBLIC_MAPBOX_TOKEN is unset so the app never crashes. Initializes the
 * map once (guarded against React's dev double-effect), recenters when the
 * geocoded center arrives, and re-drops markers when the place/pin set
 * changes. `forwardRef` exposes `flyTo`/`fitToPins` (MapCanvasHandle) for
 * Explore's "Near me" button and neighbourhood chips.
 */
export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas(
  {
    center,
    places = [],
    activeSlug = null,
    markerColor,
    fitToPlaces,
    onMarkerClick,
    pins,
    onBoundsChange,
    selectedPinId,
    onPinClick,
    heightClassName = "h-64",
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  // Latest callback in a ref so the one-time map-init effect (and the
  // moveend listener it attaches) never has to re-run just because a parent
  // re-render passed a new function identity.
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;

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
    // `originalEvent` is only set on a user-driven interaction (drag, wheel,
    // pinch, the built-in nav control) — a programmatic `flyTo`/`fitBounds`
    // (this component's own imperative handle, or the recenter effect below)
    // fires moveend too but WITHOUT one, so this only ever reports real pans.
    const handleMoveEnd = (e: mapboxgl.MapEventOf<"moveend">) => {
      if (!e.originalEvent || !onBoundsChangeRef.current) return;
      const b = map.getBounds();
      if (!b) return;
      onBoundsChangeRef.current({
        minLat: b.getSouth(),
        minLng: b.getWest(),
        maxLat: b.getNorth(),
        maxLng: b.getEast(),
      });
    };
    map.on("moveend", handleMoveEnd);
    return () => {
      map.off("moveend", handleMoveEnd);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init-once; `center` only seeds the FIRST paint, see the dedicated recenter effect below.
  }, []);

  // Recenter when a geocoded center arrives / changes (legacy `map`/`places`
  // pages, which drive the map purely off `center`). Explore drives its
  // camera via the imperative handle instead, so this stays harmless there.
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.flyTo({ center: [center.lng, center.lat], zoom: 12, essential: true });
  }, [center]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(c, zoom = 15) {
        mapRef.current?.flyTo({ center: [c.lng, c.lat], zoom, essential: true });
      },
      fitToPins(list) {
        const map = mapRef.current;
        if (!map || list.length === 0) return;
        if (list.length === 1) {
          map.flyTo({ center: [list[0].lng, list[0].lat], zoom: 14, essential: true });
          return;
        }
        const coords: [number, number][] = list.map((p) => [p.lng, p.lat]);
        const bounds = coords.reduce(
          (b, c) => b.extend(c),
          new mapboxgl.LngLatBounds(coords[0], coords[0])
        );
        map.fitBounds(bounds, { padding: 56, maxZoom: 15, essential: true });
      },
    }),
    []
  );

  // Re-drop markers when the pin set changes (Explore's colour-coded path).
  useEffect(() => {
    if (!pins) return; // legacy `places` path (below) owns markers instead.
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    for (const pin of pins) {
      const isSelected = pin.id === selectedPinId;
      const el = document.createElement("div");
      el.style.width = isSelected ? "30px" : "22px";
      el.style.height = isSelected ? "30px" : "22px";
      el.style.borderRadius = "50%";
      el.style.background = PIN_TYPE_STYLE[pin.type].color;
      el.style.border = isSelected ? "3px solid white" : "2px solid white";
      el.style.boxShadow = isSelected
        ? "0 2px 10px rgba(3,22,50,0.45)"
        : "0 1px 4px rgba(3,22,50,0.35)";
      el.style.cursor = "pointer";
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", pin.title);
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([pin.lng, pin.lat])
        .addTo(map);
      el.addEventListener("click", () => onPinClick?.(pin));
      markersRef.current.push(marker);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onPinClick intentionally excluded, it's stable per-render-cycle enough and including it would re-drop markers on every parent re-render.
  }, [pins, selectedPinId]);

  // Re-drop markers when the place set (or category color) changes — legacy
  // path, untouched, only runs when the caller passes `places` and not `pins`.
  useEffect(() => {
    if (pins) return;
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
  }, [places, activeSlug, markerColor, fitToPlaces, onMarkerClick, pins]);

  if (!MAPBOX_TOKEN) {
    return (
      <div
        className={`flex ${heightClassName} w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-outline-variant/70 bg-surface-container text-center`}
      >
        <Icon name="map" size={40} className="text-outline-variant" />
        <p className="max-w-[240px] text-label-md text-on-surface-variant">
          The map isn&apos;t available right now — the list below still works.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`${heightClassName} w-full overflow-hidden rounded-xl border border-outline-variant/60 bg-surface-container`}
    />
  );
});
