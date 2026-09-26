import "server-only";
import { getPreferences } from "@/lib/db/preferences";
import { listRecentSignals } from "@/lib/db/signals";
import { listSavedItems } from "@/lib/db/saved";
import { listPlacesByCity } from "@/lib/db/places";
import { getEventsForDestination } from "@/lib/events/getForDestination";
import { getExperiencesForDestination } from "@/lib/experiences/getForDestination";
import { getUserLocation } from "@/lib/db/location";
import { resolvePersona } from "@/lib/now/persona";
import { getForecastForDestination, pickForecastDay } from "@/lib/weather";
import { searchPlaces } from "@/lib/places/google";
import { CITY } from "@/lib/city";
import type { Coordinates } from "@/lib/geo";
import type { FeedContext } from "@/lib/now/types";
import type { Db } from "@/lib/supabase/types";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Curated-first, then live-Google, candidate place pool for this request.
 * Mirrors the fallback the old Home dashboard used (lib/db/places.ts
 * listPlacesByCity, then /api/places' live search) — the ranker calls the
 * same underlying helpers directly rather than round-tripping through its
 * own HTTP API.
 */
export async function loadCandidatePlaces(db: Db, coords: Coordinates | null) {
  try {
    const curated = await listPlacesByCity(db, CITY.name);
    if (curated.length > 0) return curated;
  } catch (err) {
    console.error("[now/context] curated places lookup failed", err);
  }
  if (!process.env.GOOGLE_PLACES_API_KEY) return [];
  try {
    const center = coords ?? CITY.center;
    const mapped = await searchPlaces({ destination: CITY.name, limit: 40, center });
    return mapped.map((m) => ({
      id: m.google_place_id,
      name: m.name,
      category: m.category,
      rating: m.rating,
      image_url: m.image_url,
      distance_label: null,
      tips: [],
      reviews: [],
      hours: null,
      station: null,
      badges: [],
      google_place_id: m.google_place_id,
      lat: m.lat,
      lng: m.lng,
      address: m.address,
      price_level: m.price_level,
      destination: m.destination,
      source: m.source,
      fetched_at: m.fetched_at,
      city: null,
      prefecture: null,
      country: m.country,
      description: null,
      last_verified_at: null,
      hours_status: null,
      opening_hours: null,
      mention_count: 0,
      mention_sources: null,
      detail_line: null,
      image_quality: m.image_url ? ("thin" as const) : ("none" as const),
    }));
  } catch (err) {
    console.error("[now/context] live places fallback failed", err);
    return [];
  }
}

export interface BuildContextInput {
  db: Db;
  at: Date;
  liveCoords: Coordinates | null;
}

/** Assembles everything the ranker's generators need for one request. Never throws — degrades field-by-field, since a Home open must always render something (plan-v1-home-pivot.md §4.5). */
export async function buildFeedContext(input: BuildContextInput): Promise<FeedContext> {
  const { db, at, liveCoords } = input;

  let coords = liveCoords;
  const coordsAreLive = liveCoords != null;
  if (!coords) {
    try {
      const stored = await getUserLocation(db);
      if (stored?.lat != null && stored.lng != null) {
        coords = { lat: stored.lat, lng: stored.lng };
      }
    } catch (err) {
      console.error("[now/context] user_location fallback failed", err);
    }
  }

  const [prefs, recentSignals, savedItems] = await Promise.all([
    getPreferences(db).catch(() => null),
    listRecentSignals(db).catch(() => []),
    listSavedItems(db).catch((err) => {
      console.error("[now/context] listSavedItems failed", err);
      return [];
    }),
  ]);

  const today = isoDate(at);

  const [candidatePlaces, candidateEvents, candidateExperiences, forecast] = await Promise.all([
    loadCandidatePlaces(db, coords),
    getEventsForDestination(db, { destination: CITY.name, limit: 100 })
      .then((r) => r.events)
      .catch((err) => {
        console.error("[now/context] events lookup failed", err);
        return [];
      }),
    getExperiencesForDestination(db, { destination: CITY.name })
      .then((r) => r.experiences)
      .catch((err) => {
        console.error("[now/context] experiences lookup failed", err);
        return [];
      }),
    getForecastForDestination(CITY.name).catch(() => ({ center: null, days: [], utcOffsetSeconds: null, degraded: "error" })),
  ]);

  const weather = pickForecastDay(forecast.days, today);

  const persona = resolvePersona(prefs);

  return {
    at,
    coords,
    coordsAreLive,
    city: CITY,
    weather,
    prefs,
    persona,
    signals: recentSignals,
    savedItems,
    candidatePlaces,
    candidateEvents,
    candidateExperiences,
  };
}
