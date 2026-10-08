import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DETAILS_MASK,
  SEARCH_MASK,
  buildExistingPlacePatch,
  buildTextSearchBody,
  buildVenuePlaceRow,
  makeGoogleClient,
  MISS_TTL_DAYS,
  missUrl,
  resolveUnknownVenues as resolveReal,
} from "./google-venues.mjs";

const NOW = new Date("2026-10-08T12:00:00Z");

// Tests never touch the real source_pages ledger.
const noLedger = { load: async () => new Map(), record: async () => {} };
const resolveUnknownVenues = (groups, opts = {}) => resolveReal(groups, { ledger: noLedger, ...opts });

const details = (over = {}) => ({
  id: "g1",
  displayName: { text: "The Caves" },
  formattedAddress: "8-12 Niddry St S, Edinburgh EH1 1NS, UK",
  location: { latitude: 55.9489, longitude: -3.1853 },
  googleMapsUri: "https://maps.google.com/?cid=1",
  ...over,
});

const group = (name, n, extra = {}) => ({
  key: name.toLowerCase(),
  name,
  rows: Array.from({ length: n }, () => ({ venue_name: name })),
  lat: 55.949,
  lng: -3.1855,
  address: null,
  ...extra,
});

function fakeGoogle({ ids = ["g1"], det = details(), searchStatus = 200, searchError = null } = {}) {
  const g = { calls: 0, searched: [], detailed: [] };
  g.search = async (name) => {
    g.calls += 1;
    g.searched.push(name);
    if (searchStatus !== 200) return { ok: false, status: searchStatus, error: searchError, ids: [] };
    return { ok: true, status: 200, ids };
  };
  g.details = async (id) => {
    g.calls += 1;
    g.detailed.push(id);
    return { ok: true, status: 200, json: typeof det === "function" ? det(id) : det };
  };
  return g;
}

function fakeDb({ existing = null } = {}) {
  const db = { inserted: [], patched: [] };
  db.findByGoogleId = async () => existing;
  db.insertPlace = async (row) => {
    db.inserted.push(row);
    return { id: `new-${db.inserted.length}` };
  };
  db.patchPlace = async (id, patch) => {
    db.patched.push({ id, patch });
    return { ok: true };
  };
  return db;
}

test("field masks never ask for photos or paid-tier fields", () => {
  assert.equal(SEARCH_MASK, "places.id");
  for (const f of DETAILS_MASK.split(",")) assert.ok(["id", "displayName", "formattedAddress", "location", "googleMapsUri"].includes(f), f);
  assert.ok(!/photo|rating|review|website|phone|hours/i.test(DETAILS_MASK));
});

test("text search is IDs-only, biased to a 15 km circle, one result", () => {
  const body = buildTextSearchBody("The Caves");
  assert.equal(body.textQuery, "The Caves, Edinburgh");
  assert.equal(body.locationBias.circle.radius, 15000);
  assert.equal(body.maxResultCount, 1);
});

test("buildVenuePlaceRow: event venue name, Edinburgh defaults, Google-owned freshness stamp, no null-filled Google columns", () => {
  const row = buildVenuePlaceRow("The Caves", details(), NOW);
  assert.equal(row.name, "The Caves");
  assert.equal(row.source, "event-venue");
  assert.equal(row.country, "GB");
  assert.equal(row.destination, "Edinburgh, Scotland");
  assert.equal(row.google_place_id, "g1");
  assert.equal(row.address, "8-12 Niddry St S, Edinburgh EH1 1NS, UK");
  assert.equal(row.lat, 55.9489);
  assert.equal(row.google_maps_uri, "https://maps.google.com/?cid=1");
  assert.equal(row.google_fetched_at, NOW.toISOString());
  for (const k of ["rating", "website", "phone", "price_range", "google_summary", "image_url"]) assert.ok(!(k in row), k);
});

test("buildExistingPlacePatch fills blanks only; maps link + freshness only when the row has none", () => {
  const p = buildExistingPlacePatch({ id: "p", name: "The Caves", address: "kept", lat: null, lng: null, google_place_id: null, google_maps_uri: null }, details(), NOW);
  assert.equal(p.address, undefined);
  assert.equal(p.lat, 55.9489);
  assert.equal(p.google_place_id, "g1");
  assert.equal(p.google_maps_uri, "https://maps.google.com/?cid=1");
  assert.equal(p.google_fetched_at, NOW.toISOString());
  const q = buildExistingPlacePatch({ id: "p", name: "The Caves", address: "a", lat: 1, lng: 1, google_place_id: "g1", google_maps_uri: "https://m" }, details(), NOW);
  assert.deepEqual(q, {});
});

test("dry run: Google is read, nothing is inserted, rows are not linked to a place that doesn't exist yet", async () => {
  const g = group("The Caves", 3);
  const google = fakeGoogle();
  const db = fakeDb();
  const r = await resolveUnknownVenues([g], { now: NOW, write: false, google, db });
  assert.equal(db.inserted.length, 0);
  assert.equal(r.matchedNew, 1);
  assert.equal(r.wouldInsert.length, 1);
  assert.equal(r.rowsWouldLink, 3);
  assert.ok(g.rows.every((x) => x.place_id === undefined));
});

test("--write: inserts the place and links every row of the venue", async () => {
  const g = group("The Caves", 2);
  const db = fakeDb();
  const r = await resolveUnknownVenues([g], { now: NOW, write: true, google: fakeGoogle(), db });
  assert.equal(db.inserted.length, 1);
  assert.equal(r.inserted, 1);
  assert.ok(g.rows.every((x) => x.place_id === "new-1"));
});

test("venues on a single row are never looked up", async () => {
  const google = fakeGoogle();
  const r = await resolveUnknownVenues([group("One Off", 1)], { now: NOW, google, db: fakeDb() });
  assert.equal(google.calls, 0);
  assert.equal(r.candidates, 0);
});

test("a name/distance mismatch is rejected and nothing is linked or inserted", async () => {
  const g = group("The Caves", 2);
  const db = fakeDb();
  const r = await resolveUnknownVenues([g], {
    now: NOW,
    write: true,
    google: fakeGoogle({ det: details({ displayName: { text: "Tesco Express" } }) }),
    db,
  });
  assert.equal(r.rejected.length, 1);
  assert.equal(db.inserted.length, 0);
  assert.ok(g.rows.every((x) => x.place_id === undefined));
});

test("existing curated place with that Google id is linked and its blanks patched (write only)", async () => {
  const existing = { id: "p9", name: "Caves", source: "seed-edinburgh-local", address: null, lat: null, lng: null, google_place_id: "g1", google_maps_uri: null };
  const g = group("The Caves", 2);
  const dry = await resolveUnknownVenues([g], { now: NOW, write: false, google: fakeGoogle(), db: fakeDb({ existing }) });
  assert.equal(dry.matchedExisting, 1);
  assert.equal(dry.wouldPatch.length, 1);
  assert.ok(g.rows.every((x) => x.place_id === "p9")); // linking to an existing place is safe in a dry run

  const g2 = group("The Caves", 2);
  const db = fakeDb({ existing });
  const w = await resolveUnknownVenues([g2], { now: NOW, write: true, google: fakeGoogle(), db });
  assert.equal(db.patched.length, 1);
  assert.equal(db.patched[0].id, "p9");
  assert.equal(w.patched, 1);
});

test("a match on a live Google-cache place is skipped (its photos are Google's)", async () => {
  const g = group("The Caves", 2);
  const r = await resolveUnknownVenues([g], {
    now: NOW,
    google: fakeGoogle(),
    db: fakeDb({ existing: { id: "pg", source: "google", name: "The Caves", google_place_id: "g1" } }),
  });
  assert.equal(r.googleCacheSkipped, 1);
  assert.ok(g.rows.every((x) => x.place_id === undefined));
});

test("call cap: stops before exceeding it", async () => {
  const groups = [group("A Venue", 5), group("B Venue", 4), group("C Venue", 3)];
  const google = fakeGoogle({ det: (id) => details({ id, displayName: { text: "A Venue" } }) });
  const r = await resolveUnknownVenues(groups, { now: NOW, maxCalls: 4, google, db: fakeDb() });
  assert.ok(google.calls <= 4);
  assert.equal(r.overCap, 1);
});

test("an API key failure aborts the step instead of burning the cap", async () => {
  const google = fakeGoogle({ searchStatus: 400, searchError: "API key not valid. Please pass a valid API key." });
  const r = await resolveUnknownVenues([group("A Venue", 3), group("B Venue", 3)], { now: NOW, google, db: fakeDb() });
  assert.equal(google.searched.length, 1);
  assert.match(r.aborted, /GOOGLE_PLACES_API_KEY/);
});

test("skipped without a key, and with a zero cap", async () => {
  assert.match((await resolveUnknownVenues([group("A", 3)], { apiKey: "" })).skipped, /not set/);
  assert.match((await resolveUnknownVenues([group("A", 3)], { apiKey: "k", maxCalls: 0 })).skipped, /google-max/);
});

test("makeGoogleClient: counts attempts and refuses beyond maxCalls", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, mask: init.headers["X-Goog-FieldMask"] });
    return { ok: true, status: 200, text: async () => JSON.stringify({ places: [{ id: "g1" }] }) };
  };
  const c = makeGoogleClient("k", { fetchImpl, intervalMs: 0, maxCalls: 2 });
  const s = await c.search("X");
  assert.deepEqual(s.ids, ["g1"]);
  await c.details("g1");
  const capped = await c.details("g1");
  assert.equal(capped.ok, false);
  assert.equal(c.calls, 2);
  assert.equal(seen[0].mask, "places.id");
  assert.equal(seen[1].mask, DETAILS_MASK);
});

test("default cap is 40 Google calls", async () => {
  const { GOOGLE_MAX_CALLS } = await import("./google-venues.mjs");
  assert.equal(GOOGLE_MAX_CALLS, 40);
});

test("candidates are ranked by distinct event names, then row count", async () => {
  const named = (venue, names) => ({
    ...group(venue, names.length),
    rows: names.map((name) => ({ venue_name: venue, name })),
  });
  const tour = named("Daily Tour Stop", Array(10).fill("Ghost Tour")); // 10 rows, 1 event
  const gigs = named("Gig Room", ["A", "B", "C"]); // 3 rows, 3 events
  const pair = named("Pair Room", ["X", "Y"]); // 2 rows, 2 events
  const google = fakeGoogle({ ids: [] });
  await resolveUnknownVenues([tour, pair, gigs], { now: NOW, google, db: fakeDb() });
  assert.deepEqual(google.searched, ["Gig Room", "Pair Room", "Daily Tour Stop"]);
});

test("misses (not found / rejected) go to the ledger; --write records them, a dry run does not", async () => {
  const recorded = [];
  const ledger = { load: async () => new Map(), record: async (entries) => recorded.push(...entries) };
  const r = await resolveReal(
    [group("Nowhere Bar", 2), group("The Caves", 2)],
    { now: NOW, write: true, ledger, db: fakeDb(), google: fakeGoogle({ det: details({ displayName: { text: "Tesco" } }) }) }
  );
  assert.equal(r.rejected.length, 2);
  assert.deepEqual(recorded.map((e) => e.url).sort(), [missUrl("Nowhere Bar"), missUrl("The Caves")].sort());
  assert.ok(recorded.every((e) => e.source_id === "google-venue-miss" && e.content_hash === "miss"));
  assert.equal(r.missesRecorded, 2);
});

test("a venue missed within 30 days is skipped; an old miss is retried", async () => {
  const day = 86_400_000;
  const ledger = {
    load: async () =>
      new Map([
        [missUrl("Fresh Miss"), { last_fetched_at: new Date(NOW.getTime() - 5 * day).toISOString() }],
        [missUrl("Old Miss"), { last_fetched_at: new Date(NOW.getTime() - (MISS_TTL_DAYS + 1) * day).toISOString() }],
      ]),
    record: async () => {},
  };
  const google = fakeGoogle({ ids: [] });
  const r = await resolveReal([group("Fresh Miss", 3), group("Old Miss", 3)], { now: NOW, ledger, google, db: fakeDb() });
  assert.deepEqual(google.searched, ["Old Miss"]);
  assert.equal(r.cachedMisses, 1);
});

test("a successful match is not recorded as a miss", async () => {
  const recorded = [];
  const ledger = { load: async () => new Map(), record: async (e) => recorded.push(...e) };
  await resolveReal([group("The Caves", 2)], { now: NOW, write: true, ledger, db: fakeDb(), google: fakeGoogle() });
  assert.equal(recorded.length, 0);
});
