/**
 * Roameo "Draft my day" (server-only). POST /api/now/draft-day
 * Body: { deviceId, tripId, day: "YYYY-MM-DD", lat?, lng? }
 *
 * Plan's empty-day fallback (plan-v1.1-overhaul.md W4 #4) — generates ~3
 * suggested itinerary items for a day with nothing planned yet. Returns
 * suggestions only; nothing is written until the traveller accepts one
 * (the client reuses the existing createItem mutation for that, same as
 * every other "Add to today" action in the app — see components/roameo/Card.tsx).
 * POST rather than GET since the brief frames this as an action ("tap to let
 * Roameo build you one"), even though it's read-only server-side — mirrors
 * this repo's other action-triggered generation, and keeps the door open for
 * server-side rate limiting or logging later without a route shape change.
 */
import "server-only";
import { NextResponse } from "next/server";
import { buildDraftDay } from "@/lib/now/draftDay";
import type { DraftDayResponse } from "@/lib/now/draftDay";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { deviceId?: string; tripId?: string; day?: string; lat?: number; lng?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const deviceId = body.deviceId?.trim();
  const tripId = body.tripId?.trim();
  const day = body.day?.trim();
  if (!deviceId || !tripId || !day) {
    return NextResponse.json(
      { error: "missing required 'deviceId', 'tripId', or 'day' in body" },
      { status: 400 }
    );
  }

  const coords =
    typeof body.lat === "number" && typeof body.lng === "number" && Number.isFinite(body.lat) && Number.isFinite(body.lng)
      ? { lat: body.lat, lng: body.lng }
      : null;

  try {
    const result = await buildDraftDay({ deviceId, tripId, day, coords });
    return NextResponse.json<DraftDayResponse>(result);
  } catch (err) {
    console.error("[api/now/draft-day] failed", err);
    return NextResponse.json<DraftDayResponse>({ suggestions: [], degraded: "no-trip" });
  }
}
