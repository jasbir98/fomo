/**
 * Roameo Events — "What's On Nearby" (server-only).
 *
 * GET /api/events?destination=<string>&category=<slug>&q=<text>&from=&to=&radius=&limit=
 *   category: music | nightlife | festival | arts | comedy | sports | food | family | other
 *   q:        free-text search, passed through to provider `keyword` params
 *   from/to:  ISO date/time window (defaults: now .. no upper bound)
 *   radius:   km, default 25
 *   limit:    default 20, max 100
 *
 * Pipeline: Mapbox-geocode the destination → live-fetch-and-cache via
 * getEventsForDestination() (lib/events/getForDestination.ts — cache-first
 * read with 6h TTL, Skiddle + Ticketmaster fan-out, dedupe, upsert). Always
 * responds 200 with a usable body; degrades to cached/synthetic rows when
 * keys are missing, providers error, or the cache migration hasn't been run
 * yet. Provider keys never leave the server.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { EventItem } from "@/lib/types";
import { geocodeDestination, type Center } from "@/lib/places/geocode";
import { normalizeCategory } from "@/lib/events/categories";
import { getEventsForDestination } from "@/lib/events/getForDestination";

export const runtime = "nodejs";

interface EventsResponse {
  center: Center | null;
  events: EventItem[];
  degraded?: string;
}

const DEFAULT_RADIUS_KM = 25;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const destination = searchParams.get("destination")?.trim();
  if (!destination) {
    return NextResponse.json(
      { error: "missing required 'destination' query param" },
      { status: 400 }
    );
  }

  const category = normalizeCategory(searchParams.get("category"));
  const q = searchParams.get("q")?.trim() || undefined;
  const from = searchParams.get("from")?.trim() || undefined;
  const to = searchParams.get("to")?.trim() || undefined;

  // Same NaN/null-vs-0 guard as /api/places (searchParams.get returns null
  // when absent, and Number(null) is 0, which Number.isFinite treats as a
  // real value — without the explicit null check "no limit given" would
  // silently clamp to 1 instead of falling through to the default).
  const rawLimitParam = searchParams.get("limit");
  const rawLimit = rawLimitParam == null ? NaN : Number(rawLimitParam);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
    : 20;

  const rawRadiusParam = searchParams.get("radius");
  const rawRadius = rawRadiusParam == null ? NaN : Number(rawRadiusParam);
  const radiusKm = Number.isFinite(rawRadius) && rawRadius > 0 ? rawRadius : DEFAULT_RADIUS_KM;

  // Geocode → map center (null-safe; providers require it for geo search).
  const center = await geocodeDestination(destination);

  const { events, degraded } = await getEventsForDestination({
    destination,
    center,
    category,
    q,
    from,
    to,
    limit,
    radiusKm,
  });

  return NextResponse.json<EventsResponse>({ center, events, degraded });
}
