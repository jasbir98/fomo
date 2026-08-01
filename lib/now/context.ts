import "server-only";
import { getTrip } from "@/lib/db/trips";
import { listItems } from "@/lib/db/items";
import { getPreferences } from "@/lib/db/preferences";
import { listRecentSignals } from "@/lib/db/signals";
import { listPlacesByCity } from "@/lib/db/places";
import { getEventsForDestination } from "@/lib/events/getForDestination";
import { getExperiencesForDestination } from "@/lib/experiences/getForDestination";
import { getDeviceLocation } from "@/lib/db/location";
import { getForecastForDestination, pickForecastDay } from "@/lib/weather";
import { searchPlaces } from "@/lib/places/google";
import { geocodeDestination } from "@/lib/places/geocode";
import type { ItineraryItem, Trip } from "@/lib/types";
import type { Coordinates } from "@/lib/geo";
import type { Gap, PlanDensity, RankContext, TripPhase } from "@/lib/now/types";

/** No duration recorded — used both for "how long does this block the calendar" and gap math. Deliberately generous: undercounting a gap is worse (a suggestion that doesn't fit) than overcounting (one fewer gap surfaced). */
const DEFAULT_DURATION_MINUTES = 90;
const MIN_GAP_MINUTES = 90;
const DAY_END_HOUR = 22;

function cityGuess(destination: string | null): string | null {
  return destination?.split(",")[0]?.trim() || null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function itemEnd(item: ItineraryItem): Date | null {
  if (!item.starts_at) return null;
  const start = new Date(item.starts_at);
  const minutes = item.duration_minutes ?? DEFAULT_DURATION_MINUTES;
  return new Date(start.getTime() + minutes * 60_000);
}

function computeTripDay(at: Date, trip: Trip): number {
  if (!trip.start_date) return 1;
  const start = new Date(`${trip.start_date}T00:00:00Z`);
  const today = new Date(`${isoDate(at)}T00:00:00Z`);
  const days = Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1;
  return Math.max(1, days);
}

function computeTripPhase(at: Date, trip: Trip, tripDay: number): TripPhase {
  if (tripDay === 1) return "arrival";
  if (trip.end_date && isoDate(at) === trip.end_date) return "last-day";
  return tripDay <= 2 ? "early" : "mid";
}

function computeGaps(at: Date, scheduled: ItineraryItem[]): Gap[] {
  const gaps: Gap[] = [];
  const dayEnd = new Date(at);
  dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);

  if (scheduled.length === 0) {
    const start = at;
    if (start < dayEnd) {
      const minutes = (dayEnd.getTime() - start.getTime()) / 60_000;
      if (minutes >= MIN_GAP_MINUTES) gaps.push({ startsAt: start, endsAt: dayEnd, minutes });
    }
    return gaps;
  }

  const sorted = [...scheduled].sort(
    (a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime()
  );

  // now -> first upcoming anchor
  const firstUpcoming = sorted.find((i) => new Date(i.starts_at!) > at);
  if (firstUpcoming) {
    const minutes = (new Date(firstUpcoming.starts_at!).getTime() - at.getTime()) / 60_000;
    if (minutes >= MIN_GAP_MINUTES) gaps.push({ startsAt: at, endsAt: new Date(firstUpcoming.starts_at!), minutes });
  }

  // between consecutive anchors
  for (let i = 0; i < sorted.length - 1; i++) {
    const end = itemEnd(sorted[i]);
    const nextStart = new Date(sorted[i + 1].starts_at!);
    if (!end || end >= nextStart) continue;
    const minutes = (nextStart.getTime() - end.getTime()) / 60_000;
    if (minutes >= MIN_GAP_MINUTES) gaps.push({ startsAt: end, endsAt: nextStart, minutes });
  }

  // last anchor -> end of day
  const last = sorted[sorted.length - 1];
  const lastEnd = itemEnd(last);
  if (lastEnd && lastEnd < dayEnd) {
    const minutes = (dayEnd.getTime() - lastEnd.getTime()) / 60_000;
    if (minutes >= MIN_GAP_MINUTES) gaps.push({ startsAt: lastEnd, endsAt: dayEnd, minutes });
  }

  return gaps;
}

/**
 * Curated-first, then live-Google, candidate place pool for this request.
 * Mirrors the fallback the old Home dashboard used (lib/db/places.ts
 * listPlacesByCity, then /api/places' live search) — the ranker calls the
 * same underlying helpers directly rather than round-tripping through its
 * own HTTP API.
 */
export async function loadCandidatePlaces(destination: string | null, coords: Coordinates | null) {
  const city = cityGuess(destination);
  if (city) {
    try {
      const curated = await listPlacesByCity(city);
      if (curated.length > 0) return curated;
    } catch (err) {
      console.error("[now/context] curated places lookup failed", err);
    }
  }
  if (!destination || !process.env.GOOGLE_PLACES_API_KEY) return [];
  try {
    const center = coords ?? (await geocodeDestination(destination));
    const mapped = await searchPlaces({ destination, limit: 20, center });
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
  deviceId: string;
  tripId: string;
  at: Date;
  liveCoords: Coordinates | null;
}

/** Assembles everything the ranker's generators need for one request. Never throws — degrades field-by-field, since a Home open must always render something (plan-v1-home-pivot.md §4.5). */
export async function buildRankContext(input: BuildContextInput): Promise<RankContext | null> {
  const { deviceId, tripId, at, liveCoords } = input;

  const trip = await getTrip(deviceId, tripId);
  if (!trip) return null;

  let coords = liveCoords;
  const coordsAreLive = liveCoords != null;
  if (!coords) {
    try {
      const stored = await getDeviceLocation(deviceId);
      if (stored?.lat != null && stored.lng != null) {
        coords = { lat: stored.lat, lng: stored.lng };
      }
    } catch (err) {
      console.error("[now/context] device_location fallback failed", err);
    }
  }

  const [allItems, prefs, recentSignals] = await Promise.all([
    listItems(deviceId, tripId).catch((err) => {
      console.error("[now/context] listItems failed", err);
      return [] as ItineraryItem[];
    }),
    getPreferences(deviceId).catch(() => null),
    listRecentSignals(deviceId).catch(() => []),
  ]);

  const today = isoDate(at);
  const todaysItems = allItems.filter((i) => i.day_date === today);
  const scheduled = todaysItems.filter((i) => i.starts_at != null);

  const currentItem =
    scheduled.find((i) => {
      const start = new Date(i.starts_at!);
      const end = itemEnd(i);
      return start <= at && (!end || at < end);
    }) ?? null;

  const nextAnchor =
    scheduled
      .filter((i) => new Date(i.starts_at!) > at)
      .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0] ??
    null;

  const gaps = computeGaps(at, scheduled);

  const planDensity: PlanDensity =
    todaysItems.length === 0 ? "none" : todaysItems.length <= 2 ? "light" : "full";

  const tripDay = computeTripDay(at, trip);
  const tripPhase = computeTripPhase(at, trip, tripDay);

  const [candidatePlaces, candidateEvents, candidateExperiences, forecast] = await Promise.all([
    loadCandidatePlaces(trip.destination, coords),
    trip.destination
      ? getEventsForDestination({ destination: trip.destination, limit: 20 })
          .then((r) => r.events)
          .catch((err) => {
            console.error("[now/context] events lookup failed", err);
            return [];
          })
      : Promise.resolve([]),
    trip.destination
      ? getExperiencesForDestination({ destination: trip.destination })
          .then((r) => r.experiences)
          .catch((err) => {
            console.error("[now/context] experiences lookup failed", err);
            return [];
          })
      : Promise.resolve([]),
    trip.destination
      ? getForecastForDestination(trip.destination).catch(() => ({ center: null, days: [], utcOffsetSeconds: null, degraded: "error" }))
      : Promise.resolve({ center: null, days: [], utcOffsetSeconds: null, degraded: "no-destination" }),
  ]);

  const weather = pickForecastDay(forecast.days, today);

  return {
    deviceId,
    trip,
    at,
    coords,
    coordsAreLive,
    todaysItems,
    planDensity,
    currentItem,
    nextAnchor,
    gaps,
    tripDay,
    tripPhase,
    weather,
    candidatePlaces,
    candidateEvents,
    candidateExperiences,
    prefs,
    recentSignals,
  };
}
