import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlaceIndex, matchHappening, matchVenueName, nameKey } from "./place-match.mjs";

const place = (id, name, image = "https://upload.wikimedia.org/x.jpg", extra = {}) => ({ id, name, image_url: image, ...extra });

const index = buildPlaceIndex([
  place("castle", "Edinburgh Castle"),
  place("filmhouse", "Filmhouse"),
  place("festival", "Festival Theatre"),
  place("kings", "King's Theatre"),
  place("traverse", "Traverse Theatre"),
  place("camera", "Camera Obscura"),
  place("brewdog", "BrewDog Doghouse"),
  place("empty", "   "),
]);

test("nameKey: case, diacritics, punctuation, '&'/'and', city suffix; theatre is kept", () => {
  assert.equal(nameKey("Café  Royal"), "cafe royal");
  assert.equal(nameKey("The Filmhouse Edinburgh"), "filmhouse");
  assert.equal(nameKey("Camera Obscura & World of Illusions"), nameKey("Camera Obscura and World of Illusions"));
  assert.equal(nameKey("King's Theatre"), "kings theatre");
  assert.equal(nameKey("Festival Theatre Edinburgh"), "festival theatre");
});

test("exact match", () => {
  const r = matchVenueName(index, "Traverse Theatre");
  assert.equal(r.status, "linked");
  assert.equal(r.place.id, "traverse");
  assert.equal(r.tier, "exact");
  assert.equal(matchVenueName(index, "Edinburgh Castle").place.id, "castle");
});

test("'Filmhouse' and 'Filmhouse Edinburgh' both resolve to the Filmhouse place", () => {
  assert.equal(matchVenueName(index, "Filmhouse").place.id, "filmhouse");
  assert.equal(matchVenueName(index, "Filmhouse Edinburgh").place.id, "filmhouse");
  const withSuffix = buildPlaceIndex([place("f", "Filmhouse Edinburgh")]);
  assert.equal(matchVenueName(withSuffix, "Filmhouse").place.id, "f");
});

test("'Festival Theatre Edinburgh' links to Festival Theatre, never King's Theatre", () => {
  const r = matchVenueName(index, "Festival Theatre Edinburgh");
  assert.equal(r.status, "linked");
  assert.equal(r.place.id, "festival");
  assert.equal(matchVenueName(index, "King's Theatre").place.id, "kings");
  // "Theatre" alone is a single token: no partial match onto either theatre.
  assert.equal(matchVenueName(index, "Theatre").status, "none");
});

test("'Camera Obscura & World of Illusions' links to Camera Obscura (partial, unique)", () => {
  const r = matchVenueName(index, "Camera Obscura & World of Illusions");
  assert.equal(r.status, "linked");
  assert.equal(r.place.id, "camera");
  assert.equal(r.tier, "partial");
});

test("ambiguous -> no link: two places share the best match and neither is a tie-break", () => {
  const dup = buildPlaceIndex([place("a", "Usher Hall"), place("b", "Usher Hall")]);
  const r = matchVenueName(dup, "Usher Hall");
  assert.equal(r.status, "ambiguous");
  assert.equal(r.candidates.length, 2);

  // Different keys at the partial tier: ambiguous, not a guess.
  const two = buildPlaceIndex([place("a", "Royal Mile Tavern"), place("b", "Royal Mile Gallery")]);
  const r2 = matchVenueName(two, "Royal Mile");
  assert.equal(r2.status, "ambiguous");
  assert.equal(r2.tier, "partial");
  const three = buildPlaceIndex([place("a", "Royal Mile Tavern"), place("b", "Royal Mile Tavern Bar")]);
  assert.equal(matchVenueName(three, "Royal Mile Tavern").place.id, "a"); // exact wins over partial
});

test("exact tie between true duplicates prefers the one with a photo", () => {
  const dup = buildPlaceIndex([place("bare", "Usher Hall", null), place("photo", "Usher Hall")]);
  const r = matchVenueName(dup, "Usher Hall");
  assert.equal(r.status, "linked");
  assert.equal(r.place.id, "photo");
  assert.equal(r.tieBroken, true);
});

test("a place whose only photo is in place_photos counts as having an image", () => {
  const dup = buildPlaceIndex([
    place("bare", "Usher Hall", null),
    place("photo", "Usher Hall", null, { place_photos: [{ url: "https://x/y.jpg", display_order: 0 }] }),
  ]);
  assert.equal(matchVenueName(dup, "Usher Hall").place.id, "photo");
});

test("coordinates veto a same-named place that is far away", () => {
  const far = buildPlaceIndex([place("glasgow", "Filmhouse", "https://x/y.jpg", { lat: 55.86, lng: -4.25 })]);
  assert.equal(matchVenueName(far, "Filmhouse", { lat: 55.946, lng: -3.2 }).status, "none");
  assert.equal(matchVenueName(far, "Filmhouse", {}).status, "linked");
});

test("matchHappening: venue_name first, title run only without a venue_name", () => {
  const byVenue = matchHappening(index, { title: "SCO £6 tickets", venue_name: "Festival Theatre Edinburgh", scope: "city" });
  assert.equal(byVenue.status, "linked");
  assert.equal(byVenue.via, "venue_name");

  const byTitle = matchHappening(index, { title: "Traverse Theatre £1 Tickets", venue_name: null, scope: "city" });
  assert.equal(byTitle.status, "linked");
  assert.equal(byTitle.via, "title");
  assert.equal(byTitle.place.id, "traverse");

  const castle = matchHappening(index, { title: "Edinburgh Castle £1 Young Scot Entry", venue_name: null, scope: "city" });
  assert.equal(castle.place.id, "castle");
});

test("matchHappening: a title never links on a vague or partial lead word; national scope never links", () => {
  assert.equal(matchHappening(index, { title: "Free Entry Sundays", venue_name: null, scope: "city" }).status, "none");
  assert.equal(matchHappening(index, { title: "Festival £6 Tickets", venue_name: null, scope: "city" }).status, "none");
  assert.equal(matchHappening(index, { title: "Filmhouse", venue_name: "Filmhouse", scope: "national" }).status, "none");
  assert.equal(matchHappening(index, { title: "Mystery Deal", venue_name: "Unknown Venue", scope: "city" }).status, "none");
});
