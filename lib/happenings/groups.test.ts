import { test } from "node:test";
import assert from "node:assert/strict";
import { dealFacets, matchesDealFilters, whoGroupForEligibility } from "./groups";

test("family eligibility maps to the families WHO group", () => {
  assert.equal(whoGroupForEligibility("family"), "families");
});

test("dealFacets flags kid-oriented deals whatever their eligibility", () => {
  assert.equal(dealFacets({ category: "family", eligibility: "anyone" }).kidFriendly, true);
  assert.equal(dealFacets({ category: "museum", eligibility: "family" }).kidFriendly, true);
  assert.equal(dealFacets({ category: "museum", eligibility: "anyone", family_fit: "kids" }).kidFriendly, true);
  assert.equal(dealFacets({ category: "museum", eligibility: "anyone", family_fit: "all_ages" }).kidFriendly, false);
  assert.equal(dealFacets({ category: "food", eligibility: "student" }).kidFriendly, false);
});

test("the Families chip matches family eligibility and kid-oriented deals, nothing else", () => {
  const familyOnly = dealFacets({ category: "food", eligibility: "family" });
  const kidsGoFree = dealFacets({ category: "family", eligibility: "anyone" });
  const kidsFitStudent = dealFacets({ category: "museum", eligibility: "student", family_fit: "kids" });
  const plain = dealFacets({ category: "food", eligibility: "anyone" });
  const student = dealFacets({ category: "food", eligibility: "student" });
  assert.equal(matchesDealFilters(familyOnly, null, "families"), true);
  assert.equal(matchesDealFilters(kidsGoFree, null, "families"), true);
  assert.equal(matchesDealFilters(kidsFitStudent, null, "families"), true);
  assert.equal(matchesDealFilters(plain, null, "families"), false);
  assert.equal(matchesDealFilters(student, null, "families"), false);
});

test("other WHO chips and the WHAT row are unchanged", () => {
  const kidsFitStudent = dealFacets({ category: "museum", eligibility: "student", family_fit: "kids" });
  assert.equal(matchesDealFilters(kidsFitStudent, null, "students"), true);
  assert.equal(matchesDealFilters(kidsFitStudent, null, "over_60"), false);
  assert.equal(matchesDealFilters(kidsFitStudent, "culture", "families"), true);
  assert.equal(matchesDealFilters(kidsFitStudent, "sports", "families"), false);
  assert.equal(matchesDealFilters(kidsFitStudent, null, null), true);
});
