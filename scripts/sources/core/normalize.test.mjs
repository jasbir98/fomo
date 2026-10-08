import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCategory, dedupeWithinSource, haversineKm, isEdinburghRow, isOffWedge } from "./normalize.mjs";

test("isEdinburghRow: within 15km of the centre by coordinates", () => {
  assert.equal(isEdinburghRow({ lat: 55.9486, lng: -3.1999 }), true); // the castle
  assert.equal(isEdinburghRow({ lat: 55.8642, lng: -4.2518, city: "Glasgow" }), false);
});

test("isEdinburghRow: locality keyword fallback when coordinates are missing or far", () => {
  assert.equal(isEdinburghRow({ city: "Leith", address: null }), true);
  assert.equal(isEdinburghRow({ city: null, address: "12 Dalry Road" }), true);
  assert.equal(isEdinburghRow({ city: "London", address: "1 High St" }), false);
  assert.equal(isEdinburghRow({}), false);
  // Far coordinates but an Edinburgh address still passes (keyword check is independent).
  assert.equal(isEdinburghRow({ lat: 51.5, lng: -0.12, address: "Edinburgh Road, London" }), true);
});

test("haversineKm: Edinburgh -> Glasgow is roughly 67km", () => {
  const d = haversineKm({ lat: 55.9533, lng: -3.1883 }, { lat: 55.8642, lng: -4.2518 });
  assert.ok(d > 60 && d < 75, `got ${d}`);
});

test("isOffWedge: excursion keywords", () => {
  assert.equal(isOffWedge({ name: "Isle of Skye Weekend Trip", description: "" }), true);
  assert.equal(isOffWedge({ name: "Day trip to Loch Ness", description: null }), true);
  assert.equal(isOffWedge({ name: "Friday Club Night", description: "Cheap pints" }), false);
});

test("isOffWedge: long + pricey span only", () => {
  const base = { name: "Festival pass", description: "", starts_at: "2026-10-10T10:00:00Z" };
  assert.equal(isOffWedge({ ...base, ends_at: "2026-10-14T10:00:00Z", price_from: 120 }), true);
  assert.equal(isOffWedge({ ...base, ends_at: "2026-10-14T10:00:00Z", price_from: 40 }), false);
  assert.equal(isOffWedge({ ...base, ends_at: "2026-10-11T10:00:00Z", price_from: 120 }), false);
  assert.equal(isOffWedge({ ...base, ends_at: null, price_from: 120 }), false);
});

test("classifyCategory: keeps a confident category, keywords fill 'other', first rule wins", () => {
  assert.equal(classifyCategory({ category: "music", name: "Stand-up night" }), "music");
  assert.equal(classifyCategory({ category: "other", name: "Stand-up Comedy Night" }), "comedy");
  assert.equal(classifyCategory({ category: "other", name: "Techno night at Cabaret" }), "nightlife");
  assert.equal(classifyCategory({ category: "other", name: "Mystery thing" }), "other");
});

test("dedupeWithinSource: first occurrence of a provider_event_id wins", () => {
  const out = dedupeWithinSource([
    { provider_event_id: "a", name: "first" },
    { provider_event_id: "b", name: "b" },
    { provider_event_id: "a", name: "second" },
  ]);
  assert.deepEqual(out.map((r) => r.name), ["first", "b"]);
});
