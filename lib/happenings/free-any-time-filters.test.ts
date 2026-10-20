import { test } from "node:test";
import assert from "node:assert/strict";
import type { FreeAnyTimeItem } from "./feed-types";
import { hasKidFriendly, matchesFreeAnyTimeFilters } from "./free-any-time-filters";

function item(familyFit?: FreeAnyTimeItem["familyFit"]): FreeAnyTimeItem {
  return {
    kind: "place",
    id: "p1",
    title: "Somewhere",
    category: "outdoors",
    district: "Leith",
    typeLabel: "Park",
    familyFit,
  } as unknown as FreeAnyTimeItem;
}

test("withKids keeps only items with a family fit", () => {
  assert.equal(matchesFreeAnyTimeFilters(item("kids"), null, null, true), true);
  assert.equal(matchesFreeAnyTimeFilters(item("all_ages"), null, null, true), true);
  assert.equal(matchesFreeAnyTimeFilters(item(null), null, null, true), false);
  assert.equal(matchesFreeAnyTimeFilters(item(undefined), null, null, true), false);
});

test("withKids off leaves every item in, and composes with type/district", () => {
  assert.equal(matchesFreeAnyTimeFilters(item(null), null, null), true);
  assert.equal(matchesFreeAnyTimeFilters(item("kids"), "Parks & views", "Leith", true), true);
  assert.equal(matchesFreeAnyTimeFilters(item("kids"), "Parks & views", "Newington", true), false);
});

test("hasKidFriendly", () => {
  assert.equal(hasKidFriendly([item(null), item(undefined)]), false);
  assert.equal(hasKidFriendly([item(null), item("all_ages")]), true);
});
