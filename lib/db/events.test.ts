// Run: npx tsx --test lib/db/events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenVenue, isUnknownRelationship, isUnknownStatusColumn } from "./events";

test("isUnknownStatusColumn: only a missing events.status column triggers the retry", () => {
  assert.equal(isUnknownStatusColumn({ code: "42703", message: "column events.status does not exist" }), true);
  assert.equal(isUnknownStatusColumn({ code: "PGRST204", message: "Could not find the 'status' column of 'events' in the schema cache" }), true);
  assert.equal(isUnknownStatusColumn({ code: "42703", message: "column events.category does not exist" }), false);
  assert.equal(isUnknownStatusColumn({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assert.equal(isUnknownStatusColumn(null), false);
});

test("isUnknownRelationship: only a missing / ambiguous place embed triggers the retry", () => {
  assert.equal(isUnknownRelationship({ code: "PGRST200", message: "Could not find a relationship between 'events' and 'places' in the schema cache" }), true);
  assert.equal(isUnknownRelationship({ code: "PGRST201", message: "more than one relationship was found" }), true);
  assert.equal(isUnknownRelationship({ code: "42703", message: "column events.status does not exist" }), false);
  assert.equal(isUnknownRelationship(null), false);
});

test("flattenVenue: image falls back to the earliest place_photo; photos are dropped; null stays null", () => {
  assert.equal(flattenVenue(null), null);
  assert.equal(flattenVenue(undefined), null);
  const v = flattenVenue({ name: "V", image_url: null, place_photos: [{ url: "https://b", display_order: 2 }, { url: "https://a", display_order: 1 }] });
  assert.deepEqual(v, { name: "V", image_url: "https://a" });
  assert.equal(flattenVenue({ image_url: "https://own", place_photos: [{ url: "https://x", display_order: 0 }] })?.image_url, "https://own");
  assert.equal(flattenVenue([{ image_url: null, place_photos: [] }])?.image_url, null);
});
