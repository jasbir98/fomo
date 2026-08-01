/**
 * Roameo Plan's per-day view (server-only). GET /api/now/day?deviceId=&tripId=&day=YYYY-MM-DD&lat=&lng=
 * See lib/now/dayplan.ts — this route is purely request parsing + response shaping.
 */
import "server-only";
import { NextResponse } from "next/server";
import { buildDayPlan } from "@/lib/now/dayplan";
import type { DayPlanResponse } from "@/lib/now/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId")?.trim();
  const tripId = searchParams.get("tripId")?.trim();
  const day = searchParams.get("day")?.trim();
  if (!deviceId || !tripId || !day) {
    return NextResponse.json(
      { error: "missing required 'deviceId', 'tripId', or 'day' query param" },
      { status: 400 }
    );
  }

  // See app/api/now/route.ts's comment: searchParams.get is null when
  // absent, and Number(null) is 0 (not NaN), so this must null-check the raw
  // string before converting or a missing lat/lng silently becomes {0,0}.
  const latParam = searchParams.get("lat");
  const lngParam = searchParams.get("lng");
  const lat = latParam == null ? NaN : Number(latParam);
  const lng = lngParam == null ? NaN : Number(lngParam);
  const coords = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  try {
    const plan = await buildDayPlan({ deviceId, tripId, day, coords });
    return NextResponse.json<DayPlanResponse>(plan);
  } catch (err) {
    console.error("[api/now/day] failed", err);
    return NextResponse.json<DayPlanResponse>({ disruption: null, gaps: [], degraded: "no-trip" });
  }
}
