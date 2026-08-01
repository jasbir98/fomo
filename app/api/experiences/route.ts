/**
 * Roameo Experiences — bookable tours/activities API (server-only).
 *
 * GET /api/experiences?destination=<string>&q=<text>&category=<slug>&limit=<n>&offset=<n>
 *   q:        free-text search, passed through to both provider adapters
 *   category: passed through to both provider adapters
 *   limit:    default 24, max 60
 *   offset:   default 0 — how many results to skip, for infinite-scroll
 *             pagination (page 2 of a browse is offset=24, etc.)
 *
 * Pipeline: Mapbox-geocode the destination → live-fetch-and-cache via
 * getExperiencesForDestination() (lib/experiences/getForDestination.ts —
 * Viator + GetYourGuide product search in parallel via Promise.allSettled,
 * merge, upsert into `experiences`). Always responds 200 with a usable body.
 * Unlike /api/places there's no seed data for this new feature, so the only
 * degrade path when both providers come up empty is falling back to
 * whatever's already cached in `experiences` for this destination.
 */
import "server-only";
import { NextResponse } from "next/server";
import type { Experience } from "@/lib/types";
import { geocodeDestination, type Center } from "@/lib/places/geocode";
import { getExperiencesForDestination } from "@/lib/experiences/getForDestination";

export const runtime = "nodejs";

interface ExperiencesResponse {
  center: Center | null;
  experiences: Experience[];
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

  const category = searchParams.get("category")?.trim() || undefined;
  const q = searchParams.get("q")?.trim() || undefined;
  // searchParams.get("limit") is null when the param is absent, and
  // Number(null) is 0 (not NaN) — Number.isFinite(0) is true, so without this
  // explicit null check the "no limit given" case was silently clamped to
  // Math.max(0, 1) = 1 instead of falling through to the intended default of
  // 24. The browse page (app/(shell)/experiences/page.tsx) now always sends
  // `limit` explicitly via lib/useInfiniteList.ts, but this guard still
  // protects any other caller that omits it.
  const rawLimitParam = searchParams.get("limit");
  const rawLimit = rawLimitParam == null ? NaN : Number(rawLimitParam);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), 60)
    : 24;
  const rawOffsetParam = searchParams.get("offset");
  const rawOffset = rawOffsetParam == null ? NaN : Number(rawOffsetParam);
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

  // Geocode → map center (null-safe; provider search still works without it).
  const center = await geocodeDestination(destination);

  const { experiences, degraded } = await getExperiencesForDestination({
    destination,
    center,
    q,
    category,
    limit,
    offset,
  });

  return NextResponse.json<ExperiencesResponse>({ center, experiences, degraded });
}
