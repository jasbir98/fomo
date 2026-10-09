import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_OVERRIDES, OVERRIDABLE_COLUMNS, applyEventOverrides, validateOverrides } from "./overrides.mjs";
import { prepareRows } from "./upsert.mjs";

const row = (over = {}) => ({
  provider: "allevents",
  provider_event_id: "https://allevents.in/edinburgh/a/1",
  name: "Thrift Festival",
  starts_at: "2026-10-18T00:00:00.000Z",
  price_from: null,
  is_free: null,
  status: "active",
  ...over,
});
const other = row({ provider_event_id: "https://allevents.in/edinburgh/b/2", name: "Other" });
const entry = (over = {}) => ({ provider: "allevents", provider_event_id: "https://allevents.in/edinburgh/a/1", reason: "test", ...over });

test("set: merges columns over the scraped row, scraped values lose", () => {
  const { rows, applied } = applyEventOverrides([row({ price_from: 5 })], [entry({ set: { price_from: 2.46, is_free: false } })]);
  assert.equal(rows[0].price_from, 2.46);
  assert.equal(rows[0].is_free, false);
  assert.equal(rows[0].name, "Thrift Festival");
  assert.equal(rows[0].status, "active");
  assert.deepEqual(applied, [{ provider: "allevents", provider_event_id: row().provider_event_id, hide: false, setKeys: ["price_from", "is_free"] }]);
});

test("hide: forces status 'gone' even when the row was active", () => {
  const { rows, applied } = applyEventOverrides([row()], [entry({ hide: true })]);
  assert.equal(rows[0].status, "gone");
  assert.equal(applied[0].hide, true);
});

test("non-matching rows are untouched (same object); provider must match too", () => {
  const { rows, applied } = applyEventOverrides([other, row({ provider: "luma" })], [entry({ hide: true })]);
  assert.equal(rows[0], other);
  assert.equal(rows[1].status, "active");
  assert.deepEqual(applied, []);
});

test("the input row is not mutated", () => {
  const r = row();
  applyEventOverrides([r], [entry({ hide: true, set: { name: "X" } })]);
  assert.equal(r.status, "active");
  assert.equal(r.name, "Thrift Festival");
});

test("unknown or non-column set keys throw with a clear message", () => {
  assert.throws(() => applyEventOverrides([row()], [entry({ set: { price: 3 } })]), /"price" is not an overridable events column/);
  assert.throws(() => applyEventOverrides([row()], [entry({ set: { status: "gone" } })]), /"status" is not an overridable/);
  assert.throws(() => validateOverrides([entry()]), /needs hide: true or a non-empty set/);
  assert.throws(() => validateOverrides([{ provider: "allevents", hide: true }]), /required strings/);
});

test("the checked-in EVENT_OVERRIDES are valid and only use allowed columns", () => {
  assert.doesNotThrow(() => validateOverrides(EVENT_OVERRIDES));
  for (const o of EVENT_OVERRIDES) {
    assert.ok(o.reason);
    for (const k of Object.keys(o.set ?? {})) assert.ok(OVERRIDABLE_COLUMNS.includes(k));
  }
});

test("prepareRows (upsertEvents stamping): a hidden row ends up 'gone' with a fresh last_seen_at", () => {
  const seenAt = "2026-10-09T06:00:00.000Z";
  const { rows, applied } = prepareRows([row({ _flag: true }), other], seenAt, [entry({ hide: true })]);
  assert.equal(rows[0].status, "gone");
  assert.equal(rows[0].last_seen_at, seenAt);
  assert.equal("_flag" in rows[0], false);
  assert.equal(rows[1].status, "active");
  assert.equal(applied.length, 1);
});

test("prepareRows: set values survive stamping; a source-cancelled row stays cancelled", () => {
  const { rows } = prepareRows([row({ status: "cancelled" })], "2026-10-09T06:00:00.000Z", [entry({ set: { currency: "GBP" } })]);
  assert.equal(rows[0].currency, "GBP");
  assert.equal(rows[0].status, "cancelled");
});
