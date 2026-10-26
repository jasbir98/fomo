import { test } from "node:test";
import assert from "node:assert/strict";
import { isJunkTitle, isOnlineOnly, isSelfGuidedProduct, validateRow, validateRows } from "./validate.mjs";

const NOW = new Date("2026-10-08T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(NOW.getTime() + n * DAY).toISOString();

function row(overrides = {}) {
  return {
    provider: "skiddle",
    provider_event_id: "1",
    name: "Cool Gig",
    starts_at: inDays(3),
    ends_at: null,
    venue_name: "The Liquid Room",
    address: "9c Victoria St, Edinburgh",
    city: "Edinburgh",
    lat: 55.9486,
    lng: -3.1925,
    ticket_url: "https://example.com/e/1",
    image_url: "https://example.com/i.jpg",
    ...overrides,
  };
}

test("a normal row passes and is returned as a copy", () => {
  const input = row();
  const r = validateRow(input, { now: NOW });
  assert.equal(r.ok, true);
  assert.notEqual(r.row, input);
  assert.equal(r.row.name, "Cool Gig");
});

test("missing_name / missing_start", () => {
  assert.equal(validateRow(row({ name: "   " }), { now: NOW }).reason, "missing_name");
  assert.equal(validateRow(row({ name: undefined }), { now: NOW }).reason, "missing_name");
  assert.equal(validateRow(row({ starts_at: null }), { now: NOW }).reason, "missing_start");
  assert.equal(validateRow(row({ starts_at: "nonsense" }), { now: NOW }).reason, "missing_start");
});

test("past: ended or started-with-no-end earlier than now", () => {
  assert.equal(validateRow(row({ starts_at: inDays(-1) }), { now: NOW }).reason, "past");
  // Started yesterday but still running until tomorrow: kept.
  assert.equal(validateRow(row({ starts_at: inDays(-1), ends_at: inDays(1) }), { now: NOW }).ok, true);
});

test("beyond_window: more than LOOKAHEAD_DAYS (90) out", () => {
  assert.equal(validateRow(row({ starts_at: inDays(91) }), { now: NOW }).reason, "beyond_window");
  assert.equal(validateRow(row({ starts_at: inDays(30) }), { now: NOW }).ok, true);
});

test("end_before_start", () => {
  const r = validateRow(row({ starts_at: inDays(5), ends_at: inDays(4) }), { now: NOW });
  assert.equal(r.reason, "end_before_start");
});

test("unparseable ends_at is nulled, not rejected", () => {
  const r = validateRow(row({ ends_at: "garbage" }), { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.row.ends_at, null);
});

test("not_edinburgh: far coordinates and no locality keyword", () => {
  const glasgow = row({ lat: 55.8642, lng: -4.2518, city: "Glasgow", address: "1 Argyle St, Glasgow" });
  assert.equal(validateRow(glasgow, { now: NOW }).reason, "not_edinburgh");
  const noLoc = row({ lat: null, lng: null, city: null, address: null });
  assert.equal(validateRow(noLoc, { now: NOW }).reason, "not_edinburgh");
  const byLocality = row({ lat: null, lng: null, city: "Leith", address: null });
  assert.equal(validateRow(byLocality, { now: NOW }).ok, true);
});

test("not_edinburgh: a row with no location data passes only if the title names Edinburgh", () => {
  const blank = { lat: null, lng: null, city: null, address: null, venue_name: null };
  assert.equal(validateRow(row({ ...blank, name: "AI Breakfast Club: Edinburgh" }), { now: NOW }).ok, true);
  assert.equal(validateRow(row({ ...blank, name: "AI Breakfast Club" }), { now: NOW }).reason, "not_edinburgh");
  // Real location data is never overridden by the title.
  assert.equal(validateRow(row({ lat: null, lng: null, city: "Glasgow", address: "1 St", venue_name: "X", name: "Edinburgh Night" }), { now: NOW }).reason, "not_edinburgh");
});

test("online_only: JSON-LD flag, venue/address words, title tag without coordinates", () => {
  assert.equal(validateRow(row({ _online: true }), { now: NOW }).reason, "online_only");
  assert.equal(validateRow(row({ venue_name: "Online via Zoom" }), { now: NOW }).reason, "online_only");
  assert.equal(validateRow(row({ address: "Virtual event, Edinburgh" }), { now: NOW }).reason, "online_only");
  assert.equal(isOnlineOnly(row({ lat: null, lng: null, name: "[Online] Pub Quiz" })), true);
  // A physical venue with coordinates is not condemned by its title alone.
  assert.equal(isOnlineOnly(row({ name: "Online Poker Night" })), false);
  assert.equal(validateRow(row({ venue_name: "Virgin Records" }), { now: NOW }).ok, true);
});

test("self_guided: audio/GPS/app tours are products, not events", () => {
  for (const name of [
    "Edinburgh Audio Tour: Echoes of Intrigue",
    "Edinburgh Highlights Audio Tour: Iconic Landmarks",
    "Glasgow Audio Tour: An Odyssey Through History and Culture",
    "Old Town Self-Guided Walking Trail",
    "GPS Treasure Hunt: Royal Mile",
    "Edinburgh Outdoor Escape Game",
    "Smartphone Tour of Leith",
  ]) {
    assert.equal(validateRow(row({ name }), { now: NOW }).reason, "self_guided", name);
  }
  for (const name of ["Ghost Tour of the Old Town", "Walking Tour with a Guide", "Audiobook Club", "The Tour (Live)"]) {
    assert.equal(isSelfGuidedProduct({ name }), false, name);
  }
});

test("not_edinburgh: coordinates outvote an Edinburgh city field", () => {
  const inverness = row({ lat: 57.4778, lng: -4.2247, city: "Edinburgh", address: "Bishop's Road, Inverness" });
  assert.equal(validateRow(inverness, { now: NOW }).reason, "not_edinburgh");
});

test("bad_url: bad ticket_url rejects, bad image_url is dropped", () => {
  assert.equal(validateRow(row({ ticket_url: "javascript:alert(1)" }), { now: NOW }).reason, "bad_url");
  assert.equal(validateRow(row({ ticket_url: "ftp://x/y" }), { now: NOW }).reason, "bad_url");
  assert.equal(validateRow(row({ ticket_url: null }), { now: NOW }).ok, true);
  const r = validateRow(row({ image_url: "data:image/png;base64,AAA" }), { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.row.image_url, null);
});

test("junk_title cases", () => {
  assert.equal(isJunkTitle("", null), true);
  assert.equal(isJunkTitle("!!! ???", null), true);
  assert.equal(isJunkTitle("-", null), true);
  assert.equal(isJunkTitle("7", null), true); // a single character
  // Digits-only titles of 2+ characters are legitimate (the play "1984").
  assert.equal(isJunkTitle("1984", null), false);
  assert.equal(isJunkTitle("!!! 2026 ???", null), false);
  assert.equal(isJunkTitle("42", null), false);
  assert.equal(validateRow(row({ name: "1984", venue_name: "Royal Lyceum Theatre" }), { now: NOW }).ok, true);
  // Non-latin titles are not "empty".
  assert.equal(isJunkTitle("爱丁堡之夜", null), false);
  assert.equal(isJunkTitle("TEST EVENT do not buy", null), true);
  assert.equal(isJunkTitle("The Liquid Room", "The Liquid Room"), true);
  assert.equal(isJunkTitle("Liquid Room!", "The Liquid Room"), false); // not identical once folded ("the" stays)
  assert.equal(isJunkTitle("Cool Gig", "The Liquid Room"), false);
  assert.equal(isJunkTitle("Contest Eventually", null), false);
});

test("soft fixes: entities decoded, whitespace collapsed, transient flag stripped", () => {
  const r = validateRow(row({ name: "  Rock &amp;  Roll   Night &#8211; Live ", venue_name: "Sneaky Pete&#39;s" }), { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.row.name, "Rock & Roll Night – Live");
  assert.equal(r.row.venue_name, "Sneaky Pete's");
  assert.equal("_online" in r.row, false);
});

test("validateRows: counts rejections by reason and keeps samples", () => {
  const { kept, rejected, samples } = validateRows(
    [row(), row({ starts_at: inDays(100) }), row({ starts_at: inDays(101), name: "Other" }), row({ name: "" })],
    { now: NOW }
  );
  assert.equal(kept.length, 1);
  assert.deepEqual(rejected, { beyond_window: 2, missing_name: 1 });
  assert.equal(samples.beyond_window.length, 2);
});
