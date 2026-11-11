/**
 * "Under the radar" ships before supabase/add_place_radar.sql has been run, so
 * a missing column must read as "no picks", never an error. Same idea as
 * lib/db/finds.ts's isMissingFindsTable.
 */

/** True when an error means a `radar_*` column does not exist on `places` yet. */
export function isMissingRadarColumn(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  const message = typeof e.message === "string" ? e.message : "";
  if (!/radar_(why|picked_at|featured_week)/.test(message)) return false;
  // 42703 = Postgres undefined_column; PGRST204 = PostgREST schema-cache miss.
  return e.code === "42703" || e.code === "PGRST204" || /does not exist|could not find/i.test(message);
}
