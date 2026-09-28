import "server-only";
import type { Db } from "@/lib/supabase/types";
import type { CityConfig } from "@/lib/city";
import { CITY } from "@/lib/city";
import type { Happening } from "@/lib/happenings/types";

/**
 * True for a PostgREST/Postgres error that means "the `happenings` table
 * (or `happening_sources`) doesn't exist" — `42P01` is Postgres's own
 * undefined_table code, `PGRST205` is PostgREST's "not found in schema
 * cache" code for the same situation. The pipeline that runs
 * supabase/archive/add_happenings.sql may not have been run yet in every
 * environment, and even after it has, the feed must never 500 the whole
 * Home page over a catalog table that simply has nothing in it yet — see
 * this file's module doc and the feed route's own doc comment.
 */
function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return typeof e.message === "string" && /relation .*happenings.* does not exist/i.test(e.message);
}

/**
 * Live happenings that apply in `city` — venue/city rows scoped to the city
 * itself, PLUS region rows for the city's region and national rows
 * regardless of city, per the `scope` doc comment in
 * supabase/archive/add_happenings.sql (a `city = null` national/region row must not
 * be dropped by a naive `city.eq` filter, or "National Cinema Weekend" and
 * "Doors Open Days" never render on an Edinburgh page).
 *
 * Never throws for a missing table or zero rows — both degrade to `[]`, so
 * the feed route can always fall back to cheap provider events and Free Any
 * Time places rather than erroring the whole page. Every other
 * Postgres error (a real outage, a permissions problem) still throws, same
 * as the rest of lib/db/*.
 */
export async function listLiveHappenings(db: Db, city: CityConfig = CITY): Promise<Happening[]> {
  const { data, error } = await db
    .from("happenings")
    .select("*")
    .eq("status", "live")
    .or(
      `scope.eq.national,and(scope.eq.region,region.eq.${city.region}),and(scope.in.(venue,city),city.eq.${city.name})`
    );

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return ((data ?? []) as Happening[]).filter((h) => !isPastSeason(h, city.timezone));
}

/**
 * True once a season-bound row (festival concessions etc.) is past its
 * `season_valid_until` in the city's own calendar day. Filtered in JS rather
 * than in the query so the read keeps working before
 * supabase/archive/add_season_valid_until.sql has been run (the column is then just
 * absent from `select *`, and every row passes).
 */
function isPastSeason(h: Happening, timeZone: string): boolean {
  if (!h.season_valid_until) return false;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  return h.season_valid_until < today;
}

/**
 * Fetch a single live-or-not happening by id, for the happening detail page
 * (app/(shell)/happening/[id]/page.tsx) — mirrors getPlace/getEvent
 * (lib/db/places.ts, lib/db/events.ts). No `status`/`scope` filter: a card
 * that linked here already knows the row is live and in-scope, and a direct
 * id lookup should resolve regardless (a dormant/retired row still has a
 * page, it just won't have been linked to from the feed). Missing-table
 * degrades to null rather than throwing, same reasoning as
 * `listLiveHappenings`.
 */
export async function getHappeningById(db: Db, id: string): Promise<Happening | null> {
  const { data, error } = await db.from("happenings").select("*").eq("id", id).maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
  return (data as Happening | null) ?? null;
}

/**
 * Every live happening linked to one place via `place_id` — the place
 * detail page's "Offers here" section (task 2 of the Home restructure).
 * `status: "live"` only, mirroring `listLiveHappenings`: a place page should
 * never surface a dormant/retired offer, unlike `getHappeningById`, which is
 * a direct-link lookup that intentionally has no such filter. Missing-table
 * degrades to `[]`, same reasoning as every other read in this file.
 */
export async function listHappeningsForPlace(db: Db, placeId: string): Promise<Happening[]> {
  const { data, error } = await db
    .from("happenings")
    .select("*")
    .eq("place_id", placeId)
    .eq("status", "live");
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return (data ?? []) as Happening[];
}

/**
 * Happenings by id, any status — the Saved list resolves saved rows through
 * this, and an offer that has since gone dormant should still show there
 * (the caller marks it ended) rather than silently vanish.
 */
export async function listHappeningsByIds(db: Db, ids: string[]): Promise<Happening[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from("happenings").select("*").in("id", ids);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
  return (data ?? []) as Happening[];
}
