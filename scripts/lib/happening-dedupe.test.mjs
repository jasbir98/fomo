import { test } from "node:test";
import assert from "node:assert/strict";
import { areDuplicates, brandKey, findDuplicateGroups, priceFigures } from "./happening-dedupe.mjs";

let n = 0;
const row = (over) => ({
  id: `id-${(n += 1)}`,
  slug: `slug-${n}`,
  status: "live",
  kind: "deal",
  eligibility: "under_26",
  saving_amount: null,
  saving_label: null,
  venue_name: null,
  image_url: null,
  place_id: null,
  confidence: "medium",
  verified_at: "2026-09-27T10:00:00Z",
  summary: null,
  ...over,
});

const traverseOld = () =>
  row({ title: "Traverse Theatre £1 Tickets", venue_name: "Traverse Theatre", saving_label: "£1 tickets", verified_at: "2026-09-27T10:00:00Z" });
const traverseNew = () =>
  row({ title: "Traverse £1 Tickets for Under-25s", saving_label: "£1", verified_at: "2026-09-29T10:00:00Z" });
const filmhouseOld = () =>
  row({ title: "Filmhouse Young Member £7 Tickets", venue_name: "Filmhouse", saving_label: "£7", verified_at: "2026-09-27T10:00:00Z" });
const filmhouseNew = () =>
  row({ title: "Filmhouse Free Young Membership (Under 26)", venue_name: "Filmhouse Edinburgh", saving_label: "£7", verified_at: "2026-09-29T10:00:00Z" });
const operaOld = () =>
  row({ title: "Scottish Opera Under 26 Tickets", saving_label: "£15", verified_at: "2026-09-27T10:00:00Z" });
const operaNew = () =>
  row({ title: "Scottish Opera £15 Under-26 Tickets", venue_name: "Festival Theatre Edinburgh", verified_at: "2026-09-29T10:00:00Z" });

test("brandKey: leading words up to the first offer word, number or £", () => {
  assert.equal(brandKey("Traverse Theatre £1 Tickets"), "traverse theatre");
  assert.equal(brandKey("Traverse £1 Tickets for Under-25s"), "traverse");
  assert.equal(brandKey("Scottish Opera Under 26 Tickets"), "scottish opera");
  assert.equal(brandKey("Filmhouse Young Member £7 Tickets"), "filmhouse");
  assert.equal(brandKey("Capital Theatres 25 & Under £10 Tickets"), "capital theatres");
  assert.equal(brandKey("£5 Tickets"), "");
});

test("priceFigures reads saving_amount, saving_label and title; free is 0", () => {
  assert.deepEqual([...priceFigures(row({ title: "A £7 B", saving_label: "£7.50", saving_amount: 3 }))].sort(), [3, 7, 7.5]);
  assert.deepEqual([...priceFigures(row({ title: "Free entry", is_free: true }))], [0]);
});

test("Traverse pair is a duplicate; the newer row is kept", () => {
  const [old, fresh] = [traverseOld(), traverseNew()];
  assert.equal(areDuplicates(old, fresh), true);
  const groups = findDuplicateGroups([old, fresh]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep.id, fresh.id);
  assert.equal(groups[0].drops[0].row.id, old.id);
  assert.equal(groups[0].drops[0].reason, "newer verified_at");
});

test("Filmhouse pair: 'Filmhouse' and 'Filmhouse Edinburgh' are one venue", () => {
  const [old, fresh] = [filmhouseOld(), filmhouseNew()];
  assert.equal(areDuplicates(old, fresh), true);
  assert.equal(findDuplicateGroups([old, fresh])[0].keep.id, fresh.id);
});

test("Scottish Opera pair: null venue + brand match against a Festival Theatre row", () => {
  const [old, fresh] = [operaOld(), operaNew()];
  assert.equal(areDuplicates(old, fresh), true);
  assert.equal(findDuplicateGroups([old, fresh])[0].keep.id, fresh.id);
});

test("Capital Theatres £10 vs £15 are different offers, not duplicates", () => {
  const ten = row({ title: "Capital Theatres 25 & Under £10 Tickets", venue_name: "Capital Theatres", saving_label: "£10" });
  const fifteen = row({ title: "Capital Theatres Under 26 Advance Tickets", venue_name: "Capital Theatres", saving_label: "£15" });
  assert.equal(areDuplicates(ten, fifteen), false);
  assert.deepEqual(findDuplicateGroups([ten, fifteen]), []);
});

test("keep order: an image / place link beats a newer verified_at, then confidence", () => {
  const [old, fresh] = [traverseOld(), traverseNew()];
  old.place_id = "place-1";
  let group = findDuplicateGroups([old, fresh])[0];
  assert.equal(group.keep.id, old.id);
  assert.equal(group.drops[0].reason, "has an image / place link");

  old.place_id = null;
  old.confidence = "high";
  group = findDuplicateGroups([old, fresh])[0];
  assert.equal(group.keep.id, old.id);
  assert.equal(group.drops[0].reason, "higher confidence");

  old.confidence = "medium";
  old.verified_at = fresh.verified_at;
  old.summary = "a longer summary";
  group = findDuplicateGroups([old, fresh])[0];
  assert.equal(group.keep.id, old.id);
  assert.equal(group.drops[0].reason, "longer summary");
});

test("not duplicates: different kind, different eligibility, different venue, or no price", () => {
  const base = traverseOld();
  assert.equal(areDuplicates(base, { ...traverseNew(), kind: "free_access" }), false);
  assert.equal(areDuplicates(base, { ...traverseNew(), eligibility: "student" }), false);
  assert.equal(areDuplicates(base, { ...traverseNew(), eligibility: null }), true);
  assert.equal(areDuplicates(base, { ...traverseNew(), venue_name: "Usher Hall" }), false);
  assert.equal(
    areDuplicates(row({ title: "Zizzi 20% off", venue_name: "Zizzi" }), row({ title: "Zizzi 20% off food", venue_name: "Zizzi" })),
    false
  );
  // Same brand and price at two different named venues (branches) stays separate.
  assert.equal(
    areDuplicates(row({ title: "Ask £5 lunch", venue_name: "ASK Italian Leith" }), row({ title: "Ask £5 lunch", venue_name: "ASK Italian Morningside" })),
    false
  );
});

test("three-way cluster collapses to one keeper", () => {
  const rows = [traverseOld(), traverseNew(), row({ title: "Traverse Theatre £1 Tickets", venue_name: "Traverse Theatre", verified_at: "2026-09-20T10:00:00Z" })];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].drops.length, 2);
});

test("not duplicates: two EH-resident deals at different restaurants, and a % deal vs a £ price", () => {
  const resident = (title) => row({ title, eligibility: "local_resident", saving_amount: 20, saving_label: "20% off food" });
  assert.equal(
    areDuplicates(resident("EH Residents 20% off at 1802 Lounge & Grill"), resident("EH Residents 20% off at The Neighbourhood Restaurant")),
    false
  );
  const venue = "Slug & Lettuce Edinburgh Omni Centre";
  assert.equal(
    areDuplicates(
      row({ title: "Slug & Lettuce OMNi 25% Off Food", venue_name: venue, eligibility: "student", saving_amount: 25, saving_label: "25% off food" }),
      row({ title: "Slug & Lettuce OMNi £25 Student Bottomless Brunch", venue_name: venue, eligibility: "student", saving_amount: 25, saving_label: "£25 bottomless brunch" })
    ),
    false
  );
});
