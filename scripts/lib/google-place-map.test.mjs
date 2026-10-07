import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EDINBURGH_CENTRE,
  GOOGLE_OWNED_COLUMNS,
  acceptMatch,
  buildPlacePatch,
  compactHours,
  haversineMeters,
  namesMatch,
  periodsToOpeningHours,
  priceLevelToInt,
  priceRangeText,
} from "./google-place-map.mjs";

const p = (od, oh, om, cd, ch, cm) => ({ open: { day: od, hour: oh, minute: om }, close: { day: cd, hour: ch, minute: cm } });
const NNBSP = " "; // Google puts a narrow no-break space before AM/PM

// --- periodsToOpeningHours -------------------------------------------------

test("periodsToOpeningHours: plain daytime periods, sorted by day", () => {
  const out = periodsToOpeningHours({ periods: [p(2, 10, 0, 2, 17, 30), p(1, 10, 0, 1, 17, 0)] });
  assert.deepEqual(out, [
    { day: 1, open: "10:00", close: "17:00" },
    { day: 2, open: "10:00", close: "17:30" },
  ]);
});

test("periodsToOpeningHours: 24h place (open with no close) -> every day 00:00-24:00", () => {
  const out = periodsToOpeningHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] });
  assert.equal(out.length, 7);
  assert.deepEqual(out[0], { day: 0, open: "00:00", close: "24:00" });
  assert.deepEqual(out.map((e) => e.day), [0, 1, 2, 3, 4, 5, 6]);
});

test("periodsToOpeningHours: overnight close (Fri 18:00 -> Sat 01:00) keeps the open day, close past midnight", () => {
  const out = periodsToOpeningHours({ periods: [p(5, 18, 0, 6, 1, 0)] });
  assert.deepEqual(out, [{ day: 5, open: "18:00", close: "01:00" }]);
});

test("periodsToOpeningHours: split hours give two entries on one day; Sunday is day 0", () => {
  const out = periodsToOpeningHours({ periods: [p(0, 18, 0, 0, 22, 0), p(0, 12, 0, 0, 15, 0)] });
  assert.deepEqual(out, [
    { day: 0, open: "12:00", close: "15:00" },
    { day: 0, open: "18:00", close: "22:00" },
  ]);
});

test("periodsToOpeningHours: missing / junk input -> []", () => {
  assert.deepEqual(periodsToOpeningHours(undefined), []);
  assert.deepEqual(periodsToOpeningHours({}), []);
  assert.deepEqual(periodsToOpeningHours({ periods: [{ close: { day: 1, hour: 1 } }, { open: { day: 9, hour: 1 } }] }), []);
});

// --- compactHours ----------------------------------------------------------

const week = (mon, tue, wed, thu, fri, sat, sun) =>
  [mon, tue, wed, thu, fri, sat, sun].map((h, i) => `${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}: ${h}`);

test("compactHours: groups consecutive identical days, 24h clock", () => {
  const a = `10:00${NNBSP}AM – 5:00${NNBSP}PM`;
  const b = `10:00${NNBSP}AM – 6:00${NNBSP}PM`;
  assert.equal(compactHours(week(a, a, a, a, a, b, b)), "Mon–Fri 10:00–17:00, Sat–Sun 10:00–18:00");
});

test("compactHours: same every day -> Daily", () => {
  const h = "9:00 AM – 11:00 PM";
  assert.equal(compactHours(week(h, h, h, h, h, h, h)), "Daily 09:00–23:00");
});

test("compactHours: open 24 hours all week; mixed 24h", () => {
  const o = "Open 24 hours";
  assert.equal(compactHours(week(o, o, o, o, o, o, o)), "Open 24 hours");
  assert.equal(compactHours(week("9:00 AM – 5:00 PM", "9:00 AM – 5:00 PM", "9:00 AM – 5:00 PM", "9:00 AM – 5:00 PM", o, o, "Closed")), "Mon–Thu 09:00–17:00, Fri–Sat 24h, Sun closed");
});

test("compactHours: mixed closed days are listed", () => {
  const h = "11:00 AM – 9:00 PM";
  assert.equal(compactHours(week(h, "Closed", h, h, h, h, h)), "Mon 11:00–21:00, Tue closed, Wed–Sun 11:00–21:00");
});

test("compactHours: overnight close and 12 AM/PM edge cases", () => {
  const bar = "5:00 PM – 1:00 AM";
  assert.equal(compactHours(week("Closed", bar, bar, bar, bar, bar, bar)), "Mon closed, Tue–Sun 17:00–01:00");
  assert.equal(compactHours(week("12:00 PM – 12:00 AM", "12:00 PM – 12:00 AM", "12:00 PM – 12:00 AM", "12:00 PM – 12:00 AM", "12:00 PM – 12:00 AM", "12:00 PM – 12:00 AM", "12:00 PM – 12:00 AM")), "Daily 12:00–00:00");
});

test("compactHours: split hours and a shared meridiem", () => {
  const h = "12:00 – 3:00 PM, 6:00 – 10:00 PM";
  assert.equal(compactHours(week(h, h, h, h, h, h, h)), "Daily 12:00–15:00 & 18:00–22:00");
  const am = "11:00 – 3:00 PM";
  assert.equal(compactHours(week(am, am, am, am, am, am, am)), "Daily 11:00–15:00");
});

test("compactHours: unparseable, closed all week, empty and over-long -> null", () => {
  assert.equal(compactHours(undefined), null);
  assert.equal(compactHours([]), null);
  assert.equal(compactHours(week("By appointment", "x", "x", "x", "x", "x", "x")), null);
  assert.equal(compactHours(["Funday: 10:00 AM – 5:00 PM"]), null);
  assert.equal(compactHours(week("Closed", "Closed", "Closed", "Closed", "Closed", "Closed", "Closed")), null);
  const long = "12:00 – 1:00 PM, 2:00 – 3:00 PM, 4:00 – 5:00 PM, 6:00 – 7:00 PM";
  const diff = (n) => `${long}, 8:00 – ${n}:00 PM`;
  assert.equal(compactHours(week(diff(9), diff(10), diff(11), long, diff(9), diff(10), diff(11))), null);
});

// --- price -----------------------------------------------------------------

test("priceLevelToInt maps the Google enum, rejects the rest", () => {
  assert.equal(priceLevelToInt("PRICE_LEVEL_FREE"), 0);
  assert.equal(priceLevelToInt("PRICE_LEVEL_INEXPENSIVE"), 1);
  assert.equal(priceLevelToInt("PRICE_LEVEL_MODERATE"), 2);
  assert.equal(priceLevelToInt("PRICE_LEVEL_EXPENSIVE"), 3);
  assert.equal(priceLevelToInt("PRICE_LEVEL_VERY_EXPENSIVE"), 4);
  assert.equal(priceLevelToInt("PRICE_LEVEL_UNSPECIFIED"), null);
  assert.equal(priceLevelToInt("toString"), null);
  assert.equal(priceLevelToInt(undefined), null);
});

test("priceRangeText", () => {
  const m = (units, currencyCode = "GBP") => ({ units, currencyCode });
  assert.equal(priceRangeText({ startPrice: m("10"), endPrice: m("20") }), "£10–20");
  assert.equal(priceRangeText({ startPrice: m("50") }), "£50+");
  assert.equal(priceRangeText({ endPrice: m("20") }), "Up to £20");
  assert.equal(priceRangeText({ startPrice: m("10", "USD"), endPrice: m("10", "USD") }), "$10");
  assert.equal(priceRangeText({}), null);
  assert.equal(priceRangeText(undefined), null);
});

// --- geometry + matching ---------------------------------------------------

test("haversineMeters", () => {
  assert.equal(Math.round(haversineMeters(EDINBURGH_CENTRE, EDINBURGH_CENTRE)), 0);
  // 0.001 degrees of latitude ~ 111 m
  const d = haversineMeters({ lat: 55.9533, lng: -3.1883 }, { lat: 55.9543, lng: -3.1883 });
  assert.ok(d > 105 && d < 117, String(d));
  // Edinburgh -> Glasgow is roughly 67 km
  const eg = haversineMeters(EDINBURGH_CENTRE, { lat: 55.8642, lng: -4.2518 });
  assert.ok(eg > 65000 && eg < 69000, String(eg));
});

const cand = (name, lat, lng) => ({ id: "g1", displayName: { text: name }, location: { latitude: lat, longitude: lng } });

test("namesMatch: key equality, whole-token prefix, but not a loose single token", () => {
  assert.ok(namesMatch("The Filmhouse", "Filmhouse Edinburgh"));
  assert.ok(namesMatch("Camera Obscura", "Camera Obscura & World of Illusions"));
  assert.ok(!namesMatch("Festival Theatre", "King's Theatre"));
  assert.ok(!namesMatch("Bar", "Bar Soba"));
  assert.ok(!namesMatch("Dishoom", "Dishoom Bar"));
  assert.ok(namesMatch("Dishoom", "Dishoom Bar", { haveCoords: true }));
  assert.ok(!namesMatch("", "Anything"));
});

test("acceptMatch: name + distance from stored coordinates", () => {
  const row = { name: "Bar 50", lat: 55.9533, lng: -3.1883 };
  assert.deepEqual(
    (({ ok }) => ({ ok }))(acceptMatch(row, cand("Bar 50", 55.9535, -3.1883))),
    { ok: true },
  );
  const far = acceptMatch(row, cand("Bar 50", 55.9573, -3.1883)); // ~445 m
  assert.equal(far.ok, false);
  assert.match(far.reason, /too far/);
  const wrongName = acceptMatch(row, cand("Bar 51", 55.9533, -3.1883));
  assert.equal(wrongName.ok, false);
  assert.match(wrongName.reason, /name mismatch/);
});

test("acceptMatch: address-only rows use 2 km from the city centre", () => {
  const row = { name: "Filmhouse", lat: null, lng: null, address: "88 Lothian Road" };
  assert.equal(acceptMatch(row, cand("Filmhouse", 55.9475, -3.2056)).ok, true);
  assert.equal(acceptMatch(row, cand("Filmhouse", 55.9, -3.4)).ok, false);
  assert.equal(acceptMatch(row, { displayName: { text: "Filmhouse" } }).ok, false);
});

// --- buildPlacePatch -------------------------------------------------------

const NOW = new Date("2026-10-07T12:00:00Z");
const fullDetails = {
  id: "ChIJabc",
  displayName: { text: "Bar 50" },
  formattedAddress: "50 George St, Edinburgh EH2 2LE, UK",
  location: { latitude: 55.9533, longitude: -3.1883 },
  regularOpeningHours: {
    periods: [p(1, 12, 0, 1, 23, 0), p(5, 18, 0, 6, 1, 0)],
    weekdayDescriptions: week("12:00 PM – 11:00 PM", "12:00 PM – 11:00 PM", "12:00 PM – 11:00 PM", "12:00 PM – 11:00 PM", "12:00 PM – 11:00 PM", "12:00 PM – 11:00 PM", "Closed"),
  },
  rating: 4.4,
  userRatingCount: 321,
  priceLevel: "PRICE_LEVEL_MODERATE",
  priceRange: { startPrice: { units: "10", currencyCode: "GBP" }, endPrice: { units: "20", currencyCode: "GBP" } },
  websiteUri: "https://bar50.example",
  nationalPhoneNumber: "0131 000 0000",
  businessStatus: "OPERATIONAL",
  googleMapsUri: "https://maps.google.com/?cid=1",
  reviewSummary: { text: { text: "Lively cocktail bar." }, disclosureText: { text: "Summarized with Gemini" } },
};

test("buildPlacePatch: blank row gets every fill; Google-owned fields always present", () => {
  const row = { id: "r1", name: "Bar 50", google_place_id: null, lat: null, lng: null, address: null, hours: null, opening_hours: null, price_level: null };
  const out = buildPlacePatch(row, fullDetails, NOW);
  assert.deepEqual(Object.keys(out.fills).sort(), ["address", "google_place_id", "hours", "lat", "lng", "opening_hours", "price_level"]);
  assert.equal(out.fills.google_place_id, "ChIJabc");
  assert.equal(out.fills.price_level, 2);
  assert.equal(out.fills.hours, "Mon–Sat 12:00–23:00, Sun closed");
  assert.equal(out.google.rating, 4.4);
  assert.equal(out.google.google_rating_count, 321);
  assert.equal(out.google.price_range, "£10–20");
  assert.equal(out.google.website, "https://bar50.example");
  assert.equal(out.google.phone, "0131 000 0000");
  assert.equal(out.google.google_maps_uri, "https://maps.google.com/?cid=1");
  assert.equal(out.google.business_status, "OPERATIONAL");
  assert.equal(out.google.google_summary, "Lively cocktail bar.");
  assert.equal(out.google.google_summary_disclosure, "Summarized with Gemini");
  assert.equal(out.google.google_fetched_at, "2026-10-07T12:00:00.000Z");
  for (const col of GOOGLE_OWNED_COLUMNS) assert.ok(col in out.google, col);
  assert.deepEqual(out.flags, []);
  assert.deepEqual(out.changes, []);
});

test("buildPlacePatch: existing values are never filled over; differences are listed as changes", () => {
  const row = {
    name: "Bar 50", google_place_id: "ChIJabc", lat: 55.9533, lng: -3.1883, address: "50 George Street", hours: "Open late",
    opening_hours: [{ day: 1, open: "10:00", close: "11:00" }], price_level: 3,
  };
  const out = buildPlacePatch(row, fullDetails, NOW);
  assert.deepEqual(out.fills, {});
  const fields = out.changes.map((c) => c.field).sort();
  assert.deepEqual(fields, ["hours", "price_level"]); // address is a substring-compatible match; coords agree
  assert.deepEqual(out.changes.find((c) => c.field === "price_level"), { field: "price_level", current: 3, google: 2 });
});

test("buildPlacePatch: summary precedence review > generative > editorial; editorial has no disclosure", () => {
  const row = { name: "x" };
  const gen = buildPlacePatch(row, { id: "a", generativeSummary: { overview: { text: "Gen" }, disclosureText: { text: "Gemini says" } }, editorialSummary: { text: "Ed" } }, NOW);
  assert.equal(gen.google.google_summary, "Gen");
  assert.equal(gen.google.google_summary_disclosure, "Gemini says");
  const ed = buildPlacePatch(row, { id: "a", editorialSummary: { text: "Ed" } }, NOW);
  assert.equal(ed.google.google_summary, "Ed");
  assert.equal(ed.google.google_summary_disclosure, null);
  const none = buildPlacePatch(row, { id: "a" }, NOW);
  assert.equal(none.google.google_summary, null);
  assert.equal(none.google.google_summary_disclosure, null);
  assert.ok(!("rating" in none.google)); // no Google rating: keep whatever the row has
});

test("buildPlacePatch: flags closed_permanently and moved (>250 m)", () => {
  const closed = buildPlacePatch({ name: "x" }, { ...fullDetails, businessStatus: "CLOSED_PERMANENTLY" }, NOW);
  assert.deepEqual(closed.flags, ["closed_permanently"]);
  const moved = buildPlacePatch({ name: "x", lat: 55.9433, lng: -3.1883 }, fullDetails, NOW); // ~1.1 km away
  assert.deepEqual(moved.flags, ["moved"]);
  const near = buildPlacePatch({ name: "x", lat: 55.9535, lng: -3.1883 }, fullDetails, NOW);
  assert.deepEqual(near.flags, []);
});

test("buildPlacePatch: does not overwrite google_place_id the row already has", () => {
  const out = buildPlacePatch({ name: "x", google_place_id: "old" }, fullDetails, NOW);
  assert.ok(!("google_place_id" in out.fills));
});

test("diffAgainstRow: a genuinely different address is listed; abbreviations are not", () => {
  const same = buildPlacePatch({ name: "x", address: "50 George Street, Edinburgh" }, fullDetails, NOW);
  assert.ok(!same.changes.some((c) => c.field === "address"));
  const other = buildPlacePatch({ name: "x", address: "12 Rose Street" }, fullDetails, NOW);
  assert.ok(other.changes.some((c) => c.field === "address"));
});

test("namesMatch: same words in another order", () => {
  assert.equal(namesMatch("Cafe Jacques", "Jacques Café"), true);
  assert.equal(namesMatch("Bar Brig", "Brig"), false);
  assert.equal(namesMatch("Bar Brig", "Victoria Bar"), false);
});
