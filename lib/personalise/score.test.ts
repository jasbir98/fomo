// Run: npx tsx --test lib/personalise/score.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening } from "@/lib/happenings/types";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import { kidsBoost, personalBoost, type BoostPrefs } from "./score";

function card(over: Partial<Happening>): FeedCardData {
  const h = {
    id: "h",
    title: "H",
    kind: "event",
    category: "comedy",
    eligibility: "anyone",
    is_free: false,
    recurrence: { type: "once" },
    ...over,
  } as unknown as Happening;
  return {
    kind: "happening",
    happening: h,
    occurrence: { happeningId: "h", dayDate: "2026-10-14", startsAt: null, endsAt: null, lastDayDate: "2026-10-14", seriesEndDayDate: "2026-10-14", exact: true },
  };
}

const base: BoostPrefs = { interests: [], budget: "any", who: [] };

test("kids pref boosts kid-friendly cards, kids above all_ages, and only when on", () => {
  const kids = card({ family_fit: "kids" });
  const allAges = card({ family_fit: "all_ages" });
  const plain = card({});
  const on: BoostPrefs = { ...base, kids: true };
  assert.equal(personalBoost(plain, on), 0);
  assert.ok(personalBoost(kids, on) > personalBoost(allAges, on));
  assert.ok(personalBoost(allAges, on) > 0);
  assert.equal(personalBoost(kids, base), 0);
  assert.equal(personalBoost(kids, { ...base, kids: false }), 0);
});

test("kids boost is comparable to an interest match", () => {
  assert.equal(kidsBoost(card({ family_fit: "kids" })), 4);
  assert.equal(personalBoost(card({ family_fit: "kids", category: "comedy" }), { ...base, interests: ["comedy"] }), 4);
});

test("category family and family-only offers count as kids", () => {
  const on: BoostPrefs = { ...base, kids: true };
  assert.ok(personalBoost(card({ category: "family" }), on) >= 4);
  assert.ok(personalBoost(card({ eligibility: "family" }), on) >= 4);
});
