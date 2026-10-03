"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Place } from "@/lib/types";
import type { ExplorePin, MapPick } from "@/lib/explore/types";
import {
  MARKER_HIGHLIGHT_RING,
  PIN_TYPE_STYLE,
  createPickMarkerElement,
  stylePickMarker,
} from "@/lib/explore/pin-style";
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
  // Desktop workspace props. All optional and inert when absent, so phone callers render exactly as before.
  /** Numbered "Fomo's picks" markers drawn above the normal pins. Memoise it: a new array re-drops the picks. */
  picks?: MapPick[];
  /** Pick key to emphasise (scaled up + accent ring) — set from a chat card hover or a marker hover. */
  highlightedPickKey?: string | null;
  onPickClick?: (key: string) => void;
  /** Fires with the pick's key on marker pointer enter, `null` on leave. */
  onPickHover?: (key: string | null) => void;
  /** Fires once the map instance exists (camera calls such as flyTo work from then on). */
  onMapReady?: () => void;
  /** Fade the normal pins back (picks are the focus). */
  dimPins?: boolean;
  /** Hide the normal pins entirely. */
  hidePins?: boolean;
  /** Pin id to emphasise (a hovered browse row). Unlike `selectedPinId` it never re-drops markers. */
  highlightedPinId?: string | null;
  /** Drop the rounded corners and border so the map can sit edge to edge in a panel layout. */
  flush?: boolean;
}

const DIMMED_PIN_FILTER = "opacity(0.35)";

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
    picks,
    highlightedPickKey = null,
    onPickClick,
    onPickHover,
    onMapReady,
    dimPins = false,
    hidePins = false,
    highlightedPinId = null,
    flush = false,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  // Per-id handles on the pin / pick marker elements so highlight, dim and
  // hide changes restyle them in place instead of re-dropping every marker.
  const pinElsRef = useRef<Map<string, HTMLElement>>(new Map());
  const pickMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const pickElsRef = useRef<Map<string, { el: HTMLElement; inner: HTMLElement }>>(new Map());
  // Latest callback in a ref so the one-time map-init effect (and the
  // moveend listener it attaches) never has to re-run just because a parent
  // re-render passed a new function identity.
  const onBoundsChangeRef = useRef(onBoundsChange);
  onBoundsChangeRef.current = onBoundsChange;
  // Same for the marker callbacks: the marker effects below deliberately don't
  // re-run on a callback identity change, so they read the latest one here.
  const onPinClickRef = useRef(onPinClick);
  onPinClickRef.current = onPinClick;
  const onPickClickRef = useRef(onPickClick);
  onPickClickRef.current = onPickClick;
  const onPickHoverRef = useRef(onPickHover);
  onPickHoverRef.current = onPickHover;
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;

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
    // A flex-sized container (desktop workspace) can change size without the
    // window resizing — e.g. the side panel toggling — which mapbox's own
    // window-resize listener never sees.
    const container = containerRef.current;
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => map.resize()) : null;
    resizeObserver?.observe(container);
    onMapReadyRef.current?.();
    return () => {
      resizeObserver?.disconnect();
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
    pinElsRef.current.clear();
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
      el.addEventListener("click", () => onPinClickRef.current?.(pin));
      markersRef.current.push(marker);
      pinElsRef.current.set(pin.id, el);
    }
  }, [pins, selectedPinId]);

  // Browse-pin emphasis for the desktop workspace: hovered row (bigger + ring),
  // dimmed behind Fomo's picks, or hidden. Restyles the existing elements, and
  // re-applies after every re-drop (it runs after the effect above). With the
  // props absent it only clears styles that were never set.
  useEffect(() => {
    pinElsRef.current.forEach((el, id) => {
      const highlighted = id === highlightedPinId;
      const selected = id === selectedPinId;
      el.style.visibility = hidePins ? "hidden" : "";
      el.style.filter = dimPins && !highlighted && !selected ? DIMMED_PIN_FILTER : "";
      el.style.zIndex = highlighted ? "5" : "";
      if (highlighted && !selected) {
        el.style.width = "28px";
        el.style.height = "28px";
        el.style.boxShadow = `0 0 0 3px ${MARKER_HIGHLIGHT_RING}, 0 2px 8px rgba(3,22,50,0.45)`;
      } else if (!selected) {
        el.style.width = "22px";
        el.style.height = "22px";
        el.style.boxShadow = "0 1px 4px rgba(3,22,50,0.35)";
      }
    });
  }, [pins, selectedPinId, highlightedPinId, dimPins, hidePins]);

  // Numbered "Fomo's picks" — their own marker set, above the normal pins.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pickMarkersRef.current.forEach((m) => m.remove());
    pickMarkersRef.current = [];
    pickElsRef.current.clear();
    for (const pick of picks ?? []) {
      const { el, inner } = createPickMarkerElement(pick.rank, pick.title);
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([pick.lng, pick.lat]).addTo(map);
      el.addEventListener("click", () => onPickClickRef.current?.(pick.key));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPickClickRef.current?.(pick.key);
        }
      });
      el.addEventListener("mouseenter", () => onPickHoverRef.current?.(pick.key));
      el.addEventListener("mouseleave", () => onPickHoverRef.current?.(null));
      el.addEventListener("focus", () => onPickHoverRef.current?.(pick.key));
      el.addEventListener("blur", () => onPickHoverRef.current?.(null));
      pickMarkersRef.current.push(marker);
      pickElsRef.current.set(pick.key, { el, inner });
    }
    const pickEls = pickElsRef.current;
    return () => {
      pickMarkersRef.current.forEach((m) => m.remove());
      pickMarkersRef.current = [];
      pickEls.clear();
    };
  }, [picks]);

  useEffect(() => {
    pickElsRef.current.forEach(({ el, inner }, key) => stylePickMarker(el, inner, key === highlightedPickKey));
  }, [picks, highlightedPickKey]);

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
          The map isn&apos;t available right now. The list below still works.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`${heightClassName} w-full overflow-hidden bg-surface-container${
        flush ? "" : " rounded-xl border border-outline-variant/60"
      }`}
    />
  );
});
