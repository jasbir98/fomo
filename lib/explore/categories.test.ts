import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPLORE_CATEGORY_SLUGS, matchesEvent, matchesHappening, matchesPlace, parseExploreCategories } from "./categories";

test("kids is a known slug", () => {
  assert.ok(EXPLORE_CATEGORY_SLUGS.includes("kids"));
  assert.deepEqual(parseExploreCategories("kids,cafes,bogus"), ["kids", "cafes"]);
});

test("places: kids matches on family_fit, never on the category text", () => {
  assert.equal(matchesPlace({ category: "park", family_fit: "all_ages" }, "kids"), true);
  assert.equal(matchesPlace({ category: "soft play", family_fit: "kids" }, "kids"), true);
  assert.equal(matchesPlace({ category: "park", family_fit: null }, "kids"), false);
  assert.equal(matchesPlace({ category: "park" }, "kids"), false);
  // Other slugs are untouched.
  assert.equal(matchesPlace({ category: "park", family_fit: null }, "parks_views"), true);
  assert.equal(matchesPlace({ category: "park", family_fit: "kids" }, "cafes"), false);
});

test("happenings: kids matches family_fit, category family and family-only offers", () => {
  assert.equal(matchesHappening({ category: "music", eligibility: "anyone", family_fit: "kids" }, "kids"), true);
  assert.equal(matchesHappening({ category: "family", eligibility: "anyone" }, "kids"), true);
  assert.equal(matchesHappening({ category: "food", eligibility: "family" }, "kids"), true);
  assert.equal(matchesHappening({ category: "music", eligibility: "anyone" }, "kids"), false);
  assert.equal(matchesHappening({ category: "museum", eligibility: "anyone" }, "museums_galleries"), true);
});

test("provider events: only kids narrows them", () => {
  assert.equal(matchesEvent({ category: "music", family_fit: "kids" }, "kids"), true);
  assert.equal(matchesEvent({ category: "family" }, "kids"), true);
  assert.equal(matchesEvent({ category: "music", family_fit: null }, "kids"), false);
  assert.equal(matchesEvent({ category: "music" }, "nightlife"), true);
});
