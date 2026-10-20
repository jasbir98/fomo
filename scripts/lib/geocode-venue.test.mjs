import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePoi, fullPostcode, poiNameMatches } from "./geocode-venue.mjs";

test("fullPostcode finds a full UK postcode and normalises it", () => {
  assert.equal(fullPostcode("5 Queen Street, EH2 1JE"), "EH2 1JE");
  assert.equal(fullPostcode("36 Dalmeny Street, Edinburgh, eh6 8rg"), "EH6 8RG");
  assert.equal(fullPostcode("High Street Wellhead, Edinburgh EH1"), null);
  assert.equal(fullPostcode(null), null);
});

test("poiNameMatches accepts the same venue with descriptor words added", () => {
  assert.ok(poiNameMatches("Wu Asia Pacific", "WU Asia Pacific"));
  assert.ok(poiNameMatches("Rabble", "Rabble Taphouse and Grill"));
  assert.ok(poiNameMatches("Tamil Teru", "Tamil Teru - Indian Restaurant"));
  assert.ok(poiNameMatches("Maid of Forth", "Maid of the Forth"));
  assert.ok(poiNameMatches("The Amber Rose", "The Amber Rose Edinburgh"));
  assert.ok(poiNameMatches("Women Hidden in Plain Sight", "WHIPS: Women Hidden in Plain Sight"));
});

test("poiNameMatches rejects a different place that shares a word", () => {
  assert.ok(!poiNameMatches("The Court", "Court of Session"));
  assert.ok(!poiNameMatches("The Court", "The Supreme Courts"));
  assert.ok(!poiNameMatches("Student Union", "Student Union Shop"));
  assert.ok(!poiNameMatches("Student Union", "Heriot-Watt University Student Union"));
  assert.ok(!poiNameMatches("Mercat Tours", "The Mercat"));
  assert.ok(!poiNameMatches("Pho", "Pho"));
});

test("choosePoi keeps in-area matches and flags far-apart branches", () => {
  const found = choosePoi("Rabble", [
    { name: "Rabble Taphouse and Grill", lat: 55.95396, lng: -3.20082 },
    { name: "Rabble", lat: 55.8642, lng: -4.2518 }, // Glasgow: outside the bbox
  ]);
  assert.equal(found.status, "found");
  assert.equal(found.lat, 55.95396);

  const chain = choosePoi("Civerinos", [
    { name: "Civerinos", lat: 55.9496, lng: -3.1883 },
    { name: "Civerinos", lat: 55.9433, lng: -3.2004 },
  ]);
  assert.equal(chain.status, "ambiguous");

  assert.equal(choosePoi("The Court", [{ name: "Court of Session", lat: 55.949, lng: -3.19 }]).status, "none");
});
