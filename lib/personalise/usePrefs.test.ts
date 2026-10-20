// Run: npx tsx --test lib/personalise/usePrefs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAccountPrefs, togglesFromWho, whoFromPrefs } from "./usePrefs";

const NONE = { status: null, under26: false, residents: false, over60: false } as const;

test("whoFromPrefs emits families when kids is on", () => {
  assert.deepEqual(whoFromPrefs({ ...NONE, kids: true }), ["families"]);
  assert.deepEqual(whoFromPrefs({ ...NONE, kids: false }), []);
  assert.deepEqual(whoFromPrefs(NONE), []);
  assert.deepEqual(whoFromPrefs({ ...NONE, status: "student", under26: true, kids: true }), ["students", "under_26", "families"]);
});

test("togglesFromWho reads families back as kids", () => {
  assert.equal(togglesFromWho(["families"]).kids, true);
  assert.equal(togglesFromWho(["students"]).kids, false);
});

test("kids round-trips through fomo_who / fomo_kids", () => {
  const who = whoFromPrefs({ ...NONE, status: "working", residents: true, kids: true });
  const meta = { fomo_status: "working", fomo_who: who, fomo_kids: true, fomo_interests: [], fomo_budget: "any", fomo_prefs_done: true };
  const prefs = parseAccountPrefs(meta);
  assert.equal(prefs?.kids, true);
  assert.equal(prefs?.residents, true);
  assert.equal(prefs?.status, "working");
  assert.deepEqual(whoFromPrefs(prefs!), who);
});

test("an account whose fomo_who has families but no fomo_kids yet still reads as kids; fomo_kids false wins", () => {
  assert.equal(parseAccountPrefs({ fomo_status: "other", fomo_who: ["families"] })?.kids, true);
  assert.equal(parseAccountPrefs({ fomo_status: "other", fomo_who: ["families"], fomo_kids: false })?.kids, false);
  assert.equal(parseAccountPrefs({ fomo_kids: true })?.kids, true);
  assert.equal(parseAccountPrefs({ fomo_status: "other" })?.kids, false);
});
