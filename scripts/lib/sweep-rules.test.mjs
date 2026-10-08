import test from "node:test";
import assert from "node:assert/strict";
import { endedRecurrence, findEndedRecurringDeals, londonToday } from "./sweep-rules.mjs";

const TODAY = "2026-10-08";

test("weekly with until in the past has ended; today or future has not", () => {
  assert.equal(endedRecurrence({ type: "weekly", days: [1], until: "2026-10-07" }, TODAY), "weekly until 2026-10-07");
  assert.equal(endedRecurrence({ type: "weekly", days: [1], until: "2026-10-08" }, TODAY), null);
  assert.equal(endedRecurrence({ type: "weekly", days: [1], until: "2026-12-31" }, TODAY), null);
  assert.equal(endedRecurrence({ type: "weekly", days: [1], until: null }, TODAY), null);
  assert.equal(endedRecurrence({ type: "weekly", days: [1] }, TODAY), null);
});

test("dates: ended only when the last date has passed", () => {
  assert.equal(endedRecurrence({ type: "dates", dates: ["2026-09-25", "2026-10-30"] }, TODAY), null);
  assert.equal(endedRecurrence({ type: "dates", dates: ["2026-09-25", "2026-10-02"] }, TODAY), "last date 2026-10-02");
  assert.equal(endedRecurrence({ type: "dates", dates: ["2026-10-08"] }, TODAY), null);
  assert.equal(endedRecurrence({ type: "dates", dates: [] }, TODAY), null);
  assert.equal(endedRecurrence({ type: "dates", dates: ["not a date"] }, TODAY), null);
});

test("order of dates does not matter and ISO timestamps are accepted", () => {
  assert.equal(endedRecurrence({ type: "dates", dates: ["2026-10-02T10:00:00Z", "2026-09-01"] }, TODAY), "last date 2026-10-02");
});

test("other recurrence types never end", () => {
  for (const type of ["once", "always", "annual"]) assert.equal(endedRecurrence({ type }, TODAY), null);
  assert.equal(endedRecurrence(null, TODAY), null);
  assert.equal(endedRecurrence("weekly", TODAY), null);
});

test("findEndedRecurringDeals only returns live deals", () => {
  const rows = [
    { id: 1, slug: "a", kind: "deal", status: "live", recurrence: { type: "weekly", days: [2], until: "2026-09-01" } },
    { id: 2, slug: "b", kind: "deal", status: "live", recurrence: { type: "weekly", days: [2], until: "2026-11-01" } },
    { id: 3, slug: "c", kind: "event", status: "live", recurrence: { type: "weekly", days: [2], until: "2026-09-01" } },
    { id: 4, slug: "d", kind: "deal", status: "dormant", recurrence: { type: "dates", dates: ["2026-09-01"] } },
    { id: 5, slug: "e", kind: "deal", status: "live", recurrence: { type: "dates", dates: ["2026-09-01"] } },
  ];
  const out = findEndedRecurringDeals(rows, TODAY);
  assert.deepEqual(out.map((r) => r.slug), ["a", "e"]);
  assert.equal(out[0].ends_at, "weekly until 2026-09-01");
});

test("londonToday formats a date in Europe/London", () => {
  assert.equal(londonToday(new Date("2026-06-30T23:30:00Z")), "2026-07-01"); // BST
  assert.equal(londonToday(new Date("2026-12-31T23:30:00Z")), "2026-12-31"); // GMT
});
