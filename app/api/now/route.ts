/**
 * Fomo "right now" ranker (server-only).
 *
 * GET /api/now?lat=&lng=&at=<ISO, optional>
 *   Identity comes from the session cookie (lib/supabase/server.ts), not a
 *   query param — see plan-v1.2-accounts.md §A.5. No session -> immediate
 *   `degraded: "unauthorized"`, never a silent empty response.
 *   lat/lng: live device coordinates for this request, if location is
 *            granted. Falls back to the coarse `user_location` cache, then
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
import { supabaseServer } from "@/lib/supabase/server";
import { buildFeedContext } from "@/lib/now/context";
import { buildNowResponse } from "@/lib/now/rank";
import type { NowResponse } from "@/lib/now/types";
import { isUnauthorizedError } from "@/lib/supabase-error";
import { cachedJson, CACHE_PRIVATE_NO_STORE } from "@/lib/http/cache";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const db = await supabaseServer();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    // Auth-gated + per-user location/context — explicit no-store.
    return cachedJson<NowResponse>(
      {
        mode: "drifter",
        hero: null,
        degraded: "unauthorized",
      },
      CACHE_PRIVATE_NO_STORE
    );
  }

  const { searchParams } = new URL(request.url);

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
    const ctx = await buildFeedContext({ db, at, liveCoords });
    const response = await buildNowResponse(ctx);
    return cachedJson<NowResponse>(response, CACHE_PRIVATE_NO_STORE);
  } catch (err) {
    console.error("[api/now] ranking failed", err);
    return cachedJson<NowResponse>(
      {
        mode: "drifter",
        hero: null,
        degraded: isUnauthorizedError(err) ? "unauthorized" : "no-coverage",
      },
      CACHE_PRIVATE_NO_STORE
    );
  }
}
