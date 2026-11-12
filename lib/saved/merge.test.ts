// Run: npx tsx --test lib/saved/merge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeLocalSaves } from "./merge";
import type { LocalSave } from "./local-store";

const L = (type: LocalSave["type"], id: string, savedAt: number): LocalSave => ({ type, id, savedAt });

function setup(local: LocalSave[], opts: { account?: string[]; alive?: string[]; failSaveOn?: string; existingThrows?: boolean } = {}) {
  const saved: string[] = [];
  let cleared = 0;
  const run = () =>
    mergeLocalSaves({
      local,
      accountKeys: new Set(opts.account ?? []),
      existing: async (refs) => {
        if (opts.existingThrows) throw new Error("network");
        const alive = new Set(opts.alive ?? refs.map((r) => `${r.type}:${r.id}`));
        return new Set(refs.map((r) => `${r.type}:${r.id}`).filter((k) => alive.has(k)));
      },
      save: async (r) => {
        if (opts.failSaveOn === r.id) throw new Error("boom");
        saved.push(`${r.type}:${r.id}`);
      },
      clear: () => {
        cleared++;
      },
    });
  return { run, saved, cleared: () => cleared };
}

test("nothing local: nothing happens", async () => {
  const t = setup([]);
  assert.deepEqual(await t.run(), { status: "empty" });
  assert.equal(t.cleared(), 0);
});

test("merges oldest first, then clears", async () => {
  const t = setup([L("happening", "new", 20), L("event", "old", 10)]);
  const r = await t.run();
  assert.equal(r.status, "merged");
  assert.deepEqual(t.saved, ["event:old", "happening:new"]);
  assert.equal(t.cleared(), 1);
});

test("skips items the account already has and items that no longer exist", async () => {
  const t = setup([L("happening", "dup", 1), L("event", "gone", 2), L("place", "ok", 3)], {
    account: ["happening:dup"],
    alive: ["place:ok"],
  });
  const r = await t.run();
  assert.equal(r.status, "merged");
  assert.deepEqual(t.saved, ["place:ok"]);
  assert.equal(r.status === "merged" && r.skipped, 2);
  assert.equal(t.cleared(), 1);
});

test("everything already saved still clears the local store", async () => {
  const t = setup([L("happening", "a", 1)], { account: ["happening:a"] });
  assert.equal((await t.run()).status, "merged");
  assert.deepEqual(t.saved, []);
  assert.equal(t.cleared(), 1);
});

test("a failed save keeps local saves", async () => {
  const t = setup([L("happening", "a", 1), L("happening", "b", 2)], { failSaveOn: "b" });
  const r = await t.run();
  assert.equal(r.status, "failed");
  assert.equal(t.cleared(), 0);
});

test("a failed existence check keeps local saves and saves nothing", async () => {
  const t = setup([L("happening", "a", 1)], { existingThrows: true });
  assert.equal((await t.run()).status, "failed");
  assert.deepEqual(t.saved, []);
  assert.equal(t.cleared(), 0);
});

test("running twice is idempotent", async () => {
  const local = [L("event", "e", 1)];
  const first = setup(local);
  await first.run();
  const second = setup(local, { account: ["event:e"] });
  assert.equal((await second.run()).status, "merged");
  assert.deepEqual(second.saved, []);
});
