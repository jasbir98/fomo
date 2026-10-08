import test from "node:test";
import assert from "node:assert/strict";
import {
  signFestivalsRequest,
  buildSignedUrl,
  londonWallClock,
  parseFestivalsDate,
  festivalYearFor,
  festivalPrice,
  pickFestivalImage,
  categoryFromFestivalEvent,
  mapFestivalEvent,
} from "../adapters/festivals-api.mjs";

// Worked example from https://api.edinburghfestivalcity.com/documentation/querying
// (access key 12345678, secret 135fa25acs33, query /events?filter=that&key=12345678).
test("signature matches the documented worked example", () => {
  assert.equal(
    signFestivalsRequest("/events?filter=that&key=12345678", "135fa25acs33"),
    "e471178c45d33d7a37f99f74f8ff59d97749e7bf"
  );
});

test("buildSignedUrl appends key last and signs path+query without the signature", () => {
  const url = buildSignedUrl("/events", { filter: "that" }, { key: "12345678", secret: "135fa25acs33" });
  assert.equal(
    url,
    "https://api.edinburghfestivalcity.com/events?filter=that&key=12345678&signature=e471178c45d33d7a37f99f74f8ff59d97749e7bf"
  );
});

test("buildSignedUrl signs the url-encoded string it sends", () => {
  const url = buildSignedUrl("/events", { date_from: "2026-10-08 12:00:00" }, { key: "k", secret: "s" });
  const [base, sig] = url.split("&signature=");
  const pathAndQuery = base.replace("https://api.edinburghfestivalcity.com", "");
  assert.equal(pathAndQuery, "/events?date_from=2026-10-08+12%3A00%3A00&key=k");
  assert.equal(sig, signFestivalsRequest(pathAndQuery, "s"));
});

test("London wall-clock and parse round-trip across BST/GMT", () => {
  assert.equal(londonWallClock(new Date("2026-10-08T11:00:00Z")), "2026-10-08 12:00:00");
  assert.equal(londonWallClock(new Date("2026-12-01T11:00:00Z")), "2026-12-01 11:00:00");
  assert.equal(parseFestivalsDate("2026-10-08 12:00:00"), "2026-10-08T11:00:00.000Z");
  assert.equal(parseFestivalsDate("2026-12-31 20:00:00"), "2026-12-31T20:00:00.000Z");
  assert.equal(parseFestivalsDate("2026-10-08T12:00:00+01:00"), "2026-10-08T11:00:00.000Z");
  assert.equal(parseFestivalsDate("nonsense"), null);
});

test("festival year rolls over on 15 January", () => {
  assert.equal(festivalYearFor(new Date("2027-01-14T00:00:00Z")), 2026);
  assert.equal(festivalYearFor(new Date("2027-01-15T00:00:00Z")), 2027);
  assert.equal(festivalYearFor(new Date("2026-10-08T00:00:00Z")), 2026);
});

test("price types", () => {
  assert.deepEqual(festivalPrice({ price_type: "free" }), { isFree: true, priceFrom: 0, payWhatYouCan: false });
  assert.deepEqual(festivalPrice({ price_type: "pay_what_you_can" }), { isFree: false, priceFrom: null, payWhatYouCan: true });
  assert.deepEqual(festivalPrice({ price: "12.5", price_type: "paid" }), { isFree: false, priceFrom: 12.5, payWhatYouCan: false });
  assert.deepEqual(festivalPrice({ price: null }), { isFree: null, priceFrom: null, payWhatYouCan: false });
});

test("image picks hero landscape, prefers large-1024, fixes scheme-relative", () => {
  const url = pickFestivalImage({
    a: { type: "thumb", orientation: "square", versions: { original: { url: "https://x/thumb.jpg" } } },
    b: { type: "hero", orientation: "landscape", versions: { original: { url: "https://x/o.jpg" }, "large-1024": { url: "https://x/l.jpg" } } },
  });
  assert.equal(url, "https://x/l.jpg");
  assert.equal(pickFestivalImage({ a: { type: "hero", versions: { original: { url: "//x/y.jpg" } } } }), "https://x/y.jpg");
  assert.equal(pickFestivalImage(null), null);
});

test("category from genre, falling back to the festival", () => {
  assert.equal(categoryFromFestivalEvent({ genre: "Comedy", festival_id: "fringe" }), "comedy");
  assert.equal(categoryFromFestivalEvent({ genre: null, festival_id: "jazz" }), "music");
  assert.equal(categoryFromFestivalEvent({ genre: "Spectacle", festival_id: "hogmanay" }), "festival");
});

test("mapFestivalEvent: one row per in-window performance, API website as ticket_url", () => {
  const now = new Date("2026-10-08T09:00:00Z");
  const windowEnd = new Date("2026-11-08T09:00:00Z");
  const event = {
    id: "abc123",
    title: "Late Night Jazz",
    festival_id: "jazz",
    genre: "Jazz",
    website: "https://www.edinburghjazzfestival.com/events/late-night-jazz",
    url: "https://api.edinburghfestivalcity.com/events/abc123",
    description: "<p>An evening of improvised jazz.</p>",
    venue: { name: "The Jazz Bar", address: "1a Chambers Street", post_code: "EH1 1HR", position: { lat: 55.947, lon: -3.188 } },
    performances: [
      { start: "2026-10-01 20:00:00", price: 10 }, // past
      { start: "2026-10-20 20:00:00", price: 12, price_type: "paid" },
      { start: "2026-10-21 20:00:00", price_type: "pay_what_you_can" },
      { start: "2026-12-20 20:00:00", price: 12 }, // beyond window
    ],
  };
  const { rows, reasons } = mapFestivalEvent(event, { now, windowEnd });
  assert.equal(rows.length, 2);
  assert.equal(reasons.past, 1);
  assert.equal(rows[0].provider, "edfestivals");
  assert.equal(rows[0].provider_event_id, "abc123:2026-10-20T19:00:00.000Z");
  assert.equal(rows[0].ticket_url, event.website);
  assert.equal(rows[0].price_from, 12);
  assert.equal(rows[0].category, "music");
  assert.equal(rows[0].lat, 55.947);
  assert.ok(rows[1].description.startsWith("Pay what you can."));
  assert.equal(rows[1].price_from, null);
});

test("mapFestivalEvent skips cancelled events", () => {
  const { rows } = mapFestivalEvent(
    { id: "x", title: "T", status: "cancelled", performances: [{ start: "2026-10-20 20:00:00" }] },
    { now: new Date("2026-10-08T09:00:00Z"), windowEnd: new Date("2026-11-08T09:00:00Z") }
  );
  assert.equal(rows.length, 0);
});
