import { test } from "node:test";
import assert from "node:assert/strict";
import { planTotal, priceForEvent, priceForHappening } from "@/lib/plans/price";

const happening = { is_free: null, price_text: null, saving_label: null, saving_amount: null, currency: "GBP" };

test("free happening is £0", () => {
  assert.deepEqual(priceForHappening({ ...happening, is_free: true }), { label: "FREE", amount: 0, from: false });
});

test("happening price_text is used only when it is just a price", () => {
  assert.deepEqual(priceForHappening({ ...happening, price_text: "£5" }), { label: "£5", amount: 5, from: false });
  assert.deepEqual(priceForHappening({ ...happening, price_text: "From £4.50" }), { label: "From £4.50", amount: 4.5, from: true });
  assert.equal(priceForHappening({ ...happening, price_text: "£20 for two" }).amount, null);
});

test("a discount stays a label with no amount", () => {
  assert.deepEqual(priceForHappening({ ...happening, saving_label: "20% off food" }), { label: "20% off", amount: null, from: false });
});

test("event price_from is a floor", () => {
  assert.deepEqual(priceForEvent({ is_free: false, price_from: 12, currency: "GBP" }), { label: "From £12", amount: 12, from: true });
  assert.deepEqual(priceForEvent({ is_free: null, price_from: null, currency: null }), { label: null, amount: null, from: false });
});

test("total labels", () => {
  const free = { label: "FREE", amount: 0, from: false };
  const five = { label: "£5", amount: 5, from: false };
  const fromTwo = { label: "From £2", amount: 2, from: true };
  const tbc = { label: "20% off", amount: null, from: false };
  assert.equal(planTotal([free, free]).label, "£0 total");
  assert.equal(planTotal([free, five]).label, "£5 total");
  assert.equal(planTotal([five, fromTwo]).label, "From £7");
  assert.equal(planTotal([five, tbc]).label, "£5 + 1 TBC");
  assert.equal(planTotal([five, tbc]).short, "£5+");
  assert.equal(planTotal([{ label: "£2.50", amount: 2.5, from: false }, five]).label, "£7.50 total");
});
