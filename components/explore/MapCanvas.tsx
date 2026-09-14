"use client";

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Place } from "@/lib/types";
import { Icon } from "@/components/ui";

/** Marker tint per category slug (default-marker color). */
const CATEGORY_COLOR: Record<string, string> = {
  food: "#fc8a40",
  photo: "#2f6f6f",
  lockers: "#6b5bd2",
  transport: "#0b7285",
};
const DEFAULT_MARKER_COLOR = "#031632";

/** Fallback center (Tokyo) when geocoding is unavailable. */
const DEFAULT_CENTER: [number, number] = [139.767, 35.681];

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

export interface MapCanvasProps {
  center: { lat: number; lng: number } | null;
  places: Place[];
  activeSlug: string | null;
  markerColor?: string;
  fitToPlaces?: boolean;
  onMarkerClick?: (place: Place) => void;
}

/**
 * The Mapbox GL canvas. Renders a clear placeholder when
 * NEXT_PUBLIC_MAPBOX_TOKEN is unset so the app never crashes. Initializes the
 * map once (guarded against React's dev double-effect), recenters when the
 * geocoded center arrives, and re-drops markers when the place set changes.
 */
export function MapCanvas({
  center,
  places,
  activeSlug,
  markerColor,
  fitToPlaces,
  onMarkerClick,
}: MapCanvasProps) {
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
