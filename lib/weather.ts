/**
 * Roameo Weather — real forecast data via Open-Meteo (server-only).
 *
 * No API key required. Geocodes a destination string with the existing
 * Mapbox helper (`lib/places/geocode.ts`) and fetches Open-Meteo's daily
 * forecast for that coordinate. Shared by `app/api/weather/route.ts` and
 * `lib/disruption.ts` — both import this module directly rather than one
 * self-fetching the other's route (avoids a same-origin round trip during
 * server rendering / route handling in this Next.js setup).
 */
import "server-only";
import { geocodeDestination, type Center } from "@/lib/places/geocode";

const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";

/** The 4 display states the UI themes (background/icon) around. */
export type WeatherCondition = "sunny" | "cloudy" | "rainy" | "windy";

export interface DayForecast {
  /** ISO date, e.g. "2026-07-23". */
  date: string;
  /** Raw Open-Meteo WMO weather code for this day. */
  weatherCode: number;
  condition: WeatherCondition;
  tempMaxC: number | null;
  tempMinC: number | null;
  windSpeedMaxKmh: number | null;
  precipitationProbabilityMax: number | null;
  /** True for rain/storm-family codes — the signal the Smart Disruption flow acts on. */
  isDisruptive: boolean;
}

export interface ForecastResult {
  center: Center | null;
  /** Ascending by date, starting today (local to the destination). Empty on failure. */
  days: DayForecast[];
  /** Set (and `days` empty) when geocoding or the Open-Meteo call failed — callers must degrade gracefully, never throw to the client. */
  degraded?: string;
}

// WMO weather codes → Roameo's 4 themed conditions. Open-Meteo exposes ~28
// distinct codes but the UI only has 4 backgrounds, so this buckets them by
// which state would most usefully warn a walking-tour traveler:
//   0-1   clear / mainly clear                -> sunny
//   2-3   partly cloudy / overcast            -> cloudy
//   45,48 fog / rime fog                      -> cloudy (low visibility, not wet)
//   51-57 drizzle (incl. freezing)            -> rainy
//   61-67 rain (incl. freezing)               -> rainy
//   71-77 snow                                -> rainy (closest "disrupts an outdoor plan"
//                                                 bucket; Japan v1 has no dedicated snow
//                                                 treatment, and snow is rare in the
//                                                 launch cities/seasons)
//   80-82 rain showers                        -> rainy
//   85-86 snow showers                        -> rainy
//   95-99 thunderstorm (incl. hail)            -> rainy (most disruptive family)
// Severe wind (>= 40 km/h sustained daily max) overrides to "windy" for
// display even on an otherwise clear/cloudy day, since strong wind disrupts
// its own set of outdoor plans (viewpoints, boat rides, cherry blossoms)
// that the weather code alone doesn't flag.
const RAIN_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86,
  95, 96, 99,
]);
const CLOUDY_CODES = new Set([2, 3, 45, 48]);
const SEVERE_WIND_KMH = 40;

// Codes that should surface a Smart Disruption alert (rain/storm family).
// Deliberately excludes snow (71-77, 85-86) — no snow-specific copy in v1
// and snow is not disruption-worthy for the Japan launch cities/seasons.
const DISRUPTIVE_CODES = new Set([
  51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99,
]);

function classifyCondition(
  weatherCode: number,
  windSpeedMaxKmh: number | null
): WeatherCondition {
  if (windSpeedMaxKmh != null && windSpeedMaxKmh >= SEVERE_WIND_KMH) return "windy";
  if (RAIN_CODES.has(weatherCode)) return "rainy";
  if (CLOUDY_CODES.has(weatherCode)) return "cloudy";
  return "sunny"; // codes 0/1 and anything unmapped default to the calmest state
}

interface OpenMeteoResponse {
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    wind_speed_10m_max?: number[];
    precipitation_probability_max?: number[];
  };
}

/**
 * Geocode `destination` and fetch its Open-Meteo daily forecast (10 days).
 * Always resolves — never throws. Returns `degraded` with an empty `days`
 * array when geocoding fails or Open-Meteo errors, so callers can show a
 * "forecast unavailable" state instead of crashing.
 */
export async function getForecastForDestination(
  destination: string
): Promise<ForecastResult> {
  const center = await geocodeDestination(destination);
  if (!center) {
    return { center: null, days: [], degraded: "geocode-failed" };
  }

  const url =
    `${OPEN_METEO_URL}?latitude=${center.lat}&longitude=${center.lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,precipitation_probability_max` +
    `&timezone=auto&forecast_days=10`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error("[weather] open-meteo network error", err);
    return { center, days: [], degraded: "forecast-error" };
  }

  if (!res.ok) {
    console.error(`[weather] open-meteo failed: ${res.status} ${res.statusText}`);
    return { center, days: [], degraded: "forecast-error" };
  }

  let data: OpenMeteoResponse;
  try {
    data = (await res.json()) as OpenMeteoResponse;
  } catch (err) {
    console.error("[weather] open-meteo response parse failed", err);
    return { center, days: [], degraded: "forecast-error" };
  }

  const daily = data.daily;
  if (!daily?.time || daily.time.length === 0) {
    return { center, days: [], degraded: "forecast-error" };
  }

  const days: DayForecast[] = daily.time.map((date, i) => {
    const code = daily.weather_code?.[i] ?? 0;
    const wind = daily.wind_speed_10m_max?.[i] ?? null;
    return {
      date,
      weatherCode: code,
      condition: classifyCondition(code, wind),
      tempMaxC: daily.temperature_2m_max?.[i] ?? null,
      tempMinC: daily.temperature_2m_min?.[i] ?? null,
      windSpeedMaxKmh: wind,
      precipitationProbabilityMax: daily.precipitation_probability_max?.[i] ?? null,
      isDisruptive: DISRUPTIVE_CODES.has(code),
    };
  });

  return { center, days };
}

/**
 * Pick the forecast day matching `date` (YYYY-MM-DD). Falls back to the
 * first available day (today) if `date` is missing or outside the returned
 * window (e.g. an itinerary item far in the future beyond Open-Meteo's
 * 10-day range) — a same-city forecast for "around now" beats no forecast at
 * all. Returns null only when the forecast fetch itself came back empty.
 */
export function pickForecastDay(
  days: DayForecast[],
  date?: string | null
): DayForecast | null {
  if (days.length === 0) return null;
  if (date) {
    const exact = days.find((d) => d.date === date);
    if (exact) return exact;
  }
  return days[0];
}
