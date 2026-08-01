/**
 * Roameo Smart Disruption Fix — real weather + real per-city alternatives
 * (server-only).
 *
 * Replaces the v0 scripted module (always "Iwatayama Monkey Park" /
 * "Kimono Forest" in Arashiyama, regardless of the trip's actual city).
 * `weather_alert` stays on `ItineraryItem` as a manual override/display hint
 * (flips the "Rain expected" pill + link on the Plan list — unchanged,
 * out of scope here) but the *content* shown once the disruption screen is
 * opened is now always driven by a real Open-Meteo forecast for the item's
 * day + trip destination, and real nearby covered places — correct
 * regardless of whether the trip is in Kyoto, Tokyo, Hakone, or anywhere
 * else.
 *
 * Used by `app/api/disruption/route.ts`, which the disruption page
 * (`app/plan/disruption/[id]/page.tsx`) fetches from client-side — this
 * module itself imports `lib/places/google.ts` (server-only) so it can't be
 * imported directly from a "use client" component.
 */
import "server-only";
import { listPlacesByCity } from "@/lib/db/places";
import { geocodeDestination } from "@/lib/places/geocode";
import { searchPlaces, type MappedPlace } from "@/lib/places/google";
import type { Place } from "@/lib/types";
import type { DayForecast, WeatherCondition } from "@/lib/weather";

/** A Roameo-suggested covered/indoor alternative to a weather-affected plan. */
export interface Alternative {
  title: string;
  /** Maps to `itinerary_items.category` if the swap is applied. */
  category: string;
  location: string;
  image_url: string | null;
  /** Roameo's stated reason for suggesting this alternative. */
  why: string;
  duration_label?: string;
  distance_label?: string;
}

export interface DisruptionAlert {
  headline: string;
  subtext: string;
  condition: WeatherCondition;
  tempMaxC: number | null;
  tempMinC: number | null;
  /** True when the forecast is rain/storm-family — the actual trigger for suggesting alternatives. */
  isDisruptive: boolean;
}

const CONDITION_COPY: Record<WeatherCondition, { headline: string; noun: string }> = {
  rainy: { headline: "Rain expected", noun: "rain" },
  windy: { headline: "Strong wind expected", noun: "high wind" },
  cloudy: { headline: "Overcast skies", noun: "cloud cover" },
  sunny: { headline: "Clear skies", noun: "clear weather" },
};

/**
 * Build the alert banner shown on the disruption screen from a real forecast
 * day. `itemTitle` personalizes the subtext when known; the banner still
 * renders sensibly without it.
 */
export function buildDisruptionAlert(
  day: DayForecast,
  itemTitle?: string | null
): DisruptionAlert {
  const copy = CONDITION_COPY[day.condition];
  const subject = itemTitle ? `Your "${itemTitle}" plan` : "Today's outdoor plan";
  const tempSuffix = day.tempMaxC != null ? ` (high ${Math.round(day.tempMaxC)}°C)` : "";
  const subtext = day.isDisruptive
    ? `${subject} is an outdoor, on-foot plan — ${copy.noun} in the forecast, so here are some covered alternatives nearby.`
    : `${subject} looks fine — ${copy.noun} expected, no need to change plans.`;
  return {
    headline: `${copy.headline}${tempSuffix}`,
    subtext,
    condition: day.condition,
    tempMaxC: day.tempMaxC,
    tempMinC: day.tempMinC,
    isDisruptive: day.isDisruptive,
  };
}

// Substrings matched (case-insensitively) against a place's category+name to
// bias toward covered/indoor picks. Curated Japan-pipeline categories are
// free-text human labels (e.g. "Art Museum", "Shinto Shrine", "Sights &
// Landmarks") rather than a fixed enum, so this is a best-effort judgment
// call, not an exhaustive taxonomy — an imperfect indoor guess still beats
// the old hardcoded Kyoto content.
const INDOOR_HINTS = [
  "museum",
  "gallery",
  "aquarium",
  "shrine",
  "temple",
  "shopping",
  "mall",
  "department store",
  "arcade",
  "market",
  "tea house",
  "cafe",
  "indoor",
  "underground",
  "station",
];

function isIndoorish(place: { category: string | null; name: string | null }): boolean {
  const hay = `${place.category ?? ""} ${place.name ?? ""}`.toLowerCase();
  return INDOOR_HINTS.some((hint) => hay.includes(hint));
}

function fromCuratedPlace(place: Place, city: string): Alternative {
  return {
    title: place.name ?? "Nearby covered option",
    category: place.category ?? "activity",
    location: place.address || [place.city, place.prefecture].filter(Boolean).join(", ") || city,
    image_url: place.image_url,
    why: place.description
      ? place.description
      : `A covered/indoor pick in ${city} to wait out the weather.`,
    distance_label: place.distance_label ?? undefined,
  };
}

function fromLivePlace(place: MappedPlace, city: string): Alternative {
  return {
    title: place.name ?? "Nearby covered option",
    category: place.category ?? "activity",
    location: place.address || city,
    image_url: place.image_url,
    why: `A covered/indoor pick near ${city} to wait out the weather.`,
  };
}

/**
 * Real per-city covered/indoor alternatives for a weather disruption.
 *
 * 1. Curated `places` for the trip's city (`listPlacesByCity`), filtered to
 *    an indoor-leaning category where the data supports it; any curated pick
 *    beats none if nothing indoor-flagged matches.
 * 2. Falls back to a live Google Places search scoped to the city with an
 *    indoor-friendly query when no curated match exists.
 *
 * Never throws — returns `[]` with a `degraded` reason on total failure so
 * the disruption screen can show an empty state instead of crashing.
 */
export async function getAlternatives(
  destination: string
): Promise<{ alternatives: Alternative[]; degraded?: string }> {
  const city = destination.split(",")[0]?.trim() || destination;

  try {
    const curated = await listPlacesByCity(city);
    if (curated.length > 0) {
      const indoor = curated.filter(isIndoorish);
      const pool = indoor.length > 0 ? indoor : curated;
      return { alternatives: pool.slice(0, 3).map((p) => fromCuratedPlace(p, city)) };
    }
  } catch (err) {
    console.error("[disruption] curated lookup failed, falling through to live search", err);
  }

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return { alternatives: [], degraded: "no-google-key" };
  }

  try {
    const center = await geocodeDestination(destination);
    const mapped = await searchPlaces({
      destination,
      limit: 3,
      center,
      q: "indoor attraction museum or covered shopping",
    });
    return { alternatives: mapped.map((p) => fromLivePlace(p, city)) };
  } catch (err) {
    console.error("[disruption] live places search failed", err);
    return { alternatives: [], degraded: "places-error" };
  }
}
