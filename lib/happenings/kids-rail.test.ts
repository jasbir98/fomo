// Run with `npx tsx --test lib/happenings/kids-rail.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeedBucket, FeedCardData, FeedResponse } from "@/lib/happenings/feed-types";
import type { Happening, Occurrence } from "@/lib/happenings/types";
import { happening, NOW } from "@/lib/finds/fixtures.test-util";
import { KIDS_RAIL_MAX, kidsRailCards } from "./kids-rail";

const WEEKEND = { saturday: "2026-10-17", sunday: "2026-10-18" };

function card(id: string, dayDate: string, over: Partial<Happening> = {}): FeedCardData {
  const h = happening({ id, kind: "activity", ...over });
  const occurrence: Occurrence = {
    happeningId: id,
    dayDate,
    startsAt: null,
    endsAt: null,
    lastDayDate: dayDate,
    seriesEndDayDate: dayDate,
    exact: true,
  };
  return { kind: "happening", happening: h, occurrence };
}

function feed(cards: FeedCardData[], anyDay: FeedCardData[] = []): FeedResponse {
  const bucket = (c: FeedCardData[]): FeedBucket => ({ cards: c }) as unknown as FeedBucket;
  return { whatsOn: [bucket(cards)], anyDay: bucket(anyDay) } as unknown as FeedResponse;
}

test("keeps only kid-friendly cards from today, the weekend and Any day, once each", () => {
  const today = card("t1", "2026-10-14", { family_fit: "kids" });
  const todayPlain = card("t2", "2026-10-14");
  const sat = card("s1", "2026-10-17", { category: "family" });
  const midweek = card("m1", "2026-10-15", { family_fit: "kids" });
  const always = card("a1", "2026-10-14", { family_fit: "all_ages" });
  const out = kidsRailCards(feed([today, todayPlain], [always, today]), feed([midweek, sat]), WEEKEND, [], NOW, "Europe/London");
  assert.deepEqual(out.map((c) => (c.kind === "happening" ? c.happening.id : "")).sort(), ["a1", "s1", "t1"]);
});

test("without the Coming up window, the weekend falls back to what Today holds", () => {
  const sat = card("s1", "2026-10-17", { family_fit: "kids" });
  const out = kidsRailCards(feed([sat]), undefined, WEEKEND, [], NOW, "Europe/London");
  assert.equal(out.length, 1);
});

test("capped at the rail maximum; empty with no Today feed", () => {
  const many = Array.from({ length: 14 }, (_, i) => card(`k${i}`, "2026-10-14", { family_fit: "kids" }));
  assert.equal(kidsRailCards(feed(many), null, WEEKEND, [], NOW, "Europe/London").length, KIDS_RAIL_MAX);
  assert.deepEqual(kidsRailCards(null, null, WEEKEND), []);
});
