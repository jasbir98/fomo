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

test("weekly tier still comes before dated and always deals", () => {
  const weekly = card("Chain Weekly", { venue_name: "ASK Italian", saving_label: "10% off", recurrence: MON_TO_THU });
  const dated = card("Dated", { saving_label: "50% off", starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-11-30T00:00:00Z", recurrence: { type: "once" } });
  const always = card("Always", { saving_label: "50% off" });
  assert.deepEqual(ids(todaysDeals(section(always, dated, weekly), at)), ["Chain Weekly", "Dated", "Always"]);
});

test("dated tier: ending within 2 days first, then by steal score", () => {
  const soonWeak = card("Soon Weak", { saving_label: "10% off", starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-10-27T23:00:00Z", recurrence: { type: "once" } });
  const laterStrong = card("Later Strong", { saving_label: "60% off", starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-12-30T00:00:00Z", recurrence: { type: "once" } });
  const laterWeak = card("Later Weak", { saving_label: "15% off", starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-12-30T00:00:00Z", recurrence: { type: "once" } });
  const weekly = card("Weekly", { saving_label: "5% off", recurrence: MON });
  const out = ids(todaysDeals(section(laterWeak, soonWeak, laterStrong, weekly), at));
  assert.deepEqual(out.slice(1), ["Soon Weak", "Later Strong", "Later Weak"]);
});

test("eligible deals still rank first within a tier", () => {
  const strong = card("Strong", { saving_label: "50% off", recurrence: MON });
  const studentWeak = card("Student Weak", { saving_label: "10% off", eligibility: "student", recurrence: MON_TO_THU });
  const rest = card("Rest", { saving_label: "20% off", recurrence: MON });
  assert.deepEqual(ids(todaysDeals(section(strong, rest, studentWeak), at, { who: ["students"] })), ["Student Weak", "Strong", "Rest"]);
});
