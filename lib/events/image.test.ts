// Run: npx tsx --test lib/events/image.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventCategoryToHappening, eventDefaultImage, eventImageFor, eventRealImage } from "./image";

const base = { name: "Some Gig", venue_name: "Somewhere", category: "music" as string | null, image_url: null as string | null, place: null };

test("event image wins, then the venue's photo, then the category tile", () => {
  assert.equal(eventImageFor({ ...base, image_url: "https://e/own.jpg", place: { image_url: "https://p/venue.jpg" } }), "https://e/own.jpg");
  assert.equal(eventImageFor({ ...base, place: { image_url: "https://p/venue.jpg" } }), "https://p/venue.jpg");
  assert.equal(eventImageFor({ ...base, place: { image_url: null } }), "/defaults/happenings/music.webp");
  assert.equal(eventImageFor(base), "/defaults/happenings/music.webp");
});

test("every event category slug has its own tile (not the neutral one)", () => {
  for (const c of ["music", "nightlife", "festival", "arts", "comedy", "sports", "food", "family"]) {
    assert.equal(eventDefaultImage({ name: "Plain title", venue_name: null, category: c }), `/defaults/happenings/${c}.webp`, c);
  }
  assert.equal(eventDefaultImage({ name: "Plain title", venue_name: null, category: "other" }), "/defaults/happenings/other.webp");
});

test("unknown or missing category falls back to the neutral tile; keyword themes still win", () => {
  assert.equal(eventCategoryToHappening("nonsense"), undefined);
  assert.equal(eventCategoryToHappening("toString"), undefined);
  assert.equal(eventDefaultImage({ name: "Plain", venue_name: null, category: null }), "/defaults/happenings/other.webp");
  assert.equal(eventDefaultImage({ name: "Edinburgh Castle Tour", venue_name: null, category: "family" }), "/defaults/themes/castle.webp");
});

test("eventRealImage is null without a real photo", () => {
  assert.equal(eventRealImage({ image_url: null, place: null }), null);
  assert.equal(eventRealImage({ image_url: null, place: { image_url: "https://p/v.jpg" } }), "https://p/v.jpg");
});
