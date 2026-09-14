/**
 * Shared live-fetch-and-cache pipeline for events, extracted from
 * app/api/events/route.ts so every caller (the HTTP route, Home's ranker
 * context builder, and the chip-tap discover surface) gets live provider
 * data instead of only ever reading whatever happens to already be cached.
 *
 * Cache-first read from `events` (6h fetched_at TTL) → Skiddle + Ticketmaster
 * fan-out (lib/events/) → dedupe → upsert into `events` (dedupe on
 * provider,provider_event_id) → return the cached rows (with real Supabase
 * ids). Never throws — degrades to cached/synthetic rows when keys are
 * missing, providers error, or the cache migration hasn't been run yet.
 */
import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listUpcomingEvents } from "@/lib/db/events";
import type { EventItem } from "@/lib/types";
import { geocodeDestination, type Center } from "@/lib/places/geocode";
import type { EventCategory } from "@/lib/events/categories";
import { searchEvents, type MappedEvent } from "@/lib/events";
import { dedupeEvents } from "@/lib/events/dedupe";
import type { Db } from "@/lib/supabase/types";

export const EVENTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_RADIUS_KM = 25;
const DEFAULT_LIMIT = 20;

export interface GetEventsForDestinationOpts {
  destination: string;
  /**
   * Pre-resolved map center, if the caller already geocoded the destination
   * (e.g. the HTTP route, which also returns `center` in its response).
   * When omitted, this function geocodes the destination itself so callers
   * that don't otherwise need a center (Home's ranker context, discover)
   * don't have to duplicate that step.
   */
  center?: Center | null;
  category?: EventCategory;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  radiusKm?: number;
}

export interface GetEventsForDestinationResult {
  center: Center | null;
  events: EventItem[];
  degraded?: string;
}

/** Build a full EventItem from a live-mapped result (fallback when the DB cache is unavailable). */
function syntheticEvent(m: MappedEvent): EventItem {
  const now = new Date().toISOString();
  return {
    id: `${m.provider}:${m.provider_event_id}`,
    provider: m.provider,
    provider_event_id: m.provider_event_id,
    name: m.name,
    description: m.description,
    category: m.category,
    image_url: m.image_url,
    ticket_url: m.ticket_url,
    starts_at: m.starts_at,
    ends_at: m.ends_at,
    venue_name: m.venue_name,
    address: m.address,
    lat: m.lat,
    lng: m.lng,
    city: m.city,
    country: m.country,
    is_free: m.is_free,
    price_from: m.price_from,
    currency: m.currency,
    destination: m.destination,
    place_id: null,
    source: "api",
    fetched_at: m.fetched_at,
    created_at: now,
  };
}

export async function getEventsForDestination(
  db: Db,
  opts: GetEventsForDestinationOpts
): Promise<GetEventsForDestinationResult> {
  const { destination, category, q, from, to } = opts;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const radiusKm = opts.radiusKm ?? DEFAULT_RADIUS_KM;

  const center = opts.center !== undefined ? opts.center : await geocodeDestination(destination);

  // 1. Cache-first: serve cached rows and skip providers entirely when the
  // newest cached row for this destination/category/window is still fresh.
  let cached: EventItem[] = [];
  try {
    cached = await listUpcomingEvents(db, { destination, category, from, to, limit });
  } catch (err) {
    console.error("[events/getForDestination] cached lookup failed, falling through to live search", err);
  }

  if (cached.length > 0) {
    const newestFetch = cached.reduce<number>((max, row) => {
      const t = row.fetched_at ? new Date(row.fetched_at).getTime() : 0;
      return Number.isFinite(t) ? Math.max(max, t) : max;
    }, 0);
    if (newestFetch > 0 && Date.now() - newestFetch < EVENTS_CACHE_TTL_MS) {
      return { center, events: cached };
    }
  }

  // 2. No provider keys at all → degrade to whatever's cached (possibly []).
  if (!process.env.SKIDDLE_API_KEY && !process.env.TICKETMASTER_API_KEY) {
    return { center, events: cached, degraded: "no-event-keys" };
  }

  // No geocoded center → providers can't run a geo search at all; treat the
  // same as every provider failing.
  if (!center) {
    console.error("[events/getForDestination] no geocoded center for destination, cannot query providers");
    return { center, events: cached, degraded: "events-error" };
  }

  // 3. Fetch live events (fan-out; one provider failing never kills the response).
  const { events: mapped, providersUsed, providersFailed } = await searchEvents({
    destination,
    center,
    radiusKm,
    category,
    q,
    from,
    to,
    limit,
  });

  if (providersFailed.length > 0) {
    console.error(
      `[events/getForDestination] provider(s) failed: ${providersFailed.join(", ")} (used: ${providersUsed.join(", ") || "none"})`
    );
  }

  if (providersUsed.length === 0) {
    // Either every enabled provider errored, or (shouldn't happen given the
    // no-keys check above, but kept for safety) none were enabled at all.
    return { center, events: cached, degraded: "events-error" };
  }

  const deduped = dedupeEvents(mapped);

  if (deduped.length === 0) {
    return { center, events: cached.length > 0 ? cached : [] };
  }

  // 4. Cache into `events` (dedupe on provider,provider_event_id) and return rows with ids.
  //
  // Split into two upsert batches by whether we resolved a photo — the exact
  // clobber guard at app/api/places/route.ts:150-162. supabase-js's upsert()
  // writes every key present in the row object on conflict, so `image_url`
  // must be *omitted* (not null) for rows with no new photo, so a
  // re-discovered event's existing image survives untouched.
  const rowsWithPhoto = deduped.filter((m) => m.image_url != null);
  const rowsWithoutPhoto = deduped
    .filter((m) => m.image_url == null)
    .map(({ image_url: _image_url, ...rest }) => rest);

  // Catalog writes always go through the service-role client — RLS's
  // catalog policy (supabase/harden_rls.sql) is select-only for
  // anon/authenticated from this phase on, so a session-scoped `db` can't
  // upsert here regardless of who's calling.
  const admin = supabaseAdmin();
  const results = await Promise.all([
    rowsWithPhoto.length > 0
      ? admin
          .from("events")
          .upsert(rowsWithPhoto, { onConflict: "provider,provider_event_id" })
          .select("*")
      : Promise.resolve({ data: [] as EventItem[], error: null }),
    rowsWithoutPhoto.length > 0
      ? admin
          .from("events")
          .upsert(rowsWithoutPhoto, { onConflict: "provider,provider_event_id" })
          .select("*")
      : Promise.resolve({ data: [] as EventItem[], error: null }),
  ]);

  const error = results[0].error ?? results[1].error;
  const data = error ? null : [...(results[0].data ?? []), ...(results[1].data ?? [])];

  if (error || !data) {
    // Migration not run yet (missing table / unique index) — still render
    // the live results via synthetic rows.
    const rows: unknown = data;
    console.error(
      `[events/getForDestination] events cache upsert failed (run supabase/add_events.sql) ` +
        `code=${error?.code ?? "<none>"} message=${error?.message ?? "<none>"} ` +
        `details=${error?.details ?? "<none>"} hint=${error?.hint ?? "<none>"} ` +
        `dataIsNull=${rows === null} dataLength=${Array.isArray(rows) ? rows.length : "n/a"}`
    );
    return {
      center,
      events: deduped.map(syntheticEvent).sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
      degraded: "cache-unavailable",
    };
  }

  const sorted = (data as EventItem[]).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  return { center, events: sorted };
}
