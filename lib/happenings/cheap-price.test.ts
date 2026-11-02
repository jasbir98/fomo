import { test } from "node:test";
import assert from "node:assert/strict";
import { cheapPriceMatch, isCheapPrice, statedPrices } from "./cheap-price";
import { isGenuineDeal } from "./groups";

const row = (title: string, saving_label: string | null = null) => ({
  title,
  saving_label,
  saving_amount: null,
  promo_code: null,
  eligibility: "anyone" as const,
});

test("a fixed price at or below the line for a named item is a cheap price", () => {
  assert.equal(isCheapPrice("£4 cask pints", null), true);
  assert.equal(isCheapPrice("Tuesday beer night", "£5 IPA with any burger"), true);
  assert.equal(isCheapPrice("Patisserie Valerie afternoon tea for two £30", null), true);
});

test("over the line, no item, or not a price is not a cheap price", () => {
  assert.equal(isCheapPrice("Victoria Bar classic cocktails £8", null), false);
  assert.equal(isCheapPrice("Patisserie Valerie lunch and patisserie £12", null), false);
  assert.equal(isCheapPrice("Splash and Glow: £29 weekday sessions", null), false);
  assert.equal(isCheapPrice("£5 off pints", null), false);
  assert.equal(isCheapPrice("Save £2 on pints", null), false);
});

test("terms match whole words only", () => {
  assert.equal(isCheapPrice("£3 iPad accessories", null), false);
  assert.equal(isCheapPrice("£4 pints", null), true);
});

test("stated prices skip 'off' and 'save', and halve for two", () => {
  assert.deepEqual(statedPrices("£5 off, then £4 pints"), [4]);
  assert.deepEqual(statedPrices("Saves up to £5, burger £8"), [8]);
  assert.deepEqual(statedPrices("Burger for two £16"), [8]);
});

test("the match names the item", () => {
  assert.equal(cheapPriceMatch("£4 cask pints", null)?.id, "pint");
});

test("isGenuineDeal accepts a cheap price and still rejects a plain price", () => {
  assert.equal(isGenuineDeal(row("£4 cask pints")), true);
  assert.equal(isGenuineDeal(row("Cocktails", "£8")), false);
  assert.equal(isGenuineDeal(row("Adult £10")), false);
  assert.equal(isGenuineDeal(row("Splash and Glow: £29 weekday sessions")), false);
  assert.equal(isGenuineDeal(row("£5 off pints")), true); // discount wording
  assert.equal(isGenuineDeal(row("20% off", null)), true);
  assert.equal(isGenuineDeal(row("Half price tickets")), true);
  assert.equal(isGenuineDeal({ ...row("x"), promo_code: "ABC" }), true);
  assert.equal(isGenuineDeal({ ...row("x"), eligibility: "student", saving_amount: 3 }), true);
});
