import type { Db } from "@/lib/supabase/types";
import type { EventItem, EventVenue } from "@/lib/types";
import { eventIsLive, DEFAULT_EVENT_DURATION_MS } from "@/lib/events/format";
import { cleanEventDescription } from "@/lib/events/description";

/**
 * The linked venue (`events.place_id -> places.id`, filled by
 * scripts/sources/core/venues.mjs) is embedded under `place`. Lists only need
 * its photo (a card falls back to it when the event has none); a single read
 * (detail page, saved items) also takes the name / address / website / Maps
 * link. `place_photos` is embedded too because a curated place's only photo
 * can live there (lib/db/places.ts's withThumbnail does the same). No Google
 * photo is ever requested or stored for these (the user wants free photos only).
 */
const LIST_SELECT = "*, place:places(image_url, place_photos(url, display_order))";
const DETAIL_SELECT = "*, place:places(name, image_url, website, google_maps_uri, address, place_photos(url, display_order))";

type RawVenue = EventVenue & { place_photos?: { url: string; display_order: number | null }[] | null };
type RawEvent = Omit<EventItem, "place"> & { place?: RawVenue | RawVenue[] | null };

/** Flattens the embedded venue: image_url falls back to its earliest place_photo, place_photos is dropped. */
export function flattenVenue(raw: RawVenue | RawVenue[] | null | undefined): EventVenue | null {
  const place = Array.isArray(raw) ? raw[0] : raw;
  if (!place) return null;
  const { place_photos, ...rest } = place;
  const photo = place_photos && place_photos.length > 0 ? [...place_photos].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))[0]?.url : null;
  return { ...rest, image_url: rest.image_url ?? photo ?? null };
}

/** True when PostgREST can't embed `place` (no events.place_id -> places FK in this DB, or an ambiguous one). */
export function isUnknownRelationship(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "PGRST200" || error.code === "PGRST201" || /could not find a relationship/i.test(error.message ?? "");
}

type QueryOpts = { activeOnly: boolean; embed: boolean };

/**
 * Runs `run`, and on the two "deployed before the SQL/FK exists" errors retries
 * once each without the thing that failed (the status filter, the venue embed),
 * so neither a missing events.status column nor a missing FK can blank the feed.
 */
async function withEventFallbacks<R extends { error: { code?: string; message?: string } | null }>(
  run: (opts: QueryOpts) => PromiseLike<R>
): Promise<R> {
  let opts: QueryOpts = { activeOnly: true, embed: true };
  let res = await run(opts);
  for (let attempt = 0; attempt < 2 && res.error; attempt += 1) {
    if (opts.activeOnly && isUnknownStatusColumn(res.error)) {
      // Deployed before supabase/add_event_lifecycle.sql was run.
      console.warn("[events] events.status column missing — run supabase/add_event_lifecycle.sql; listing without the status filter");
      opts = { ...opts, activeOnly: false };
    } else if (opts.embed && isUnknownRelationship(res.error)) {
      console.warn("[events] cannot embed events.place (no FK events.place_id -> places.id?); reading events without the venue join");
      opts = { ...opts, embed: false };
    } else {
      break;
    }
    res = await run(opts);
  }
  return res;
}

/**
 * Single mapping point for every function below that returns EventItem rows:
 * nulls a source-placeholder description ("summary of the event", "TBC",
 * ...) so no surface ever renders it — see lib/events/description.ts.
 */
function withCleanDescription(raw: RawEvent): EventItem {
  const { place, ...rest } = raw;
  const row: EventItem = place === undefined ? (rest as EventItem) : { ...(rest as EventItem), place: flattenVenue(place) };
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

/** Rows per request: Supabase's PostgREST max_rows. */
const PAGE_SIZE = 1000;
/** Safety ceiling when no `limit` is given (a 90-day window held ~1,200 rows in Oct 2026). */
const MAX_UPCOMING_ROWS = 6000;

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

  const build = ({ activeOnly, embed }: QueryOpts) => {
    let query = db
      .from("events")
      .select(embed ? LIST_SELECT : "*")
      .or(stillRunningFilter(fromDate))
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true }); // stable order across pages

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

    return query;
  };

  // PostgREST caps a single response at its max_rows (1000 on Supabase), so
  // read in pages until the window is exhausted or `limit` (default
  // MAX_UPCOMING_ROWS) is reached. A plain `.limit(500)` used to cut "Coming
  // up" off around three weeks out once the catalogue grew, because a daily
  // tour spends ~31 rows of that budget on what renders as one card.
  const wanted = limit ?? MAX_UPCOMING_ROWS;
  const data: unknown[] = [];
  let settled: QueryOpts | null = null;
  for (let offset = 0; offset < wanted; offset += PAGE_SIZE) {
    const end = Math.min(offset + PAGE_SIZE, wanted) - 1;
    const res = settled
      ? await build(settled).range(offset, end)
      : await withEventFallbacks((o) => {
          settled = o;
          return build(o).range(offset, end);
        });
    if (res.error) throw res.error;
    const page = res.data ?? [];
    data.push(...page);
    if (page.length < end - offset + 1) break;
  }
  // Final in-memory guard, belt-and-braces: re-checks each row against its
  // own actual effective end (`eventEffectiveEndMs`), not just the SQL
  // approximation above — catches a clock-skew edge case or any future
  // query change that loosens the DB-level filter. Every list route reading
  // this function (feed/now/explore/discover/chat) inherits this guard for
  // free rather than re-implementing it per caller.
  const live = (data as RawEvent[])
    .map(withCleanDescription)
    .filter((row) => eventIsLive(row, fromDate));
  return limit ? live.slice(0, limit) : live;
}

/** Most a place page lists: a venue with a nightly show would otherwise list a month of rows. */
const PLACE_EVENTS_LIMIT = 30;

/**
 * Upcoming and still-running events at one venue (`events.place_id`), soonest
 * first, for the place page's "What's on here". Same liveness rules as
 * `listUpcomingEvents`.
 */
export async function listUpcomingEventsForPlace(db: Db, placeId: string, at: Date = new Date()): Promise<EventItem[]> {
  const { data, error } = await withEventFallbacks(({ activeOnly, embed }) => {
    let query = db
      .from("events")
      .select(embed ? LIST_SELECT : "*")
      .eq("place_id", placeId)
      .or(stillRunningFilter(at))
      .order("starts_at", { ascending: true })
      .limit(PLACE_EVENTS_LIMIT);
    if (activeOnly) query = query.eq("status", "active");
    return query;
  });
  if (error) throw error;
  return ((data ?? []) as unknown as RawEvent[]).map(withCleanDescription).filter((row) => eventIsLive(row, at));
}

/** Fetch a single event by id, whatever its status (expired/gone/cancelled rows still resolve). Returns null if not found. */
export async function getEvent(db: Db, id: string): Promise<EventItem | null> {
  const { data, error } = await withEventFallbacks(({ embed }) =>
    db.from("events").select(embed ? DETAIL_SELECT : "*").eq("id", id).maybeSingle()
  );
  if (error) throw error;
  return data ? withCleanDescription(data as unknown as RawEvent) : null;
}

/**
 * Batch-fetch events by id (any status), for resolving a saved-item id back into a full
 * row (GET /api/saved) — mirrors listPlacesByIds (lib/db/places.ts).
 */
export async function listEventsByIds(db: Db, ids: string[]): Promise<EventItem[]> {
  if (ids.length === 0) return [];
  const { data, error } = await withEventFallbacks(({ embed }) =>
    db.from("events").select(embed ? LIST_SELECT : "*").in("id", ids)
  );
  if (error) throw error;
  return ((data ?? []) as unknown as RawEvent[]).map(withCleanDescription);
}
