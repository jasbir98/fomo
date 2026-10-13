/**
 * Live Finds ("Fomo Finds" on Instagram, "For you" in the app), resolved and
 * ready to render — shared by the page (a server component revalidated on a
 * timer) and GET /api/finds, so both return the same list.
 *
 * Reads with the SERVICE-ROLE client (lib/supabase/admin.ts), not the anon one:
 * the full list is account-only, so `finds` is readable by `authenticated` only
 * (supabase/add_finds.sql) and the anon key that ships in the browser can't
 * read it. That makes this module the one place the list leaves the database,
 * so it is `server-only` and it is the callers' job to gate on the session:
 * the page asks for the teaser (`limit: TEASER_COUNT`) and the API route asks
 * for everything only after checking the visitor is signed in. Never import
 * this from client code.
 */
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listLiveFinds } from "@/lib/db/finds";
import { loadSubjects } from "@/lib/cards/resolve";
import { buildFindItems } from "@/lib/finds/build";
import type { FindItem } from "@/lib/finds/types";

export interface LoadedFinds {
  /** The best `limit` live Finds (all of them without a limit), in build order. */
  items: FindItem[];
  /** How many live Finds there are in total, ended ones already dropped; >= items.length. */
  total: number;
}

/**
 * Never throws: any failure returns `{ items: [], total: 0 }` and the page shows
 * its empty state. That also covers the window before supabase/add_finds.sql
 * has been run (listLiveFinds already maps a missing table to []).
 *
 * `limit` trims the result to the first N after sorting (Fomo level, then
 * soonest) — the teaser a signed-out visitor sees — while `total` still counts
 * them all.
 */
export async function loadLiveFindsWithTotal(options: { limit?: number } = {}): Promise<LoadedFinds> {
  try {
    const db = supabaseAdmin();
    const rows = await listLiveFinds(db);
    if (rows.length === 0) return { items: [], total: 0 };
    const { eventById, happeningById } = await loadSubjects(db, rows);
    const all = buildFindItems(rows, eventById, happeningById, new Date());
    const items = options.limit === undefined ? all : all.slice(0, Math.max(0, options.limit));
    return { items, total: all.length };
  } catch (err) {
    console.error("[finds] load failed; serving no Finds", err);
    return { items: [], total: 0 };
  }
}

/** Same as `loadLiveFindsWithTotal`, for callers that only want the items. */
export async function loadLiveFinds(options: { limit?: number } = {}): Promise<FindItem[]> {
  return (await loadLiveFindsWithTotal(options)).items;
}
