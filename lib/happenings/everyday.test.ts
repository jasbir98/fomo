// Run: npx tsx --test lib/happenings/everyday.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening, Recurrence } from "./types";
import type { FeedCardData, HappeningCardData, RecurringCardData } from "./feed-types";
import { everydayCardRunsOn, isEverydayCard, isEverydayRecurrence } from "./everyday";

const ctx = { windowStartDay: "2026-09-30" };

function hap(recurrence: Recurrence, kind: Happening["kind"] = "tour", id = "h1"): Happening {
  return { id, title: "T", kind, recurrence } as unknown as Happening;
}
function card(h: Happening): HappeningCardData {
  return { kind: "happening", happening: h, occurrence: { dayDate: "2026-09-30" } as never };
}
function recurring(dates: string[]): RecurringCardData {
  return { kind: "recurring", key: "k", title: "Comedy", lead: card(hap({ type: "once" }, "event")), dates };
}

test("always is everyday", () => {
  assert.equal(isEverydayCard(card(hap({ type: "always" })), ctx), true);
});
test("weekly on 7 days is everyday, 5 days too", () => {
  assert.equal(isEverydayCard(card(hap({ type: "weekly", days: [0, 1, 2, 3, 4, 5, 6] })), ctx), true);
  assert.equal(isEverydayCard(card(hap({ type: "weekly", days: [1, 2, 3, 4, 5] })), ctx), true);
});
test("weekly on 4 days or 1 day is not everyday", () => {
  assert.equal(isEverydayCard(card(hap({ type: "weekly", days: [1, 2, 3, 4] })), ctx), false);
  assert.equal(isEverydayCard(card(hap({ type: "weekly", days: [1] }, "activity")), ctx), false);
});
test("once / dates / annual are never everyday", () => {
  assert.equal(isEverydayCard(card(hap({ type: "once" })), ctx), false);
  assert.equal(isEverydayCard(card(hap({ type: "dates", dates: ["2026-09-30"] })), ctx), false);
  assert.equal(isEverydayCard(card(hap({ type: "annual", month: 9, day: 30 })), ctx), false);
});
test("festival is never everyday", () => {
  assert.equal(isEverydayCard(card(hap({ type: "always" }, "festival")), ctx), false);
  assert.equal(isEverydayCard(card(hap({ type: "weekly", days: [0, 1, 2, 3, 4, 5, 6] }, "festival")), ctx), false);
});
test("recurring card: 6 dates in first 7 days yes; 4 no; far-off dates don't count", () => {
  const six = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];
  assert.equal(isEverydayCard(recurring(six), ctx), true);
  assert.equal(isEverydayCard(recurring(six.slice(0, 4)), ctx), false);
  assert.equal(isEverydayCard(recurring([...six.slice(0, 3), "2026-11-01", "2026-11-02", "2026-11-03"]), ctx), false);
});
test("series: any member can qualify", () => {
  const lead = hap({ type: "weekly", days: [1] }, "activity", "a");
  const daily = hap({ type: "always" }, "activity", "b");
  const series: FeedCardData = { kind: "series", key: "s", title: "S", lead, locationCount: 2, occurrence: {} as never };
  assert.equal(isEverydayCard(series, ctx), false);
  assert.equal(isEverydayCard(series, { ...ctx, seriesMembers: () => [lead, daily] }), true);
});
test("provider event is not everyday", () => {
  assert.equal(isEverydayCard({ kind: "event", event: {} as never }, ctx), false);
});
test("everydayCardRunsOn: weekday-only item does not run on a Saturday", () => {
  const weekdays = card(hap({ type: "weekly", days: [1, 2, 3, 4, 5] }));
  assert.equal(everydayCardRunsOn(weekdays, "2026-09-29"), true); // Tuesday
  assert.equal(everydayCardRunsOn(weekdays, "2026-10-03"), false); // Saturday
  assert.equal(everydayCardRunsOn(card(hap({ type: "always" })), "2026-10-03"), true);
  assert.equal(everydayCardRunsOn(recurring([]), "2026-09-29"), false);
});
test("isEverydayRecurrence tolerates junk", () => {
  assert.equal(isEverydayRecurrence(null), false);
  assert.equal(isEverydayRecurrence({ type: "weekly", days: [] }), false);
});
