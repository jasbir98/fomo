/**
 * Live Finds ("Fomo Finds" on Instagram, "For you" in the app), resolved and
 * ready to render — shared by the page (a server component revalidated on a
 * timer) and
 * GET /api/finds, so both return the same list.
 *
 * Reads with the cookie-less anon client (lib/supabase/anon.ts), the same one
 * lib/happenings/server-feed.ts uses: `finds` (live rows), `events`,
 * `happenings` and `places` are all `read_all` to anon under RLS, and a
 * cookie-less read keeps the page statically cacheable.
 */
import "server-only";
import { supabaseAnon } from "@/lib/supabase/anon";
import { listLiveFinds } from "@/lib/db/finds";
import { loadSubjects } from "@/lib/cards/resolve";
import { buildFindItems } from "@/lib/finds/build";
import type { FindItem } from "@/lib/finds/types";

/**
 * Never throws: any failure returns [] and the page shows its empty state.
 * That also covers the window before supabase/add_finds.sql has been run
 * (listLiveFinds already maps a missing table to []).
 */
export async function loadLiveFinds(): Promise<FindItem[]> {
  try {
    const db = supabaseAnon();
    const rows = await listLiveFinds(db);
    if (rows.length === 0) return [];
    const { eventById, happeningById } = await loadSubjects(db, rows);
    return buildFindItems(rows, eventById, happeningById, new Date());
  } catch (err) {
    console.error("[finds] load failed; serving no Finds", err);
    return [];
  }
}
