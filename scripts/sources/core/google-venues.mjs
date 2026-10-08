/**
 * Unknown venues -> Google, free tier, DETAILS ONLY.
 *
 * Venue names that appear on >= 2 rows in this run and didn't link to a
 * `places` row (core/venues.mjs) are looked up with Places API (New):
 *   1. Text Search, field mask `places.id` only (the IDs Only SKU: unlimited, free);
 *   2. Place Details, mask `id,displayName,formattedAddress,location,googleMapsUri`
 *      (id/formattedAddress/location are Essentials; displayName/googleMapsUri
 *      are the Pro SKU, which has a 5,000/month free allowance — at most
 *      GOOGLE_MAX_CALLS/2 lookups a run keeps that comfortably free).
 * NEVER a photo field and never Place Photos (user decision: photos come from
 * free sources only). A candidate is accepted only through
 * scripts/lib/google-place-map.mjs acceptMatch (name similarity + distance).
 *
 * An accepted venue becomes a `places` row (`source = 'event-venue'`) so the
 * normal name matcher links it on every later run without calling Google
 * again; a Google id already in `places` just links to that row (and fills
 * its blank address/location/maps link). Google-owned columns get
 * `google_fetched_at`, so scripts/enrich-places-google.mjs's 30-day expiry
 * covers them. Inserts and patches happen ONLY with --write; a dry run prints
 * what it would do (Google reads still happen, capped).
 *
 * Candidates are ranked by distinct event names (a tour repeating daily for a
 * month is one event, not 31), then row count. A venue that Google rejected or
 * couldn't match goes into the `source_pages` ledger (core/page-ledger.mjs;
 * url `google-venue:<normalised name>`, source_id `google-venue-miss`) and is
 * skipped for 30 days; written only with --write, and if the table is missing
 * there is simply no cache (page-ledger warns once). Expiry never needs a
 * re-resolve: it only clears the Google-owned columns of an existing place,
 * which stays linked by name, and enrich-places-google.mjs refreshes them.
 *
 * Skipped entirely when GOOGLE_PLACES_API_KEY is absent or the cap is 0.
 */

import { acceptMatch, buildPlacePatch, EDINBURGH_CENTRE } from "../../lib/google-place-map.mjs";
import { nameKey } from "../../lib/place-match.mjs";
import { hasSupabase, rest } from "./rest.mjs";
import { loadLedger, recordPages } from "./page-ledger.mjs";

export const GOOGLE_MAX_CALLS = 40;
// Negative cache: a venue Google rejected or couldn't match is not retried for this long.
export const MISS_TTL_DAYS = 30;
export const MISS_SOURCE_ID = "google-venue-miss";
export const missUrl = (venueName) => `google-venue:${nameKey(venueName)}`;
export const MIN_ROWS_FOR_LOOKUP = 2;
export const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
export const DETAILS_URL = "https://places.googleapis.com/v1/places";
export const SEARCH_MASK = "places.id"; // IDs Only SKU
export const DETAILS_MASK = "id,displayName,formattedAddress,location,googleMapsUri";
const MIN_CALL_INTERVAL_MS = 200;

// Same `destination` string the curated Edinburgh places carry.
export const VENUE_PLACE_DEFAULTS = {
  category: "venue",
  source: "event-venue",
  destination: "Edinburgh, Scotland",
  city: "Edinburgh",
  // events/places: country has a misleading column default ('JP') — always explicit.
  country: "GB",
};

/** Text Search request body. maxResultCount 1: we only trust the top hit, and every extra candidate would cost a Details call. */
export function buildTextSearchBody(venueName) {
  return {
    textQuery: `${venueName}, Edinburgh`,
    maxResultCount: 1,
    locationBias: {
      circle: { center: { latitude: EDINBURGH_CENTRE.lat, longitude: EDINBURGH_CENTRE.lng }, radius: 15000 },
    },
    regionCode: "GB",
    languageCode: "en",
  };
}

/**
 * The `places` row for an accepted venue. `name` stays the EVENT's venue name
 * (not Google's displayName) so the next run's name matcher links it for sure.
 * Only fields we actually fetched: no rating/website/phone (never null-filled).
 */
export function buildVenuePlaceRow(venueName, details, now) {
  const patch = buildPlacePatch({ name: venueName }, details, now);
  return {
    name: venueName,
    ...patch.fills, // google_place_id, address, lat, lng
    google_maps_uri: patch.google.google_maps_uri,
    google_fetched_at: patch.google.google_fetched_at,
    ...VENUE_PLACE_DEFAULTS,
  };
}

/**
 * Patch for a place we already hold that Google just confirmed: blanks only
 * (address / lat / lng / google_place_id), plus the Maps link — with its
 * `google_fetched_at` so the 30-day expiry applies — when the row has none.
 */
export function buildExistingPlacePatch(existing, details, now) {
  const p = buildPlacePatch(existing, details, now);
  const patch = { ...p.fills };
  if (!existing.google_maps_uri && p.google.google_maps_uri) {
    patch.google_maps_uri = p.google.google_maps_uri;
    patch.google_fetched_at = p.google.google_fetched_at;
  }
  return patch;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real Google client: throttled, counts every HTTP attempt, retries 429/5xx twice. */
export function makeGoogleClient(apiKey, { fetchImpl = fetch, intervalMs = MIN_CALL_INTERVAL_MS, maxCalls = Infinity } = {}) {
  let last = 0;
  const client = { calls: 0 };
  async function call(url, init) {
    let out = { ok: false, status: 0, json: null, error: "no attempt" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(1000 * 3 ** (attempt - 1));
      // Hard cap on HTTP attempts, retries included.
      if (client.calls >= maxCalls) return { ok: false, status: 0, json: null, error: "call cap reached" };
      const wait = last + intervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      client.calls += 1;
      try {
        const res = await fetchImpl(url, init);
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* non-JSON error body */
        }
        out = { ok: res.ok, status: res.status, json, error: res.ok ? null : (json?.error?.message ?? text.slice(0, 200)) };
        if (res.ok || (res.status !== 429 && res.status < 500)) return out;
      } catch (err) {
        out = { ok: false, status: 0, json: null, error: err.message };
      }
    }
    return out;
  }
  client.search = async (venueName) => {
    const r = await call(SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": SEARCH_MASK },
      body: JSON.stringify(buildTextSearchBody(venueName)),
    });
    return { ...r, ids: (r.json?.places ?? []).map((p) => p.id).filter(Boolean) };
  };
  client.details = (placeId) =>
    call(`${DETAILS_URL}/${encodeURIComponent(placeId)}?languageCode=en&regionCode=GB`, {
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": DETAILS_MASK },
    });
  return client;
}

const PLACE_COLUMNS = "id,name,source,address,lat,lng,google_place_id,google_maps_uri,google_fetched_at";

/** Real DB side: lookup by Google id, insert, patch. Lookups are read-only (also in dry runs). */
export function makeVenueDb() {
  return {
    async findByGoogleId(googleId) {
      if (!hasSupabase()) return null;
      const res = await rest(`places?google_place_id=eq.${encodeURIComponent(googleId)}&select=${PLACE_COLUMNS}&limit=1`);
      return res.ok && Array.isArray(res.data) ? (res.data[0] ?? null) : null;
    },
    async insertPlace(row) {
      const res = await rest("places", { method: "POST", body: row, prefer: "return=representation" });
      if (res.ok && Array.isArray(res.data) && res.data[0]?.id) return { id: res.data[0].id };
      // Unique violation on google_place_id (raced with another writer): reuse the winner.
      const again = await this.findByGoogleId(row.google_place_id);
      if (again) return { id: again.id };
      return { id: null, error: JSON.stringify(res.error) };
    },
    async patchPlace(id, patch) {
      const res = await rest(`places?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
      return { ok: res.ok, error: res.ok ? null : JSON.stringify(res.error) };
    },
  };
}

const AUTH_FAILURE_RE = /api key|API_KEY|permission|not been used|disabled|billing|forbidden/i;

/**
 * Resolve `groups` ({ name, rows: [row], lat, lng }, by row count desc) through
 * Google. `google` / `db` are injectable for tests. Returns the stats object
 * printed by core/venues.mjs.
 */
export async function resolveUnknownVenues(groups, opts = {}) {
  const {
    now = new Date(),
    write = false,
    maxCalls = GOOGLE_MAX_CALLS,
    minRows = MIN_ROWS_FOR_LOOKUP,
    apiKey = process.env.GOOGLE_PLACES_API_KEY,
    google = apiKey ? makeGoogleClient(apiKey, { maxCalls }) : null,
    db = makeVenueDb(),
    ledger = { load: () => loadLedger(MISS_SOURCE_ID), record: (entries) => recordPages(entries, { write, now }) },
  } = opts;

  const empty = (skipped) => ({ skipped, minRows, maxCalls, write });
  if (!google) return empty("GOOGLE_PLACES_API_KEY not set");
  if (!(maxCalls > 0)) return empty("--google-max=0");

  const distinctNames = (g) => new Set(g.rows.map((r) => String(r.name ?? "").toLowerCase().trim())).size;
  const eligible = groups
    .filter((g) => g.rows.length >= minRows)
    .sort((a, b) => distinctNames(b) - distinctNames(a) || b.rows.length - a.rows.length || a.name.localeCompare(b.name));
  const misses = await ledger.load();
  const recentMiss = (g) => {
    const t = Date.parse(misses.get(missUrl(g.name))?.last_fetched_at ?? "");
    return Number.isFinite(t) && now.getTime() - t < MISS_TTL_DAYS * 86_400_000;
  };
  const candidates = eligible.filter((g) => !recentMiss(g));
  const newMisses = [];
  const noteMiss = (g) => newMisses.push({ url: missUrl(g.name), source_id: MISS_SOURCE_ID, content_hash: "miss" });
  const s = {
    minRows, maxCalls, write, candidates: candidates.length, cachedMisses: eligible.length - candidates.length,
    calls: 0, matchedNew: 0, matchedExisting: 0, notFound: 0, failed: 0, overCap: 0,
    googleCacheSkipped: 0, rowsLinked: 0, rowsWouldLink: 0, inserted: 0, patched: 0,
    rejected: [], wouldInsert: [], wouldPatch: [], insertedRows: [], aborted: null,
  };
  const linkRows = (g, placeId) => {
    for (const row of g.rows) row.place_id = placeId;
    s.rowsLinked += g.rows.length;
  };
  // One Google id can serve several spellings of a venue within a run.
  const byGoogleId = new Map(); // googleId -> placeId | null (insert pending in dry run)

  for (const g of candidates) {
    if (google.calls + 2 > maxCalls) {
      s.overCap += 1;
      continue;
    }
    const found = await google.search(g.name);
    if (!found.ok) {
      s.failed += 1;
      if ([400, 401, 403].includes(found.status) && AUTH_FAILURE_RE.test(found.error ?? "")) {
        s.aborted = `Google rejected the request (${found.status}: ${found.error}) — check GOOGLE_PLACES_API_KEY and that Places API (New) is enabled`;
        break;
      }
      continue;
    }
    const googleId = found.ids[0];
    if (!googleId) {
      s.notFound += 1;
      noteMiss(g);
      continue;
    }

    const details = await google.details(googleId);
    if (!details.ok || !details.json) {
      s.failed += 1;
      continue;
    }
    const verdict = acceptMatch({ name: g.name, lat: g.lat, lng: g.lng }, details.json);
    if (!verdict.ok) {
      s.rejected.push({ venue: g.name, reason: verdict.reason });
      noteMiss(g);
      continue;
    }

    if (byGoogleId.has(googleId)) {
      const placeId = byGoogleId.get(googleId);
      if (placeId) linkRows(g, placeId);
      else s.rowsWouldLink += g.rows.length;
      continue;
    }

    const existing = await db.findByGoogleId(googleId);
    if (existing) {
      if (existing.source === "google") {
        // The live Google cache carries Google photos and a 30-day lifetime of its own: never link events to it.
        s.googleCacheSkipped += 1;
        noteMiss(g);
        byGoogleId.set(googleId, null);
        continue;
      }
      s.matchedExisting += 1;
      const patch = buildExistingPlacePatch(existing, details.json, now);
      if (Object.keys(patch).length > 0) {
        if (write) {
          const r = await db.patchPlace(existing.id, patch);
          if (r.ok) s.patched += 1;
          else s.failed += 1;
        } else {
          s.wouldPatch.push({ id: existing.id, name: existing.name, patch });
        }
      }
      byGoogleId.set(googleId, existing.id);
      linkRows(g, existing.id);
      continue;
    }

    const placeRow = buildVenuePlaceRow(g.name, details.json, now);
    s.matchedNew += 1;
    if (!write) {
      s.wouldInsert.push(placeRow);
      byGoogleId.set(googleId, null);
      s.rowsWouldLink += g.rows.length;
      continue;
    }
    const inserted = await db.insertPlace(placeRow);
    if (!inserted.id) {
      s.failed += 1;
      console.error(`[daily-sources] google venues: insert failed for "${g.name}": ${inserted.error}`);
      continue;
    }
    s.inserted += 1;
    s.insertedRows.push(placeRow);
    byGoogleId.set(googleId, inserted.id);
    linkRows(g, inserted.id);
  }

  s.calls = google.calls;
  s.missesRecorded = write ? newMisses.length : 0;
  s.wouldRecordMisses = write ? 0 : newMisses.length;
  if (newMisses.length > 0) await ledger.record(newMisses);
  return s;
}
