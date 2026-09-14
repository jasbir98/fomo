/**
 * Fomo chip discover surface (server-only). GET /api/discover?intent=&lat=&lng=&limit=&offset=
 *   Identity comes from the session cookie, not a query param — see
 *   plan-v1.2-accounts.md §A.5. No session -> immediate `degraded:
 *   "unauthorized"`, never a silent empty response.
 *   limit:  default 40, max 60
 *   offset: default 0 — pagination, see lib/now/discover.ts
 * See lib/now/discover.ts — this route is purely request parsing + response shaping.
 */
import "server-only";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { buildDiscoverResponse } from "@/lib/now/discover";
import type { DiscoverIntentSlug, DiscoverResponse } from "@/lib/now/types";
import { isUnauthorizedError } from "@/lib/supabase-error";

export const runtime = "nodejs";

const VALID_INTENTS: DiscoverIntentSlug[] = ["eat", "nearby", "indoors", "tonight", "book"];

export async function GET(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return NextResponse.json<DiscoverResponse>({ title: "", meta: "", items: [], degraded: "unauthorized" });
  }

  const { searchParams } = new URL(request.url);
  const intent = searchParams.get("intent")?.trim() as DiscoverIntentSlug | null;
  if (!intent || !VALID_INTENTS.includes(intent)) {
    return NextResponse.json({ error: "missing/invalid 'intent' query param" }, { status: 400 });
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

  try {
    const result = await buildDiscoverResponse({ db, intent, coords, limit, offset });
    return NextResponse.json<DiscoverResponse>(result);
  } catch (err) {
    console.error("[api/discover] failed", err);
    return NextResponse.json<DiscoverResponse>({
      title: "",
      meta: "",
      items: [],
      degraded: isUnauthorizedError(err) ? "unauthorized" : "empty",
    });
  }
}
