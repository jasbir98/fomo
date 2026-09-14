/**
 * Fomo Weather — real forecast data for a trip destination (server-only).
 *
 * GET /api/weather?destination=<string>&date=<YYYY-MM-DD>
 *   destination: required, e.g. "Tokyo, Japan" (same string trips/items use).
 *   date:        optional; picks that day's forecast, else defaults to today.
 *
 * Pipeline: Mapbox-geocode the destination (`lib/places/geocode.ts`) → fetch
 * Open-Meteo's daily forecast (`lib/weather.ts`, no key needed) → return the
 * requested day plus the full 10-day window. Always responds 200 with a
 * usable body; degrades with a `degraded` reason string on failure (matches
 * the pattern in `app/api/places/route.ts`) rather than letting an
 * unhandled exception reach the client.
 */
import "server-only";
import { NextResponse } from "next/server";
import {
  getForecastForDestination,
  pickForecastDay,
  type DayForecast,
} from "@/lib/weather";
import type { Center } from "@/lib/places/geocode";
import { cachedJson, CACHE_LONG, CACHE_SHORT } from "@/lib/http/cache";

export const runtime = "nodejs";

interface WeatherResponse {
  center: Center | null;
  /** The resolved day's forecast (requested `date`, else today). Null if the forecast is unavailable. */
  day: DayForecast | null;
  /** Full forecast window, ascending by date, for callers that want more than one day. */
  days: DayForecast[];
  degraded?: string;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const destination = searchParams.get("destination")?.trim();
  if (!destination) {
    return NextResponse.json(
      { error: "missing required 'destination' query param" },
      { status: 400 }
    );
  }
  const date = searchParams.get("date")?.trim() || undefined;

  try {
    const forecast = await getForecastForDestination(destination);
    const day = pickForecastDay(forecast.days, date);
    // Not user-specific (destination is the only input), but browser-cache
    // only (`private`) — every /api/* route goes through proxy.ts, which
    // can attach a session-refresh Set-Cookie, so this must never be
    // `public`/`s-maxage` (see lib/http/cache.ts). Weather changes slowly,
    // so a generous TTL + long SWR still pays off for repeat visits.
    return cachedJson<WeatherResponse>(
      {
        center: forecast.center,
        day,
        days: forecast.days,
        degraded: forecast.degraded,
      },
      CACHE_LONG
    );
  } catch (err) {
    // Defense in depth — getForecastForDestination already catches its own
    // errors, but a route handler should never let anything unhandled
    // reach the client. Shorter TTL than the happy path so the browser
    // doesn't keep serving a transient failure for long.
    console.error("[api/weather] unexpected failure", err);
    return cachedJson<WeatherResponse>(
      {
        center: null,
        day: null,
        days: [],
        degraded: "forecast-error",
      },
      CACHE_SHORT
    );
  }
}
