/**
 * Venue linking: sets `events.place_id` by matching each row's venue_name (plus
 * a distance check) against the Edinburgh `places` catalogue, so an event with
 * no photo of its own can borrow its venue's photo and show the venue's
 * address / Maps link / website at read time (lib/db/events.ts joins `place`).
 *
 * Runs once per daily run, after validation and cross-source dedupe, in dry
 * runs too (read-only GET). Name matching is scripts/lib/place-match.mjs's
 * buildPlaceIndex / matchVenueName — conservative by design: exact or
 * whole-token-prefix names only, and ambiguous results stay unlinked (listed in
 * the summary) because a wrong link puts the wrong venue's photo on an event.
 *
 * Rules on top of the name match:
 *   - when the row AND the place both have coordinates the place must be within
 *     LINK_MAX_METERS (400 m); a same-named place further away is a different
 *     venue ("The Hub" in Leith vs. Glasgow);
 *   - when the row has no coordinates only a UNIQUE name match is accepted (a
 *     duplicate-place tie broken in favour of the one with a photo is not);
 *   - several candidates within range stay ambiguous.
 *
 * Venues that don't link and appear on >= 2 rows go to the free-tier Google
 * lookup (core/google-venues.mjs).
 */

import { buildPlaceIndex, matchVenueName, nameKey } from "../../lib/place-match.mjs";
import { haversineMeters } from "../../lib/google-place-map.mjs";
import { hasSupabase, restGetAll } from "./rest.mjs";
import { resolveUnknownVenues, GOOGLE_MAX_CALLS } from "./google-venues.mjs";

export const LINK_MAX_METERS = 400;

// Curated places only (the live Google cache, source=google, carries Google
// photos which we deliberately never borrow), and place_photos so a place whose
// only photo lives there still breaks duplicate-name ties.
export const VENUE_PLACES_QUERY =
  "places?source=neq.google" +
  "&or=(city.ilike.*Edinburgh*,destination.ilike.*Edinburgh*,address.ilike.*Edinburgh*)" +
  "&select=id,name,lat,lng,address,image_url,google_place_id,website,google_maps_uri,place_photos(url,display_order)" +
  "&order=id.asc";

/** Edinburgh `places` rows for the index, or null when the DB is unreachable / not configured. */
export async function loadVenuePlaces() {
  if (!hasSupabase()) return null;
  const res = await restGetAll(VENUE_PLACES_QUERY);
  if (!res.ok) {
    console.warn(`[daily-sources] venue linking: places lookup failed (${res.status}): ${JSON.stringify(res.error)} — skipping venue linking`);
    return null;
  }
  return res.rows;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function distanceOrNull(row, place) {
  if (!isNum(row.lat) || !isNum(row.lng) || !isNum(place.lat) || !isNum(place.lng)) return null;
  return haversineMeters({ lat: row.lat, lng: row.lng }, { lat: place.lat, lng: place.lng });
}

/**
 * Decide the link for one venue name. Pure. Returns
 *   { status: "linked", place } | { status: "ambiguous", candidates } |
 *   { status: "unlinked", reason: "no_match" | "too_far" }
 */
export function resolveVenue(index, venueName, where = {}, maxMeters = LINK_MAX_METERS) {
  const hasCoords = isNum(where.lat) && isNum(where.lng);
  const row = hasCoords ? { lat: where.lat, lng: where.lng } : {};
  const m = matchVenueName(index, venueName, hasCoords ? where : {});

  if (m.status === "none") return { status: "unlinked", reason: "no_match" };

  if (m.status === "linked") {
    // Without coordinates only an outright unique match counts.
    if (!hasCoords && m.tieBroken) {
      return { status: "ambiguous", candidates: index.places.filter((p) => p.key === m.place.key) };
    }
    const d = distanceOrNull(row, m.place);
    if (d != null && d > maxMeters) return { status: "unlinked", reason: "too_far" };
    return { status: "linked", place: m.place };
  }

  // ambiguous
  if (hasCoords) {
    const withCoords = m.candidates.filter((c) => distanceOrNull(row, c) != null);
    const near = withCoords.filter((c) => distanceOrNull(row, c) <= maxMeters);
    if (near.length === 1 && withCoords.length === m.candidates.length) return { status: "linked", place: near[0] };
    if (near.length === 0 && withCoords.length === m.candidates.length) return { status: "unlinked", reason: "too_far" };
    // Mixed: candidates without coordinates can't be ruled in or out.
    return { status: "ambiguous", candidates: near.length > 0 ? near : m.candidates };
  }
  return { status: "ambiguous", candidates: m.candidates };
}

/**
 * Link `rows` (mutated: place_id) against `placeRows`. Pure given its inputs.
 * Returns
 *   { stats: { rows, alreadyLinked, noVenue, linked, ambiguous, unlinked, tooFar },
 *     ambiguous: [{ venue, rows, candidates: [name] }],
 *     unlinked: [{ key, name, rows: [row], lat, lng, address }]  // by row count desc
 *     linkedByPlace: Map<placeId, count> }
 */
export function linkVenues(rows, placeRows, { maxMeters = LINK_MAX_METERS } = {}) {
  const index = buildPlaceIndex(placeRows);
  const stats = { rows: rows.length, alreadyLinked: 0, noVenue: 0, linked: 0, ambiguous: 0, unlinked: 0, tooFar: 0 };
  const ambiguousByVenue = new Map();
  const unlinkedByKey = new Map();
  const linkedByPlace = new Map();

  for (const row of rows) {
    if (row.place_id) {
      stats.alreadyLinked += 1;
      continue;
    }
    const venue = typeof row.venue_name === "string" ? row.venue_name.trim() : "";
    const key = nameKey(venue);
    if (!venue || !key) {
      stats.noVenue += 1;
      continue;
    }

    const r = resolveVenue(index, venue, { lat: row.lat, lng: row.lng }, maxMeters);
    if (r.status === "linked") {
      row.place_id = r.place.id;
      stats.linked += 1;
      linkedByPlace.set(r.place.id, (linkedByPlace.get(r.place.id) ?? 0) + 1);
      continue;
    }
    if (r.status === "ambiguous") {
      stats.ambiguous += 1;
      const entry = ambiguousByVenue.get(key) ?? { venue, rows: 0, candidates: [...new Set(r.candidates.map((c) => c.name))] };
      entry.rows += 1;
      ambiguousByVenue.set(key, entry);
      continue;
    }
    stats.unlinked += 1;
    if (r.reason === "too_far") stats.tooFar += 1;
    let g = unlinkedByKey.get(key);
    if (!g) {
      g = { key, name: venue, rows: [], lat: null, lng: null, address: null };
      unlinkedByKey.set(key, g);
    }
    g.rows.push(row);
    if (g.lat == null && isNum(row.lat) && isNum(row.lng)) {
      g.lat = row.lat;
      g.lng = row.lng;
    }
    if (!g.address && row.address) g.address = row.address;
  }

  return {
    stats,
    ambiguous: [...ambiguousByVenue.values()].sort((a, b) => b.rows - a.rows),
    unlinked: [...unlinkedByKey.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name)),
    linkedByPlace,
  };
}

export function printVenueSummary(result, { placesLoaded }) {
  const { stats, ambiguous, unlinked } = result;
  console.log(
    `\n[daily-sources] venues: places-indexed=${placesLoaded} rows=${stats.rows} linked=${stats.linked} already-linked=${stats.alreadyLinked} ` +
      `ambiguous=${stats.ambiguous} (${ambiguous.length} venues) unlinked=${stats.unlinked} (${unlinked.length} venues, ${stats.tooFar} too far) no-venue-name=${stats.noVenue}`
  );
  if (ambiguous.length > 0) {
    console.log(`[daily-sources] ambiguous venues left unlinked (top 10 of ${ambiguous.length}):`);
    for (const a of ambiguous.slice(0, 10)) {
      console.log(`    "${a.venue}" x${a.rows} -> ${a.candidates.slice(0, 4).map((c) => `"${c}"`).join(" | ")}`);
    }
  }
  if (unlinked.length > 0) {
    console.log(`[daily-sources] top unlinked venues by row count (top 15 of ${unlinked.length}):`);
    for (const u of unlinked.slice(0, 15)) {
      console.log(`    ${String(u.rows.length).padStart(3)}  "${u.name}"${u.lat == null ? " (no coords)" : ""}`);
    }
  }
}

function printGoogleSummary(g) {
  if (g.skipped) {
    console.log(`[daily-sources] google venues: skipped (${g.skipped})`);
    return;
  }
  console.log(
    `\n[daily-sources] google venues: candidates(>=${g.minRows} rows)=${g.candidates} negative-cached=${g.cachedMisses} google-calls=${g.calls} (cap ${g.maxCalls}) ` +
      `matched-new=${g.matchedNew} matched-existing=${g.matchedExisting} rejected=${g.rejected.length} not-found=${g.notFound} ` +
      `google-cache-skipped=${g.googleCacheSkipped} failed=${g.failed} over-cap=${g.overCap} ` +
      `misses-${g.write ? "recorded" : "to-record"}=${g.write ? g.missesRecorded : g.wouldRecordMisses} ` +
      `rows-linked=${g.rowsLinked}${g.write ? ` inserted=${g.inserted} patched=${g.patched}` : ` would-insert=${g.wouldInsert.length} would-patch=${g.wouldPatch.length} would-link-rows=${g.rowsWouldLink}`}`
  );
  if (g.aborted) console.log(`    ABORTED: ${g.aborted}`);
  for (const p of (g.write ? g.insertedRows : g.wouldInsert).slice(0, 20)) {
    console.log(`    ${g.write ? "inserted" : "would insert"} place: "${p.name}" | ${p.address ?? "?"} | ${p.lat ?? "?"},${p.lng ?? "?"} | ${p.google_place_id}`);
  }
  for (const r of g.rejected.slice(0, 10)) console.log(`    rejected "${r.venue}": ${r.reason}`);
}

/**
 * The daily-run entry point: load places, link, print, then resolve unknown
 * venues through Google (free tier, details only). Mutates `rows`.
 * Never throws; a failure leaves rows unlinked and the run continues.
 */
export async function linkEventVenues(rows, { now = new Date(), write = false, googleMax = GOOGLE_MAX_CALLS } = {}) {
  try {
    const placeRows = await loadVenuePlaces();
    if (!placeRows) {
      console.log("\n[daily-sources] venues: skipped (no database access)");
      return null;
    }
    const result = linkVenues(rows, placeRows);
    printVenueSummary(result, { placesLoaded: placeRows.length });
    const google = await resolveUnknownVenues(result.unlinked, { now, write, maxCalls: googleMax });
    printGoogleSummary(google);
    return { ...result, google };
  } catch (err) {
    console.error(`[daily-sources] venue linking FAILED (rows stay unlinked): ${err.stack ?? err.message}`);
    return null;
  }
}
