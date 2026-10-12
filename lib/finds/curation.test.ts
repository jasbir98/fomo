// Run with `npx tsx --test lib/finds/curation.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTable, liveOrder, resolveTargets, suggestedOrder } from "@/lib/finds/curation";
import { findRow } from "@/lib/finds/fixtures.test-util";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

const rows = [
  findRow({ id: U1, status: "suggested", score: 40 }),
  findRow({ id: U2, status: "suggested", score: 80 }),
  findRow({ id: U3, status: "live", fomo_level: 5 }),
  findRow({ id: "44444444-4444-4444-8444-444444444444", status: "retired" }),
  findRow({ id: "55555555-5555-4555-8555-555555555555", status: "suggested", score: null }),
];

test("suggestedOrder: score desc, nulls last, suggested only", () => {
  assert.deepEqual(suggestedOrder(rows).map((r) => r.id.slice(0, 2)), ["22", "11", "55"]);
});

test("numbering is independent of the order rows are read in", () => {
  const shuffled = [...rows].reverse();
  assert.deepEqual(suggestedOrder(shuffled).map((r) => r.id), suggestedOrder(rows).map((r) => r.id));
});

test("liveOrder: level desc then approval time", () => {
  const live = [
    findRow({ id: "a", fomo_level: 3, approved_at: "2026-10-01" }),
    findRow({ id: "b", fomo_level: 5, approved_at: "2026-10-03" }),
    findRow({ id: "c", fomo_level: 3, approved_at: "2026-10-02" }),
  ];
  assert.deepEqual(liveOrder(live).map((r) => r.id), ["b", "a", "c"]);
});

test("resolveTargets: numbers index the numbered list; uuids work on any row; duplicates collapse", () => {
  const res = resolveTargets("1, 3,1", suggestedOrder(rows), rows);
  assert.ok(res.ok);
  assert.deepEqual(res.rows.map((r) => r.id.slice(0, 2)), ["22", "55"]);

  const byId = resolveTargets(U3.toUpperCase(), suggestedOrder(rows), rows);
  assert.ok(byId.ok);
  assert.equal(byId.rows[0].status, "live");
});

test("resolveTargets: unknown number, unknown uuid, junk and empty are errors, never a guess", () => {
  const numbered = suggestedOrder(rows);
  assert.equal(resolveTargets("4", numbered, rows).ok, false);
  assert.equal(resolveTargets("0", numbered, rows).ok, false);
  assert.equal(resolveTargets("99999999-9999-4999-8999-999999999999", numbered, rows).ok, false);
  assert.equal(resolveTargets("1,abc", numbered, rows).ok, false);
  assert.equal(resolveTargets("", numbered, rows).ok, false);
});

test("formatTable numbers lines from 1 and keeps why last", () => {
  const out = formatTable([
    { type: "happening", title: "A very long title that will be cut off somewhere sensible", when: "Sat 17 Oct", price: "", score: 61.234, level: 4, why: "£8 wristband" },
  ]).split("\n");
  assert.equal(out.length, 2);
  assert.match(out[1], /^ 1 {2}happening/);
  assert.match(out[1], /61\.2/);
  assert.ok(out[1].endsWith("£8 wristband"));
  assert.ok(out[1].includes("…"));
});
