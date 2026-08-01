/**
 * Roameo chip discover surface (server-only). GET /api/discover?intent=&deviceId=&tripId=&lat=&lng=&limit=&offset=
 *   limit:  default 40, max 60
 *   offset: default 0 — pagination, see lib/now/discover.ts
 * See lib/now/discover.ts — this route is purely request parsing + response shaping.
 */
import "server-only";
import { NextResponse } from "next/server";
import { buildDiscoverResponse } from "@/lib/now/discover";
import type { DiscoverIntentSlug, DiscoverResponse } from "@/lib/now/types";

export const runtime = "nodejs";

const VALID_INTENTS: DiscoverIntentSlug[] = [
  "tonight",
  "book",
  "eat",
  "gap",
  "indoors",
  "nearby",
  "near-next",
  "closing",
];

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

  // Same null-vs-0 guard as lat/lng above and as /api/places' limit param.
  const rawLimitParam = searchParams.get("limit");
  const rawLimit = rawLimitParam == null ? NaN : Number(rawLimitParam);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 60) : undefined;

  const rawOffsetParam = searchParams.get("offset");
  const rawOffset = rawOffsetParam == null ? NaN : Number(rawOffsetParam);
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : undefined;

  // Plan's "More for this gap →" link (app/(shell)/plan/page.tsx) passes the
  // gap's free-minute count through — see lib/now/discover.ts's `minutes`
  // doc comment for what this does (and doesn't) affect.
  const rawMinutesParam = searchParams.get("minutes");
  const rawMinutes = rawMinutesParam == null ? NaN : Number(rawMinutesParam);
  const minutes = Number.isFinite(rawMinutes) ? Math.max(Math.trunc(rawMinutes), 0) : undefined;

  try {
    const result = await buildDiscoverResponse({ deviceId, tripId, intent, coords, limit, offset, minutes });
    return NextResponse.json<DiscoverResponse>(result);
  } catch (err) {
    console.error("[api/discover] failed", err);
    return NextResponse.json<DiscoverResponse>({ title: "", meta: "", items: [], degraded: "empty" });
  }
}
