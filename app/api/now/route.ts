/**
 * Roameo "right now" ranker (server-only).
 *
 * GET /api/now?deviceId=<uuid>&tripId=<uuid, optional>&lat=&lng=&at=<ISO, optional>
 *   tripId: defaults to the device's current trip when omitted.
 *   lat/lng: live device coordinates for this request, if location is
 *            granted. Falls back to the coarse `device_location` cache, then
 *            to no location at all — the ranker degrades gracefully at every
 *            step (plan-v1-home-pivot.md §4.5, §12).
 *   at:      ISO timestamp override, for testing/scrubbing (the artifact
 *            preview's time scrubber maps directly to this param). Defaults
 *            to the request's server time.
 *
 * See lib/now/ for the ranking engine itself — this route is purely
 * request parsing + response shaping.
 */
import "server-only";
import { NextResponse } from "next/server";
import { getCurrentTrip } from "@/lib/db/trips";
import { buildRankContext } from "@/lib/now/context";
import { buildNowResponse } from "@/lib/now/rank";
import type { NowResponse } from "@/lib/now/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId")?.trim();
  if (!deviceId) {
    return NextResponse.json({ error: "missing required 'deviceId' query param" }, { status: 400 });
  }

  let tripId = searchParams.get("tripId")?.trim() || undefined;
  if (!tripId) {
    const current = await getCurrentTrip(deviceId).catch(() => null);
    if (!current) {
      return NextResponse.json<NowResponse>({
        mode: "drifter",
        hero: null,
        next: null,
        chips: [],
        rail: { title: "", meta: "", items: [] },
        degraded: "no-trip",
      });
    }
    tripId = current.id;
  }

  // searchParams.get(...) is null when the param is absent, and Number(null)
  // is 0 (not NaN) — Number.isFinite(0) is true, so without the explicit
  // null checks this silently defaulted missing coords to {lat:0,lng:0}
  // (the Gulf of Guinea), which zeroed out every distance-scored candidate
  // via proximityDecay. Same trap documented at app/api/places/route.ts:86-96.
  const latParam = searchParams.get("lat");
  const lngParam = searchParams.get("lng");
  const lat = latParam == null ? NaN : Number(latParam);
  const lng = lngParam == null ? NaN : Number(lngParam);
  const liveCoords = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  const atParam = searchParams.get("at");
  const at = atParam && !Number.isNaN(Date.parse(atParam)) ? new Date(atParam) : new Date();

  try {
    const ctx = await buildRankContext({ deviceId, tripId, at, liveCoords });
    if (!ctx) {
      return NextResponse.json<NowResponse>({
        mode: "drifter",
        hero: null,
        next: null,
        chips: [],
        rail: { title: "", meta: "", items: [] },
        degraded: "no-trip",
      });
    }
    const response = await buildNowResponse(ctx);
    return NextResponse.json<NowResponse>(response);
  } catch (err) {
    console.error("[api/now] ranking failed", err);
    return NextResponse.json<NowResponse>({
      mode: "drifter",
      hero: null,
      next: null,
      chips: [],
      rail: { title: "", meta: "", items: [] },
      degraded: "no-coverage",
    });
  }
}
