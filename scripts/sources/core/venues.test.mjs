import { test } from "node:test";
import assert from "node:assert/strict";
import { linkVenues, resolveVenue } from "./venues.mjs";
import { buildPlaceIndex } from "../../lib/place-match.mjs";

const place = (id, name, extra = {}) => ({ id, name, image_url: null, lat: null, lng: null, ...extra });

// Real-ish Edinburgh coordinates.
const USHER = { lat: 55.9474, lng: -3.2048 };
const NEAR_USHER = { lat: 55.9477, lng: -3.2046 }; // ~35 m
const FAR = { lat: 55.9533, lng: -3.1883 }; // city centre, ~1.2 km

const places = [
  place("usher", "Usher Hall", USHER),
  place("hub-edin", "The Hub", { lat: 55.9496, lng: -3.1957 }),
  place("hub-leith", "The Hub", { lat: 55.9755, lng: -3.1722 }),
  place("nocoord", "Sneaky Pete's"),
  place("dup1", "Voodoo Rooms"),
  place("dup2", "Voodoo Rooms", { image_url: "https://x/y.jpg" }),
  place("liquid-a", "Liquid Room"),
  place("liquid-b", "Liquid Room Annexe"),
];

const row = (venue, extra = {}) => ({ venue_name: venue, ...extra });

test("exact name + within 400 m links", () => {
  const rows = [row("Usher Hall", NEAR_USHER)];
  const r = linkVenues(rows, places);
  assert.equal(rows[0].place_id, "usher");
  assert.equal(r.stats.linked, 1);
});

test("same name but > 400 m away is a different venue: unlinked (too far)", () => {
  const rows = [row("Usher Hall", FAR)];
  const r = linkVenues(rows, places);
  assert.equal(rows[0].place_id, undefined);
  assert.equal(r.stats.unlinked, 1);
  assert.equal(r.stats.tooFar, 1);
  assert.equal(r.unlinked[0].name, "Usher Hall");
});

test("row without coordinates links on a unique name match", () => {
  const rows = [row("Sneaky Pete's")];
  linkVenues(rows, places);
  assert.equal(rows[0].place_id, "nocoord");
});

test("row without coordinates: a photo-broken duplicate tie is NOT accepted", () => {
  const rows = [row("Voodoo Rooms")];
  const r = linkVenues(rows, places);
  assert.equal(rows[0].place_id, undefined);
  assert.equal(r.stats.ambiguous, 1);
  assert.equal(r.ambiguous[0].venue, "Voodoo Rooms");
});

test("two same-named places: coordinates pick the one within range", () => {
  const rows = [row("The Hub", { lat: 55.9497, lng: -3.1958 })];
  linkVenues(rows, places);
  assert.equal(rows[0].place_id, "hub-edin");
});

test("two same-named places and no coordinates stays ambiguous", () => {
  const rows = [row("The Hub")];
  const r = linkVenues(rows, places);
  assert.equal(rows[0].place_id, undefined);
  assert.equal(r.stats.ambiguous, 1);
  assert.deepEqual(r.ambiguous[0].candidates, ["The Hub"]);
});

test("partial (whole-token prefix) match is distance-checked too", () => {
  const rows = [row("Usher Hall Edinburgh Extra Words Here Now", NEAR_USHER)];
  linkVenues(rows, places);
  assert.equal(rows[0].place_id, undefined); // too many extra tokens
  const rows2 = [row("Usher Hall Main Auditorium", NEAR_USHER)];
  linkVenues(rows2, places);
  assert.equal(rows2[0].place_id, "usher");
});

test("existing place_id is never replaced; missing venue name counted", () => {
  const rows = [row("Usher Hall", { ...NEAR_USHER, place_id: "keep" }), { venue_name: null }, { venue_name: "  " }];
  const r = linkVenues(rows, places);
  assert.equal(rows[0].place_id, "keep");
  assert.equal(r.stats.alreadyLinked, 1);
  assert.equal(r.stats.noVenue, 2);
});

test("unlinked venues are grouped by normalised name with coordinates and sorted by row count", () => {
  const rows = [
    row("The Caves", { lat: 55.949, lng: -3.19, address: "8 Niddry St" }),
    row("Caves", { lat: 55.949, lng: -3.19 }),
    row("Bannerman's Bar"),
    row("The Caves"),
  ];
  const r = linkVenues(rows, places);
  assert.equal(r.unlinked.length, 2);
  assert.equal(r.unlinked[0].rows.length, 3);
  assert.equal(r.unlinked[0].lat, 55.949);
  assert.equal(r.unlinked[0].address, "8 Niddry St");
  assert.equal(r.unlinked[1].name, "Bannerman's Bar");
});

test("resolveVenue returns the matched place object", () => {
  const index = buildPlaceIndex(places);
  const r = resolveVenue(index, "Usher Hall", NEAR_USHER);
  assert.equal(r.status, "linked");
  assert.equal(r.place.id, "usher");
});
