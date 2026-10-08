import type { Db } from "@/lib/supabase/types";
import type { EventItem } from "@/lib/types";
import { eventIsLive, DEFAULT_EVENT_DURATION_MS } from "@/lib/events/format";
import { cleanEventDescription } from "@/lib/events/description";

/**
 * Single mapping point for every function below that returns EventItem rows:
 * nulls a source-placeholder description ("summary of the event", "TBC",
 * ...) so no surface ever renders it — see lib/events/description.ts.
 */
function withCleanDescription(row: EventItem): EventItem {
  const cleaned = cleanEventDescription(row.description, row.name);
  return cleaned === row.description ? row : { ...row, description: cleaned };
}

/**
 * The query-layer half of "is this event still running as of `at`" — kept
 * consistent with `eventEffectiveEndMs`'s own definition (an `ends_at` when
 * the row has one, else `starts_at` + `DEFAULT_EVENT_DURATION_MS`) by
 * importing that same constant rather than re-deriving it: either `ends_at`
 * hasn't passed yet, or there's no `ends_at` at all and `starts_at` is
 * recent enough that the default duration hasn't elapsed.
 *
 * Replaces the old fixed 24h "lookback" window (`.gte("starts_at", from -
 * 24h)`), which silently dropped any event whose `starts_at` was more than a
 * day in the past even when it was still genuinely running — a multi-day
 * festival or exhibition never reached the JS `eventIsLive` filter below at
 * all, because the DB-level filter excluded the row first. This filter is a
 * superset of nothing: every row it returns is already live, so `limit`
 * needs no extra padding for rows that will just be filtered back out.
 */
function stillRunningFilter(at: Date): string {
  const nowIso = at.toISOString();
  const defaultDurationCutoff = new Date(at.getTime() - DEFAULT_EVENT_DURATION_MS).toISOString();
  return `ends_at.gte.${nowIso},and(ends_at.is.null,starts_at.gte.${defaultDurationCutoff})`;
}

/** True when a PostgREST error says `events.status` doesn't exist yet (42703 undefined_column, or PostgREST's schema-cache miss). */
export function isUnknownStatusColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const msg = error.message ?? "";
  return (error.code === "42703" || error.code === "PGRST204" || /column .*status.* does not exist/i.test(msg)) && /status/i.test(msg);
}

export interface ListUpcomingEventsOpts {
  destination?: string;
  category?: string;
  from?: string; // ISO timestamp, defaults to now
  to?: string;
  limit?: number;
}

/**
 * List cached upcoming events, optionally filtered by destination/category/
 * date window. Destination match takes the first comma-segment of the
 * destination string before stripping remaining punctuation — the stored
 * `destination` column values keep their commas (e.g. "Edinburgh, Edinburgh, Scotland, United Kingdom"),
 * so a substring match against the full string with commas merely removed
 * never matches the literal comma-separated value. PostgREST's `or=()`
 * filter grammar also breaks on raw commas/parens in interpolated input.
 */
export async function listUpcomingEvents(
  db: Db,
  opts: ListUpcomingEventsOpts = {}
): Promise<EventItem[]> {
  const { destination, category, from, to, limit } = opts;

  const fromDate = from ? new Date(from) : new Date();

  const build = (activeOnly: boolean) => {
    let query = db
      .from("events")
      .select("*")
      .or(stillRunningFilter(fromDate))
      .order("starts_at", { ascending: true });

    // Retired rows (expired / gone / cancelled) stay in the table so saved
    // items and shared links keep working, but never appear in a list.
    if (activeOnly) query = query.eq("status", "active");
    if (to) query = query.lte("starts_at", to);
    if (category) query = query.eq("category", category);

    if (destination) {
      const term = destination.split(",")[0]?.trim().replace(/[,()]/g, "") ?? "";
      if (term) {
        query = query.or(
          `destination.ilike.%${term}%,city.ilike.%${term}%,address.ilike.%${term}%`
        );
      }
    }

    if (limit) query = query.limit(limit);
    return query;
  };

  let { data, error } = await build(true);
  if (error && isUnknownStatusColumn(error)) {
    // Deployed before supabase/add_event_lifecycle.sql was run: retry once
    // without the status filter rather than blanking the feed.
    console.warn("[events] events.status column missing — run supabase/add_event_lifecycle.sql; listing without the status filter");
    ({ data, error } = await build(false));
  }
  if (error) throw error;
  // Final in-memory guard, belt-and-braces: re-checks each row against its
  // own actual effective end (`eventEffectiveEndMs`), not just the SQL
  // approximation above — catches a clock-skew edge case or any future
  // query change that loosens the DB-level filter. Every list route reading
  // this function (feed/now/explore/discover/chat) inherits this guard for
  // free rather than re-implementing it per caller.
  const live = (data ?? []).filter((row) => eventIsLive(row, fromDate)).map(withCleanDescription);
  return limit ? live.slice(0, limit) : live;
}

/** Fetch a single event by id, whatever its status (expired/gone/cancelled rows still resolve). Returns null if not found. */
export async function getEvent(db: Db, id: string): Promise<EventItem | null> {
  const { data, error } = await db.from("events").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? withCleanDescription(data) : null;
}

/**
 * Batch-fetch events by id (any status), for resolving a saved-item id back into a full
 * row (GET /api/saved) — mirrors listPlacesByIds (lib/db/places.ts).
 */
export async function listEventsByIds(db: Db, ids: string[]): Promise<EventItem[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db.from("events").select("*").in("id", ids);
  if (error) throw error;
  return (data ?? []).map(withCleanDescription);
}
