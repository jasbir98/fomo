import { test } from "node:test";
import assert from "node:assert/strict";
import { planSummary } from "@/lib/plans/format";
import type { PlanItem, PlanPrice } from "@/lib/plans/types";

const FREE: PlanPrice = { label: "FREE", amount: 0, from: false };
const FIVE: PlanPrice = { label: "£5", amount: 5, from: false };
const FROM_TWELVE: PlanPrice = { label: "From £12", amount: 12, from: true };
const TBC: PlanPrice = { label: "20% off", amount: null, from: false };

function item(day: string, price: PlanPrice): PlanItem {
  return { kind: "happening", id: `${day}-${price.label}`, title: "x", venue: null, day, time: null, image: "/x.webp", price };
}

// Sat 17 / Sun 18 Oct 2026.
test("all free", () => {
  assert.equal(planSummary([item("2026-10-17", FREE), item("2026-10-18", FREE)]).headline, "A free weekend in Edinburgh");
});

test("exact total", () => {
  assert.equal(planSummary([item("2026-10-17", FREE), item("2026-10-18", FIVE)]).headline, "A £5 weekend in Edinburgh");
});

test("a floor says from", () => {
  assert.equal(planSummary([item("2026-10-17", FIVE), item("2026-10-18", FROM_TWELVE)]).headline, "A weekend in Edinburgh from £17");
});

test("an unknown price never shows a sum like £0+", () => {
  const s = planSummary([item("2026-10-17", FREE), item("2026-10-17", FREE), item("2026-10-18", TBC), item("2026-10-18", TBC)]);
  assert.equal(s.headline.replace(/\u00a0/g, " "), "A weekend in Edinburgh: 4 things, 2 free");
  assert.doesNotMatch(s.headline, /£/);
  assert.equal(planSummary([item("2026-10-21", TBC), item("2026-10-21", FIVE)]).headline.replace(/\u00a0/g, " "), "A day out in Edinburgh: 2 things");
});
