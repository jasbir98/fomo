import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_PRIORITY,
  crossSourceKey,
  dedupeAcrossSources,
  isBetterRow,
  normalizeEventTitle,
  normalizeVenueKey,
} from "./dedupe.mjs";

const row = (over = {}) => ({
  provider: "luma",
  provider_event_id: "x",
  name: "Walter Trout",
  venue_name: "The Queen's Hall",
  starts_at: "2026-10-10T18:00:00.000Z", // 19:00 BST
  price_from: null,
  image_url: null,
  ticket_url: null,
  ...over,
});

test("normalizeEventTitle: strips venue qualifiers and folds accents", () => {
  assert.equal(normalizeEventTitle("Walter Trout // Edinburgh Queens Hall"), "walter trout");
  assert.equal(normalizeEventTitle("Walter Trout @ Queen's Hall"), "walter trout");
  assert.equal(normalizeEventTitle("Walter Trout - Edinburgh"), "walter trout");
  assert.equal(normalizeEventTitle("Walter Trout (Edinburgh)"), "walter trout");
  assert.equal(normalizeEventTitle("Angèle"), "angele");
  assert.equal(normalizeEventTitle("Walter Trout at The Queen's Hall", "The Queen's Hall"), "walter trout");
});

test("normalizeVenueKey: drops stopwords, '?' for no venue", () => {
  assert.equal(normalizeVenueKey("The Queen's Hall"), normalizeVenueKey("Queen's Hall, Edinburgh"));
  assert.notEqual(normalizeVenueKey("Edinburgh Playhouse"), normalizeVenueKey("Sheffield City Hall"));
  assert.equal(normalizeVenueKey(""), "?");
  assert.equal(normalizeVenueKey(null), "?");
});

test("crossSourceKey: same event across sources collides, different showtime/venue does not", () => {
  const a = crossSourceKey(row());
  assert.equal(crossSourceKey(row({ name: "Walter Trout // Edinburgh Queens Hall", venue_name: "Queen's Hall, Edinburgh", starts_at: "2026-10-10T18:30:00.000Z" })), a);
  // Matinee vs evening (different 3h bucket)
  assert.notEqual(crossSourceKey(row({ starts_at: "2026-10-10T12:30:00.000Z" })), a);
  // Same title/date, different city venue
  assert.notEqual(crossSourceKey(row({ venue_name: "Sheffield City Hall" })), a);
  // Late-night local gig keys on the London calendar date, not the UTC one
  assert.ok(crossSourceKey(row({ starts_at: "2026-10-10T22:30:00.000Z" })).includes("|2026-10-10|"));
  assert.ok(crossSourceKey(row({ starts_at: "2026-10-10T23:30:00.000Z" })).includes("|2026-10-11|"));
});

test("PROVIDER_PRIORITY: sneakypetes is explicit at 1", () => {
  assert.equal(PROVIDER_PRIORITY.sneakypetes, 1);
  assert.equal(PROVIDER_PRIORITY.allevents, 0);
});

test("isBetterRow: price > image > provider priority > ticket url", () => {
  assert.equal(isBetterRow(row({ price_from: 5 }), row({ provider: "ticketmaster" })), true);
  assert.equal(isBetterRow(row({ image_url: "https://i" }), row({ provider: "ticketmaster" })), true);
  assert.equal(isBetterRow(row({ provider: "skiddle" }), row({ provider: "luma" })), true);
  assert.equal(isBetterRow(row({ provider: "sneakypetes" }), row({ provider: "allevents" })), true);
  assert.equal(isBetterRow(row({ ticket_url: "https://t" }), row()), true);
  assert.equal(isBetterRow(row(), row()), false);
});

test("dedupeAcrossSources: collapses duplicates keeping the better row, logs the collapse", () => {
  const luma = row({ provider: "luma", provider_event_id: "l1" });
  const skiddle = row({ provider: "skiddle", provider_event_id: "s1", name: "Walter Trout // Edinburgh", price_from: 25 });
  const other = row({ provider: "luma", provider_event_id: "l2", name: "Different Gig" });
  const { rows, collapses } = dedupeAcrossSources([luma, skiddle, other]);
  assert.deepEqual(rows.map((r) => r.provider_event_id).sort(), ["l2", "s1"]);
  assert.equal(collapses.length, 1);
  assert.equal(collapses[0].kept.provider, "skiddle");
  assert.equal(collapses[0].dropped.provider, "luma");
});

test("dedupeAcrossSources: equal rows keep whichever was seen first", () => {
  const first = row({ provider_event_id: "first" });
  const second = row({ provider_event_id: "second" });
  const { rows } = dedupeAcrossSources([first, second]);
  assert.deepEqual(rows.map((r) => r.provider_event_id), ["first"]);
});
