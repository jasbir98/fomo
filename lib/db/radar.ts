import type { Db } from "@/lib/supabase/types";
import { EXCLUDE_EVENT_VENUES, withThumbnail, PLACE_SELECT } from "@/lib/db/places";
import { orderPicks } from "@/lib/radar/picks";
import { isMissingRadarColumn } from "@/lib/radar/safe";
import type { RadarPick } from "@/lib/radar/types";

/** The "run the SQL" hint is logged once per server instance, not on every request. */
let warnedMissingColumns = false;

/**
 * Approved "Under the radar" places, newest approval first. Public catalogue
 * data (anon may read `places`).
 *
 * Ships before supabase/add_place_radar.sql has run: when the `radar_*`
 * columns do not exist yet this returns `[]` instead of throwing, so every
 * surface renders nothing rather than erroring. Any other failure (an outage,
 * a permissions error) still throws, so callers can decide how to degrade.
 */
export async function listRadarPicks(db: Db): Promise<RadarPick[]> {
  const { data, error } = await db
    .from("places")
    .select(PLACE_SELECT)
    .not("radar_picked_at", "is", null)
    .or(EXCLUDE_EVENT_VENUES);
  if (error) {
    if (isMissingRadarColumn(error)) {
      if (!warnedMissingColumns) {
        warnedMissingColumns = true;
        console.warn("[radar] radar_* columns missing, run supabase/add_place_radar.sql; serving no picks");
      }
      return [];
    }
    throw error;
  }
  return orderPicks((data ?? []).map(withThumbnail));
}
