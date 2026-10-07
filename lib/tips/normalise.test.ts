import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTipDetails, normaliseTipLink, placeMapsUrl } from "@/lib/tips/normalise";

test("a full https URL is kept as is", () => {
  assert.deepEqual(normaliseTipLink("https://www.thestand.co.uk/events"), {
    url: "https://www.thestand.co.uk/events",
    leftover: null,
  });
});

test("a bare www domain gets https://", () => {
  assert.deepEqual(normaliseTipLink("www.thestand.co.uk"), { url: "https://www.thestand.co.uk", leftover: null });
});

test("a domain with a path gets https://", () => {
  assert.deepEqual(normaliseTipLink("  instagram.com/venue "), { url: "https://instagram.com/venue", leftover: null });
});

test("free text becomes leftover, not a url", () => {
  assert.deepEqual(normaliseTipLink("@venue on Instagram"), { url: null, leftover: "@venue on Instagram" });
  assert.deepEqual(normaliseTipLink("@venue"), { url: null, leftover: "@venue" });
  assert.deepEqual(normaliseTipLink("see their site. it's good"), { url: null, leftover: "see their site. it's good" });
});

test("non-http schemes are not stored as a url", () => {
  assert.deepEqual(normaliseTipLink("javascript://x.com/%0Aalert(1)"), {
    url: null,
    leftover: "javascript://x.com/%0Aalert(1)",
  });
});

test("empty or missing link gives nulls", () => {
  assert.deepEqual(normaliseTipLink(""), { url: null, leftover: null });
  assert.deepEqual(normaliseTipLink("   "), { url: null, leftover: null });
  assert.deepEqual(normaliseTipLink(undefined), { url: null, leftover: null });
});

test("details combine location, leftover link and user text", () => {
  assert.equal(
    buildTipDetails({ location: "The Stand, York Place", leftoverLink: "@venue on Instagram", details: "Free for students" }),
    "Where: The Stand, York Place\nLink: @venue on Instagram\n\nFree for students",
  );
});

test("details with only some parts", () => {
  assert.equal(buildTipDetails({ location: "Leith" }), "Where: Leith");
  assert.equal(buildTipDetails({ leftoverLink: "@venue" }), "Link: @venue");
  assert.equal(buildTipDetails({ details: "  just this  " }), "just this");
  assert.equal(buildTipDetails({ location: "Leith", details: "More" }), "Where: Leith\n\nMore");
});

test("details are null when nothing is given", () => {
  assert.equal(buildTipDetails({}), null);
  assert.equal(buildTipDetails({ location: " ", leftoverLink: null, details: "" }), null);
});

test("combined details are capped", () => {
  const out = buildTipDetails({ location: "Leith", details: "x".repeat(5000), maxLength: 100 });
  assert.equal(out?.length, 100);
  assert.ok(out?.startsWith("Where: Leith\n\nxxx"));
  assert.equal(buildTipDetails({ details: "y".repeat(5000) })?.length, 2000);
});

test("a picked Google place adds a Maps link to the Where line", () => {
  assert.equal(
    buildTipDetails({ location: "The Stand Comedy Club, York Place", placeId: "ChIJ0Wf2y4fHh0gRexample" }),
    "Where: The Stand Comedy Club, York Place (https://www.google.com/maps/place/?q=place_id:ChIJ0Wf2y4fHh0gRexample)"
  );
  assert.equal(buildTipDetails({ location: "Leith", placeId: "not a place id!" }), "Where: Leith");
  assert.equal(placeMapsUrl("x"), null);
  assert.equal(placeMapsUrl(null), null);
});
