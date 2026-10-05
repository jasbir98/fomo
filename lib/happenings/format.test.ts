import { test } from "node:test";
import assert from "node:assert/strict";
import { savingBadgeLabel, weekdaySummaryLabel, happeningDayLabel, happeningLiveUntilLabel, happeningTimeLabel } from "@/lib/happenings/format";
import { occurrenceIsLive } from "@/lib/happenings/occurrence";
import type { Occurrence } from "@/lib/happenings/types";

const TZ = "Europe/London";
// Tue 29 Sep 2026, 14:00 BST (13:00Z).
const NOW = new Date("2026-09-29T13:00:00Z");

function occ(over: Partial<Occurrence>): Occurrence {
  return {
    happeningId: "h1",
    dayDate: "2026-09-29",
    lastDayDate: over.dayDate ?? "2026-09-29",
    seriesEndDayDate: null,
    exact: true,
    startsAt: null,
    endsAt: null,
    ...over,
  };
}

test("happeningTimeLabel: days beyond tomorrow carry weekday, day number and month", () => {
  const o = occ({ dayDate: "2026-10-03", startsAt: "2026-10-03T18:00:00Z" }); // 19:00 BST
  assert.equal(happeningTimeLabel(o, NOW, TZ), "Sat 3 Oct 7pm");
});

test("happeningTimeLabel: date-only row beyond tomorrow is just the day", () => {
  const o = occ({ dayDate: "2026-10-03", startsAt: "2026-10-03T00:00:00Z" });
  assert.equal(happeningTimeLabel(o, NOW, TZ), "Sat 3 Oct");
});

test("happeningTimeLabel: today/tomorrow keep their words", () => {
  assert.equal(happeningTimeLabel(occ({ startsAt: "2026-09-29T18:30:00Z" }), NOW, TZ), "Tonight 7:30pm");
  assert.equal(
    happeningTimeLabel(occ({ dayDate: "2026-09-30", startsAt: "2026-09-30T10:00:00Z" }), NOW, TZ),
    "Tomorrow 11am"
  );
});

test("happeningDayLabel: fallback for occurrences with no clock time", () => {
  assert.equal(happeningDayLabel({ dayDate: "2026-09-29" }, NOW, TZ), "Today");
  assert.equal(happeningDayLabel({ dayDate: "2026-09-30" }, NOW, TZ), "Tomorrow");
  assert.equal(happeningDayLabel({ dayDate: "2026-10-03" }, NOW, TZ), "Sat 3 Oct");
  // in-progress span floored to today by the feed
  assert.equal(happeningDayLabel({ dayDate: "2026-06-01" }, NOW, TZ), "Today");
});

test("occurrenceIsLive: exact occurrence within [start, end) or start+2h", () => {
  const started = occ({ startsAt: "2026-09-29T12:00:00Z" }); // 13:00 BST, runs to 15:00 BST
  assert.equal(occurrenceIsLive(started, NOW, TZ), true);
  const over = occ({ startsAt: "2026-09-29T10:00:00Z" }); // ended 13:00 BST
  assert.equal(occurrenceIsLive(over, NOW, TZ), false);
  const later = occ({ startsAt: "2026-09-29T17:00:00Z" });
  assert.equal(occurrenceIsLive(later, NOW, TZ), false);
  const withEnd = occ({ startsAt: "2026-09-29T09:00:00Z", endsAt: "2026-09-29T15:00:00Z" });
  assert.equal(occurrenceIsLive(withEnd, NOW, TZ), true);
});

test("occurrenceIsLive: running multi-day span, rule-derived never live", () => {
  const span = occ({
    dayDate: "2026-06-01",
    lastDayDate: "2027-05-16",
    startsAt: "2026-06-01T00:00:00Z",
    endsAt: "2027-05-16T00:00:00Z",
  });
  assert.equal(occurrenceIsLive(span, NOW, TZ), true);
  assert.equal(happeningLiveUntilLabel(span, NOW, TZ), "until 16 May 2027");
  assert.equal(occurrenceIsLive(occ({ exact: false }), NOW, TZ), false);
});

test("happeningLiveUntilLabel: end clock when same-day endsAt is known", () => {
  const o = occ({ startsAt: "2026-09-29T09:00:00Z", endsAt: "2026-09-29T15:00:00Z" });
  assert.equal(happeningLiveUntilLabel(o, NOW, TZ), "until 4pm");
  assert.equal(happeningLiveUntilLabel(occ({ startsAt: "2026-09-29T12:00:00Z" }), NOW, TZ), null);
});

test("weekdaySummaryLabel compresses weekday sets", () => {
  assert.equal(weekdaySummaryLabel([0, 1, 2, 3, 4, 5]), "Every day except Saturday");
  assert.equal(weekdaySummaryLabel([1, 2, 3, 4, 5]), "Weekdays");
  assert.equal(weekdaySummaryLabel([6, 0]), "Weekends");
  assert.equal(weekdaySummaryLabel([0, 1, 2, 3, 4, 5, 6]), "Every day");
  assert.equal(weekdaySummaryLabel([4, 1, 3, 2]), "Mon to Thu");
  assert.equal(weekdaySummaryLabel([5, 6, 0]), "Fri to Sun");
  assert.equal(weekdaySummaryLabel([1, 3, 5]), "Mon, Wed & Fri");
  assert.equal(weekdaySummaryLabel([5, 1]), "Mon & Fri");
  assert.equal(weekdaySummaryLabel([6]), "Every Saturday");
  assert.equal(weekdaySummaryLabel([1, 2, 3, 4, 5, 6]), "Every day except Sunday");
  assert.equal(weekdaySummaryLabel([]), "");
});

test("savingBadgeLabel: a long price label is a price, not a saving", () => {
  const base = { is_free: false, currency: "GBP" } as const;
  assert.equal(savingBadgeLabel({ ...base, saving_label: "£21.95 student ticket", saving_amount: 21.95 }), "£21.95");
  assert.equal(savingBadgeLabel({ ...base, saving_label: "£25 bottomless brunch", saving_amount: 25 }), "£25");
  assert.equal(savingBadgeLabel({ ...base, saving_label: "£5 off Mary King's Close", saving_amount: 5 }), "£5 off");
  assert.equal(savingBadgeLabel({ ...base, saving_label: "£1 tickets", saving_amount: 1 }), "£1 tickets");
  assert.equal(savingBadgeLabel({ ...base, saving_label: "Save up to 57%", saving_amount: 57 }), "57% off");
});
