/**
 * Roameo chip discover surface (server-only). GET /api/discover?intent=&deviceId=&tripId=&lat=&lng=
 * See lib/now/discover.ts — this route is purely request parsing + response shaping.
 */
import "server-only";
import { NextResponse } from "next/server";
import { buildDiscoverResponse } from "@/lib/now/discover";
import type { DiscoverIntentSlug, DiscoverResponse } from "@/lib/now/types";

export const runtime = "nodejs";

const VALID_INTENTS: DiscoverIntentSlug[] = ["tonight", "book", "eat", "gap", "indoors"];

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const deviceId = searchParams.get("deviceId")?.trim();
  const tripId = searchParams.get("tripId")?.trim();
  const intent = searchParams.get("intent")?.trim() as DiscoverIntentSlug | null;
  if (!deviceId || !tripId || !intent || !VALID_INTENTS.includes(intent)) {
    return NextResponse.json(
      { error: "missing/invalid 'deviceId', 'tripId', or 'intent' query param" },
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
    const result = await buildDiscoverResponse({ deviceId, tripId, intent, coords });
    return NextResponse.json<DiscoverResponse>(result);
  } catch (err) {
    console.error("[api/discover] failed", err);
    return NextResponse.json<DiscoverResponse>({ title: "", meta: "", items: [], degraded: "empty" });
  }
}
