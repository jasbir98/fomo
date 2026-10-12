// Run with `npx tsx --test lib/finds/build.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFindItems, findIsStale } from "@/lib/finds/build";
import { event, findRow, happening, NOW } from "@/lib/finds/fixtures.test-util";

const maps = (events: ReturnType<typeof event>[], happenings: ReturnType<typeof happening>[]) => ({
  e: new Map(events.map((x) => [x.id, x])),
  h: new Map(happenings.map((x) => [x.id, x])),
});

test("keeps a live happening and a future event, shaped as FindItem", () => {
  const h = happening({ id: "h1", starts_at: "2026-10-17T18:00:00Z" });
  const e = event({ id: "e1" });
  const { e: em, h: hm } = maps([e], [h]);
  const items = buildFindItems(
    [findRow({ id: "r1", subject_id: "h1", why: "A", fomo_level: 4 }), findRow({ id: "r2", subject_type: "event", subject_id: "e1", why: "B", fomo_level: 2 })],
    em,
    hm,
    NOW
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.kind, i.why, i.fomoLevel]),
    [["r1", "happening", "A", 4], ["r2", "event", "B", 2]]
  );
});

test("drops rows whose subject is missing", () => {
  const { e, h } = maps([], []);
  const items = buildFindItems(
    [findRow({ id: "r1", subject_id: "nope" }), findRow({ id: "r2", subject_type: "event", subject_id: "nope" })],
    e,
    h,
    NOW
  );
  assert.equal(items.length, 0);
});

test("drops dormant and retired happenings, and one-offs that have ended", () => {
  const { e, h } = maps(
    [],
    [
      happening({ id: "dormant", status: "dormant", starts_at: "2026-10-17T18:00:00Z" }),
      happening({ id: "retired", status: "retired", starts_at: "2026-10-17T18:00:00Z" }),
      happening({ id: "over", starts_at: "2026-10-01T18:00:00Z" }),
      happening({ id: "ok", starts_at: "2026-10-17T18:00:00Z" }),
    ]
  );
  const rows = ["dormant", "retired", "over", "ok"].map((id) => findRow({ id: `r-${id}`, subject_id: id }));
  assert.deepEqual(buildFindItems(rows, e, h, NOW).map((i) => i.id), ["r-ok"]);
});

test("a recurring happening is not ended just because today isn't one of its days", () => {
  const weekly = happening({ id: "w", recurrence: { type: "weekly", days: [6] }, starts_at: null });
  const { e, h } = maps([], [weekly]);
  assert.equal(buildFindItems([findRow({ id: "r", subject_id: "w" })], e, h, NOW).length, 1);
});

test("drops events that have ended or been cancelled/gone/expired; a missing status counts as active", () => {
  const { e, h } = maps(
    [
      event({ id: "past", starts_at: "2026-10-10T19:00:00Z" }),
      event({ id: "cancelled", status: "cancelled" }),
      event({ id: "gone", status: "gone" }),
      event({ id: "expired", status: "expired" }),
      event({ id: "active", status: "active" }),
      event({ id: "nostatus" }),
      // Multi-day exhibition already under way: still on.
      event({ id: "running", starts_at: "2026-10-10T09:00:00Z", ends_at: "2026-10-20T17:00:00Z" }),
    ],
    []
  );
  const rows = ["past", "cancelled", "gone", "expired", "active", "nostatus", "running"].map((id) =>
    findRow({ id: `r-${id}`, subject_type: "event", subject_id: id })
  );
  assert.deepEqual(
    buildFindItems(rows, e, h, NOW).map((i) => i.id).sort(),
    ["r-active", "r-nostatus", "r-running"]
  );
});

test("orders by fomo level desc, then soonest start, then id", () => {
  const { e, h } = maps(
    [
      event({ id: "late", starts_at: "2026-10-20T19:00:00Z" }),
      event({ id: "soon", starts_at: "2026-10-15T19:00:00Z" }),
    ],
    [
      happening({ id: "hap", starts_at: "2026-10-17T18:00:00Z" }),
      // Weekly Saturdays: next occurrence is Sat 17 Oct (a date, no clock).
      happening({ id: "wk", recurrence: { type: "weekly", days: [6] }, starts_at: null }),
    ]
  );
  const rows = [
    findRow({ id: "r-late", subject_type: "event", subject_id: "late", fomo_level: 3 }),
    findRow({ id: "r-soon", subject_type: "event", subject_id: "soon", fomo_level: 3 }),
    findRow({ id: "r-hap", subject_id: "hap", fomo_level: 3 }),
    findRow({ id: "r-wk", subject_id: "wk", fomo_level: 5 }),
    findRow({ id: "r-low", subject_type: "event", subject_id: "soon", fomo_level: 1 }),
  ];
  assert.deepEqual(
    buildFindItems(rows, e, h, NOW).map((i) => i.id),
    ["r-wk", "r-soon", "r-hap", "r-late", "r-low"]
  );
});

test("equal level and start tie-break on id, regardless of input order", () => {
  const { e, h } = maps([event({ id: "same" })], []);
  const a = findRow({ id: "a", subject_type: "event", subject_id: "same" });
  const b = findRow({ id: "b", subject_type: "event", subject_id: "same" });
  assert.deepEqual(buildFindItems([b, a], e, h, NOW).map((i) => i.id), ["a", "b"]);
  assert.deepEqual(buildFindItems([a, b], e, h, NOW).map((i) => i.id), ["a", "b"]);
});

test("findIsStale treats a missing subject as stale", () => {
  assert.equal(findIsStale({ subject_type: "event" }, undefined, NOW), true);
});
