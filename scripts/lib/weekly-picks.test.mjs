import test from "node:test";
import assert from "node:assert/strict";
import { isGenuineDeal, isKidsAimed, leadWithoutKidsAimed } from "./weekly-picks.mjs";

test("isKidsAimed: stored family_fit wins, then category / eligibility fallbacks", () => {
  assert.equal(isKidsAimed({ family_fit: "kids" }), true);
  assert.equal(isKidsAimed({ family_fit: "all_ages", category: "family" }), false);
  // A stored null is a decision (column present); the fallback is only for absent.
  assert.equal(isKidsAimed({ family_fit: null, category: "family" }), false);
  assert.equal(isKidsAimed({ category: "family" }), true);
  assert.equal(isKidsAimed({ category: "music", eligibility: "family" }), true);
  assert.equal(isKidsAimed({ category: "music", eligibility: "anyone" }), false);
  assert.equal(isKidsAimed({}), false);
});

const kids = (title) => ({ title, category: "family", family_fit: "kids" });
const normal = (title) => ({ title, category: "music", family_fit: null });
const allAges = (title) => ({ title, category: "museum", family_fit: "all_ages" });
const titles = (xs) => xs.map((x) => x.title);

test("leadWithoutKidsAimed: a kids-aimed lead yields to the first non-kids item, order otherwise kept", () => {
  const out = leadWithoutKidsAimed([kids("A"), kids("B"), normal("C"), normal("D")]);
  assert.deepEqual(titles(out), ["C", "A", "B", "D"]);
});

test("leadWithoutKidsAimed: a non-kids or all_ages lead is untouched", () => {
  assert.deepEqual(titles(leadWithoutKidsAimed([normal("A"), kids("B")])), ["A", "B"]);
  assert.deepEqual(titles(leadWithoutKidsAimed([allAges("A"), kids("B")])), ["A", "B"]);
});

test("leadWithoutKidsAimed: all kids-aimed, or empty, is unchanged; input is not mutated", () => {
  const all = [kids("A"), kids("B")];
  assert.deepEqual(titles(leadWithoutKidsAimed(all)), ["A", "B"]);
  assert.deepEqual(leadWithoutKidsAimed([]), []);
  const input = [kids("A"), normal("B")];
  leadWithoutKidsAimed(input);
  assert.deepEqual(titles(input), ["A", "B"]);
});

test("isGenuineDeal accepts a cheap price for a named item, not a plain price", () => {
  const row = (title, saving_label = null) => ({ title, saving_label, saving_amount: null, promo_code: null, eligibility: "anyone" });
  assert.equal(isGenuineDeal(row("£4 cask pints")), true);
  assert.equal(isGenuineDeal(row("Tuesday beer night", "£5 IPA with any burger")), true);
  assert.equal(isGenuineDeal(row("Patisserie Valerie afternoon tea for two £30")), true);
  assert.equal(isGenuineDeal(row("Victoria Bar classic cocktails £8")), false);
  assert.equal(isGenuineDeal(row("Splash and Glow: £29 weekday sessions")), false);
  assert.equal(isGenuineDeal(row("Adult £10")), false);
  assert.equal(isGenuineDeal(row("£5 off pints")), true); // discount wording
});

test("isGenuineDeal accepts BOGOF-style wording", () => {
  const row = (title, saving_label = null) => ({ title, saving_label, saving_amount: null, promo_code: null, eligibility: "anyone" });
  assert.equal(isGenuineDeal(row("BOGOF burgers")), true);
  assert.equal(isGenuineDeal(row("Pizza night", "Buy one, get one")), true);
  assert.equal(isGenuineDeal(row("Buy one get one on cocktails")), true);
  assert.equal(isGenuineDeal(row("Get another pint")), true);
  assert.equal(isGenuineDeal(row("Get a second coffee")), true);
  assert.equal(isGenuineDeal(row("Buy one book")), false);
});
