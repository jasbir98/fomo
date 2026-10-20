import { test } from "node:test";
import assert from "node:assert/strict";
import { happeningRulesFit, placeFamilyFit } from "./family-rules.mjs";

const v = (name, category) => placeFamilyFit({ name, category }).value;

test("places: family-friendly categories are all_ages", () => {
  for (const category of ["Museum", "Park", "Botanic garden", "Beach", "Zoo", "Wildlife reserve", "Farm", "Library", "Leisure centre", "Swimming pool", "Country park", "Castle", "Nature reserve", "Visitor centre", "Science centre"]) {
    assert.equal(v("Somewhere", category), "all_ages", category);
  }
});

test("places: licensed, hotel, burial, worship and clinical places are excluded", () => {
  assert.equal(v("The Oxford Bar", "Bar"), null);
  assert.equal(v("Pub in the Park", "Park"), null); // name says pub
  assert.equal(v("Glenkinchie Distillery", "Visitor centre"), null);
  assert.equal(v("Dalhousie Castle Hotel", "Castle"), null);
  assert.equal(v("Greyfriars Kirkyard", "Park"), null);
  assert.equal(v("Warriston Cemetery", "Cemetery"), null);
  assert.equal(v("St Giles' Cathedral", "Visitor centre"), null);
  assert.equal(v("Fountain Nightclub", "Nightclub"), null);
  assert.equal(v("Royal Hospital for Children", "Park"), null);
});

test("places: kids by name, even with a non-family category", () => {
  assert.equal(v("Jungle Jims Soft Play", "Entertainment"), "kids");
  assert.equal(v("Inverleith Play Park", null), "kids");
  assert.equal(v("Meadows Playground", "Park"), "kids");
  assert.equal(v("Children's Museum of Edinburgh", "Museum"), "kids");
  assert.equal(v("Kids Club Edinburgh", "Entertainment"), "kids");
  assert.equal(v("Bushbaby Records", "Shop"), null);
});

test("places: other categories stay null", () => {
  assert.equal(v("Boots", "Shop"), null);
  assert.equal(v("Some Restaurant", "Restaurant"), null);
  assert.equal(v("Mystery", null), null);
});

test("happenings: structured rules first, then keywords", () => {
  assert.deepEqual(happeningRulesFit({ category: "family", title: "x" }), { value: "kids", reason: "rule: category=family" });
  assert.equal(happeningRulesFit({ eligibility: "family", title: "Kids eat free" }).reason, "rule: eligibility=family");
  assert.deepEqual(happeningRulesFit({ title: "Under 5s swim free", summary: null }), { value: "kids", reason: "keyword" });
  assert.equal(happeningRulesFit({ title: "Student pint deal", summary: "Half price pints" }).value, null);
  assert.equal(happeningRulesFit({ title: "Junkie Kid night", summary: null }).value, null);
});

test("happenings: student/resident/concession deals at family venues are left undecided", () => {
  assert.equal(happeningRulesFit({ category: "family", title: "Edinburgh Zoo Student Concession Ticket" }).value, null);
  assert.equal(happeningRulesFit({ category: "family", title: "Camera Obscura Resident Rate 20% Off" }).value, null);
  assert.equal(happeningRulesFit({ category: "family", title: "Halloween at Dalkeith Country Park" }).value, "kids");
});

test("placeFamilyFit: golf courses and commercial galleries are not family outings", () => {
  assert.equal(placeFamilyFit({ name: "Portobello Golf Course", category: "park" }).value, null);
  assert.equal(placeFamilyFit({ name: "Coburg House Art Studios", category: "gallery" }).value, null);
  assert.equal(placeFamilyFit({ name: "Doubtfire Gallery", category: "gallery" }).value, null);
  assert.equal(placeFamilyFit({ name: "Scottish National Gallery", category: "gallery" }).value, "all_ages");
  assert.equal(placeFamilyFit({ name: "City Art Centre", category: "gallery" }).value, "all_ages");
});
