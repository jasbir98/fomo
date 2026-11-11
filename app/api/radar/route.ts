/**
 * GET /api/radar -> { picks: [{ id, name, why }] }
 *
 * The approved "Under the radar" places, for the Explore Collections rail,
 * which only shows its "Under the radar" card when there is at least one.
 * Public catalogue data (read-only, anon); /api/radar is in proxy.ts's
 * PUBLIC_API_PREFIXES. Never fails the caller: any error, including the
 * `radar_*` columns not existing yet (supabase/add_place_radar.sql), is an
 * empty list.
 */
import "server-only";
import { listRadarPicks } from "@/lib/db/radar";
import { cachedJson, CACHE_MEDIUM } from "@/lib/http/cache";
import { supabaseAnon } from "@/lib/supabase/anon";

export const runtime = "nodejs";

export interface RadarApiResponse {
  picks: { id: string; name: string | null; why: string }[];
}

export async function GET() {
  try {
    const picks = await listRadarPicks(supabaseAnon());
    return cachedJson<RadarApiResponse>(
      { picks: picks.map((p) => ({ id: p.id, name: p.name, why: p.radar_why })) },
      CACHE_MEDIUM
    );
  } catch (err) {
    console.error("[api/radar] failed", err);
    return cachedJson<RadarApiResponse>({ picks: [] }, CACHE_MEDIUM);
  }
}
