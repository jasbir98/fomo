// Run: npx tsx --test lib/personalise/freshness.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import { MAX_LOOKBACK_MS, cutoffFromLastVisit, isNewSince, londonDayKey, rotateDaily } from "./freshness";

const NOW = Date.parse("2026-10-12T18:00:00Z");

function hap(id: string, created_at: string | null): FeedCardData {
  return { kind: "happening", happening: { id, created_at } as unknown as Happening, occurrence: {} as never };
}

test("first visit and nonsense values have no cutoff", () => {
  assert.equal(cutoffFromLastVisit(null, NOW), null);
  assert.equal(cutoffFromLastVisit(Number.NaN, NOW), null);
  assert.equal(cutoffFromLastVisit(NOW + 1000, NOW), null);
});

test("a long absence is clamped to the lookback window", () => {
  const twoMonthsAgo = NOW - 60 * 24 * 60 * 60 * 1000;
  assert.equal(cutoffFromLastVisit(twoMonthsAgo, NOW), NOW - MAX_LOOKBACK_MS);
  const yesterday = NOW - 24 * 60 * 60 * 1000;
  assert.equal(cutoffFromLastVisit(yesterday, NOW), yesterday);
});

test("only rows created after the cutoff are new", () => {
  const cutoff = Date.parse("2026-10-11T12:00:00Z");
  assert.equal(isNewSince(hap("a", "2026-10-12T14:00:00Z"), cutoff), true);
  assert.equal(isNewSince(hap("b", "2026-10-10T09:00:00Z"), cutoff), false);
  assert.equal(isNewSince(hap("c", null), cutoff), false);
  assert.equal(isNewSince(hap("a", "2026-10-12T14:00:00Z"), null), false);
  const event: FeedCardData = { kind: "event", event: { id: "e", created_at: "2026-10-12T00:00:00Z" } as unknown as EventItem };
  assert.equal(isNewSince(event, cutoff), true);
});

test("daily rotation keeps the set, is stable within a day and changes across days", () => {
  const cards = Array.from({ length: 12 }, (_, i) => hap(`id-${i}`, null));
  const day1 = rotateDaily(cards, "2026-10-12");
  assert.deepEqual(new Set(day1), new Set(cards));
  assert.deepEqual(rotateDaily(cards, "2026-10-12"), day1);
  assert.notDeepEqual(rotateDaily(cards, "2026-10-13"), day1);
  // Removing one card doesn't reorder the rest.
  const without = rotateDaily(cards.filter((c) => c !== day1[3]), "2026-10-12");
  assert.deepEqual(without, day1.filter((c) => c !== day1[3]));
});

test("day key follows Edinburgh time, not UTC", () => {
  // 23:30 UTC on 12 Oct is 00:30 BST on 13 Oct.
  assert.equal(londonDayKey(new Date("2026-10-12T23:30:00Z")), "2026-10-13");
});
