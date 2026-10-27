/**
 * Short-lived, in-memory caches in front of the read-only catalogue queries
 * that /api/feed (and Ask Fomo's catalogue) run on every request.
 *
 * Why: one /api/feed request made 6-7 sequential Supabase round trips
 * (live happenings, two upcoming-events reads, all ~3,400 city places for
 * Free Any Time, venue lookups) — 3.5-4.5s per request, and Deals, Book early
 * and Free each paid it again. Every one of these reads is of rows anon may see under RLS
 * (places, live happenings, active events), so the rows are identical for every visitor — safe to share
 * across requests.
 *
 * Semantics, per key:
 *  - fresh (age < ttl): served from memory;
 *  - stale (ttl <= age < ttl * STALE_FACTOR): served from memory immediately
 *    while ONE background refresh runs (stale-while-revalidate);
 *  - older / missing: the caller awaits the query; concurrent callers share
 *    the same in-flight promise instead of each hitting the database.
 * A failed refresh never evicts a good stale value. Per server instance
 * (warm Vercel functions keep it between requests); a cold start just queries.
 *
 * Drop-in: same names and signatures as lib/db/*, so a caller swaps imports.
 * Arrays are returned as shallow copies so a caller's in-place `.sort()` can
 * never reorder the shared cached array.
 */
import "server-only";
import type { Db } from "@/lib/supabase/types";
import { CITY, type CityConfig } from "@/lib/city";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem, Place } from "@/lib/types";
import { listLiveHappenings as dbLiveHappenings } from "@/lib/db/happenings";
import { listUpcomingEvents as dbUpcomingEvents } from "@/lib/db/events";
import { listPlacesByCity as dbPlacesByCity, listPlacesByIds as dbPlacesByIds } from "@/lib/db/places";

const STALE_FACTOR = 10;
const MAX_ENTRIES = 300;

const CATALOGUE_TTL_MS = 2 * 60_000; // happenings + events: new rows land daily
const PLACES_TTL_MS = 10 * 60_000; // places change on research runs, rarely

interface Entry {
  at: number;
  value?: unknown;
  promise?: Promise<unknown>;
}

const store = new Map<string, Entry>();

function remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const entry = store.get(key);
  const age = entry ? Date.now() - entry.at : Infinity;

  if (entry && entry.value !== undefined && age < ttlMs) return Promise.resolve(entry.value as T);
  if (entry?.promise && entry.value === undefined) return entry.promise as Promise<T>;

  const refresh = (): Promise<T> => {
    const promise = load().then(
      (value) => {
        store.delete(key); // re-insert to keep Map order ≈ recency for eviction
        store.set(key, { at: Date.now(), value });
        if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
        return value;
      },
      (err) => {
        const cur = store.get(key);
        if (cur?.promise === promise) {
          if (cur.value === undefined) store.delete(key);
          else store.set(key, { at: cur.at, value: cur.value });
        }
        throw err;
      }
    );
    store.set(key, { at: entry?.at ?? 0, value: entry?.value, promise });
    return promise;
  };

  if (entry && entry.value !== undefined && age < ttlMs * STALE_FACTOR) {
    if (!entry.promise) refresh().catch((err) => console.error(`[db/cached] background refresh failed: ${key}`, err));
    return Promise.resolve(entry.value as T);
  }
  return refresh();
}

const FIVE_MIN_MS = 5 * 60_000;

export async function listLiveHappenings(db: Db, city: CityConfig = CITY): Promise<Happening[]> {
  const rows = await remember(`happenings:live:${city.name}`, CATALOGUE_TTL_MS, () => dbLiveHappenings(db, city));
  return rows.slice();
}

/**
 * `from` is floored and `to` ceiled to 5-minute buckets (and the query runs
 * on the bucketed bounds), so requests a few seconds apart share one cache
 * entry — "now"-based windows would otherwise never repeat. At worst an
 * event that ended up to 5 minutes ago is still included; every caller
 * already applies its own `eventHasEnded`-style guard downstream.
 */
export async function listUpcomingEvents(db: Db, opts: Parameters<typeof dbUpcomingEvents>[1] = {}): Promise<EventItem[]> {
  const fromMs = opts.from ? Date.parse(opts.from) : Date.now();
  const bucketedFrom = new Date(Math.floor(fromMs / FIVE_MIN_MS) * FIVE_MIN_MS).toISOString();
  const bucketedTo = opts.to ? new Date(Math.ceil(Date.parse(opts.to) / FIVE_MIN_MS) * FIVE_MIN_MS).toISOString() : undefined;
  const q = { ...opts, from: bucketedFrom, to: bucketedTo };
  const key = `events:${q.destination ?? ""}:${q.category ?? ""}:${q.from}:${q.to ?? ""}:${q.limit ?? ""}`;
  const rows = await remember(key, CATALOGUE_TTL_MS, () => dbUpcomingEvents(db, q));
  return rows.slice();
}

export async function listPlacesByIds(db: Db, ids: string[]): Promise<Place[]> {
  if (ids.length === 0) return [];
  const sorted = Array.from(new Set(ids)).sort();
  const rows = await remember(`places:ids:${sorted.join(",")}`, PLACES_TTL_MS, () => dbPlacesByIds(db, sorted));
  return rows.slice();
}

export async function listPlacesByCity(db: Db, query: string): Promise<Place[]> {
  const rows = await remember(`places:city:${query.trim().toLowerCase()}`, PLACES_TTL_MS, () => dbPlacesByCity(db, query));
  return rows.slice();
}
