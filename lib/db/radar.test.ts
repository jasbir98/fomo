// Run with `npx tsx --test lib/db/radar.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listRadarPicks } from "@/lib/db/radar";
import type { Db } from "@/lib/supabase/types";

/** A thenable query builder that records the chain and resolves to `result`. */
function fakeDb(result: { data: unknown; error: unknown }) {
  const calls: string[] = [];
  const builder: Record<string, unknown> = {
    select: (s: string) => (calls.push(`select ${s}`), builder),
    not: (...a: unknown[]) => (calls.push(`not ${a.join(",")}`), builder),
    or: (s: string) => (calls.push(`or ${s}`), builder),
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  const db = { from: (t: string) => (calls.push(`from ${t}`), builder) } as unknown as Db;
  return { db, calls };
}

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  image_url: null,
  radar_why: "Worth knowing",
  radar_picked_at: "2026-11-02T00:00:00Z",
  place_photos: [{ url: "https://example.com/p.jpg", display_order: 0 }],
  ...over,
});

test("listRadarPicks: reads approved places, backfills the photo, drops rows without a reason", async () => {
  const { db, calls } = fakeDb({ data: [row("a"), row("b", { radar_why: "" })], error: null });
  const picks = await listRadarPicks(db);
  assert.deepEqual(picks.map((p) => p.id), ["a"]);
  assert.equal(picks[0].image_url, "https://example.com/p.jpg");
  assert.ok(calls.includes("from places"));
  assert.ok(calls.some((c) => c.startsWith("not radar_picked_at,is,")));
  assert.ok(calls.some((c) => c.startsWith("or source.is.null")), "event-venue rows excluded");
});

test("listRadarPicks: missing radar columns (SQL not run) is an empty list, not an error", async () => {
  const { db } = fakeDb({ data: null, error: { code: "42703", message: "column places.radar_picked_at does not exist" } });
  assert.deepEqual(await listRadarPicks(db), []);
  const { db: db2 } = fakeDb({ data: null, error: { code: "PGRST204", message: "Could not find the 'radar_why' column of 'places' in the schema cache" } });
  assert.deepEqual(await listRadarPicks(db2), []);
});

test("listRadarPicks: any other error still throws", async () => {
  const err = { code: "500", message: "connection reset" };
  const { db } = fakeDb({ data: null, error: err });
  await assert.rejects(() => listRadarPicks(db), (e) => e === err);
});

test("listRadarPicks: null data is an empty list", async () => {
  const { db } = fakeDb({ data: null, error: null });
  assert.deepEqual(await listRadarPicks(db), []);
});
