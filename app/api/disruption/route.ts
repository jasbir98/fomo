/**
 * Roameo Smart Disruption — real forecast + real alternatives (server-only).
 *
 * GET /api/disruption?destination=<string>&date=<YYYY-MM-DD>&itemTitle=<string>
 *   destination: required — the trip's destination string.
 *   date:        optional — the itinerary item's day; defaults to today's
 *                forecast if omitted or outside Open-Meteo's 10-day window.
 *   itemTitle:   optional — personalizes the alert's subtext.
 *
 * Combines `lib/weather.ts` (real Open-Meteo forecast) and
 * `lib/disruption.ts` (real per-city covered alternatives) into the single
 * payload the disruption screen renders. Always responds 200; `alert` is
 * null only when the forecast itself is unavailable, and `degraded` carries
 * a reason string for either half's failure — never an unhandled exception.
 */
import "server-only";
import { NextResponse } from "next/server";
import { getForecastForDestination, pickForecastDay } from "@/lib/weather";
import { buildDisruptionAlert, getAlternatives, type Alternative, type DisruptionAlert } from "@/lib/disruption";

export const runtime = "nodejs";

interface DisruptionResponse {
  alert: DisruptionAlert | null;
  alternatives: Alternative[];
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
  const itemTitle = searchParams.get("itemTitle")?.trim() || undefined;

  try {
    const [forecast, altResult] = await Promise.all([
      getForecastForDestination(destination),
      getAlternatives(destination),
    ]);

    const day = pickForecastDay(forecast.days, date);
    const alert = day ? buildDisruptionAlert(day, itemTitle) : null;

    return NextResponse.json<DisruptionResponse>({
      alert,
      alternatives: altResult.alternatives,
      degraded: forecast.degraded ?? altResult.degraded,
    });
  } catch (err) {
    console.error("[api/disruption] unexpected failure", err);
    return NextResponse.json<DisruptionResponse>({
      alert: null,
      alternatives: [],
      degraded: "forecast-error",
    });
  }
}
