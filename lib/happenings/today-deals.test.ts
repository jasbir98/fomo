// Run: npx tsx --test lib/happenings/today-deals.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening, Occurrence } from "./types";
import type { DealCardData, DealsSection } from "./feed-types";
import { todaysDeals } from "./today-deals";

// Mon 26 Oct 2026, midday London.
const at = new Date("2026-10-26T12:00:00Z");

function card(id: string, over: Partial<Happening>): DealCardData {
  const happening = {
    id,
    title: id,
    kind: "deal",
    status: "live",
    venue_name: id,
    place_id: null,
    saving_label: null,
    saving_amount: null,
    priority: 50,
    eligibility: "anyone",
    starts_at: null,
    ends_at: null,
    recurrence: { type: "always" },
    ...over,
  } as unknown as Happening;
  const occurrence = { happeningId: id, dayDate: "2026-10-26", startsAt: null, endsAt: null, lastDayDate: "2026-10-26", seriesEndDayDate: null, exact: false } as Occurrence;
  return { kind: "happening", happening, occurrence, what: "food_drink", who: null } as unknown as DealCardData;
}

function section(...singles: DealCardData[]): DealsSection {
  return { venueGroups: [], singles };
}

function ids(items: ReturnType<typeof todaysDeals>): string[] {
  return items.map((i) => (i.kind === "single" ? i.card.happening.id : `group:${i.placeName}`));
}

const MON: Happening["recurrence"] = { type: "weekly", days: [1] };
const MON_TO_THU: Happening["recurrence"] = { type: "weekly", days: [1, 2, 3, 4] };

test("weekly tier: a local Monday-only 20% deal ranks above a chain's 30% deal that runs most days", () => {
  const chain = card("ASK Italian", { saving_label: "30% off", recurrence: MON_TO_THU });
  const local = card("Biddy Mulligans", { saving_label: "20% off", recurrence: MON });
  const other = card("Local Cafe", { saving_label: "10% off", recurrence: MON_TO_THU });
  // Chain first in the input, as the old order-preserving code would have kept it.
  assert.deepEqual(ids(todaysDeals(section(chain, other, local), at)), ["Biddy Mulligans", "Local Cafe", "ASK Italian"]);
});

test("a one-day weekly deal leads over a chain's weekly deal and an always deal", () => {
  const chain = card("Chain Weekly", { venue_name: "ASK Italian", saving_label: "50% off", recurrence: MON_TO_THU });
  const always = card("Always", { saving_label: "2 for 1" });
  const monday = card("Monday Only", { saving_label: "20% off", recurrence: MON });
  assert.deepEqual(ids(todaysDeals(section(chain, always, monday), at)), ["Monday Only", "Always", "Chain Weekly"]);
});

test("lead: last chance first, then by steal score; weak deals don't lead", () => {
  const lastChance = card("Last Chance", { saving_label: "2 for 1", starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-10-27T23:00:00Z", recurrence: { type: "once" } });
  const monday = card("Monday Only", { saving_label: "60% off", recurrence: MON });
  const weakLastChance = card("Weak Last Chance", { saving_label: "5% off", starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-10-27T23:00:00Z", recurrence: { type: "once" } });
  const later = card("Later", { saving_label: "60% off", starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-12-30T00:00:00Z", recurrence: { type: "once" } });
  assert.deepEqual(ids(todaysDeals(section(weakLastChance, later, monday, lastChance), at)), ["Last Chance", "Monday Only", "Later"]);
});

test("a deal added in the last three days leads", () => {
  const old = card("Old", { saving_label: "60% off", created_at: "2026-09-01T00:00:00Z" });
  const fresh = card("Fresh", { saving_label: "25% off", created_at: "2026-10-25T09:00:00Z" });
  const other = card("Other", { saving_label: "50% off" });
  assert.deepEqual(ids(todaysDeals(section(old, other, fresh), at)), ["Fresh", "Old", "Other"]);
});

test("eligible deals still rank first within the lead and the rotation", () => {
  const strong = card("Strong", { saving_label: "50% off", recurrence: MON });
  const studentLead = card("Student Lead", { saving_label: "20% off", eligibility: "student", recurrence: MON });
  const always = card("Always", { saving_label: "60% off" });
  const studentAlways = card("Student Always", { saving_label: "30% off", eligibility: "student" });
  assert.deepEqual(ids(todaysDeals(section(strong, studentLead, always, studentAlways), at, { who: ["students"] })), [
    "Student Lead",
    "Strong",
    "Student Always",
    "Always",
  ]);
});

test("the rotation shows different good deals on consecutive days and covers the pool", () => {
  const pool = Array.from({ length: 40 }, (_, i) => card(`Deal ${i}`, { saving_label: "2 for 1" }));
  const chain = card("Chain", { venue_name: "Greggs", saving_label: "10% off" });
  // 40 good deals, 5 a day: an 8-day cycle. 2026-10-26 is day 20,752, so a lap starts on 2026-10-26 (20,752 = 8 × 2,594).
  const days = Array.from({ length: 24 }, (_, d) => ids(todaysDeals(section(chain, ...pool), new Date(at.getTime() + d * 86_400_000), { limit: 5 })));
  for (const day of days) {
    assert.equal(day.length, 5);
    assert.ok(!day.includes("Chain"));
  }
  const firstLap = days.slice(0, 8);
  for (let d = 1; d < firstLap.length; d++) assert.equal(firstLap[d].filter((id) => firstLap[d - 1].includes(id)).length, 0);
  assert.ok(new Set(firstLap.flat()).size >= 32);
  assert.equal(new Set(days.flat()).size, 40);
});

test("the same day gives the same deals", () => {
  const pool = Array.from({ length: 30 }, (_, i) => card(`Deal ${i}`, { saving_label: "2 for 1" }));
  const later = new Date("2026-10-26T21:00:00Z");
  assert.deepEqual(ids(todaysDeals(section(...pool), at)).sort(), ids(todaysDeals(section(...pool.reverse()), later)).sort());
});
