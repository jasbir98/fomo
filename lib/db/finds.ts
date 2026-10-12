import type { Db } from "@/lib/supabase/types";
import type { FindRow } from "@/lib/finds/types";

/**
 * True for a PostgREST/Postgres error meaning "the `finds` table doesn't
 * exist" — `42P01` is Postgres's own undefined_table, `PGRST205` is
 * PostgREST's "could not find the table ... in the schema cache" for the same
 * situation. Same shape as lib/db/happenings.ts's isMissingTableError.
 *
 * Fomo Finds ships before its SQL (supabase/add_finds.sql) has been run by
 * hand in every environment, exactly like the event-lifecycle columns did
 * (lib/db/events.ts's withEventFallbacks): the app must work in that window —
 * /finds renders its empty state and the badge store gets no ids — rather than
 * 500. Anything else (a real outage, a permissions error) still throws.
 */
export function isMissingFindsTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return typeof e.message === "string" && /relation .*finds.* does not exist|could not find the table .*finds/i.test(e.message);
}

/** The "run the SQL" hint is logged once per server instance, not on every request. */
let warnedMissingTable = false;

/**
 * Live Finds only (`status = 'live'`), unordered — lib/finds/build.ts sorts
 * and drops ended subjects. RLS already limits anon/authenticated to live
 * rows (the `read_live` policy), so the filter here is explicit rather than
 * load-bearing: a service-role caller gets the same answer.
 *
 * A missing table degrades to `[]` (see isMissingFindsTable) so the feed, the
 * /finds page and the API all keep working before supabase/add_finds.sql runs.
 */
export async function listLiveFinds(db: Db): Promise<FindRow[]> {
  const { data, error } = await db.from("finds").select("*").eq("status", "live");
  if (error) {
    if (isMissingFindsTable(error)) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.warn("[finds] finds table missing — run supabase/add_finds.sql; serving no Finds");
      }
      return [];
    }
    throw error;
  }
  return (data ?? []) as FindRow[];
}
