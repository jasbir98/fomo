import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateKeyLine,
  daysOnLabel,
  eventDaysOn,
  happeningDaysOn,
  isOnAnyDate,
  parseDates,
  windowDays,
} from "@/lib/chat/days";
import type { Recurrence } from "@/lib/happenings/types";

// Wed 7 Oct 2026, mid-afternoon in Edinburgh.
const NOW = new Date("2026-10-07T14:00:00Z");
const WINDOW = windowDays(NOW, 7);
const row = (recurrence: Recurrence, starts_at: string | null = null, ends_at: string | null = null) => ({
  id: "h1",
  starts_at,
  ends_at,
  recurrence,
  status: "live" as const,
});

test("window runs today plus six days", () => {
  assert.deepEqual(WINDOW, ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]);
  assert.match(dateKeyLine(WINDOW), /^Wed 7 Oct \(today\) = 2026-10-07, Thu 8 Oct = 2026-10-08/);
});

test("a Mon-Thu deal is not on at the weekend", () => {
  const days = happeningDaysOn(row({ type: "weekly", days: [1, 2, 3, 4] }), WINDOW);
  assert.equal(daysOnLabel(days, WINDOW), "Wed 7, Thu 8, Mon 12, Tue 13");
  assert.equal(isOnAnyDate(days, ["2026-10-10", "2026-10-11"]), false);
  assert.equal(isOnAnyDate(days, ["2026-10-08"]), true);
});

test("an always-on offer counts as every day", () => {
  const days = happeningDaysOn(row({ type: "always" }), WINDOW);
  assert.equal(days, null);
  assert.equal(daysOnLabel(days, WINDOW), "every day");
  assert.equal(isOnAnyDate(days, ["2026-10-10"]), true);
});

test("a long exhibition covers every day of the window", () => {
  const days = happeningDaysOn(row({ type: "once" }, "2026-06-27T00:00:00Z", "2027-05-16T00:00:00Z"), WINDOW);
  assert.equal(daysOnLabel(days, WINDOW), "every day");
});

test("specific dates only count inside the window", () => {
  const days = happeningDaysOn(row({ type: "dates", dates: ["2026-10-09", "2026-10-31"] }), WINDOW);
  assert.equal(daysOnLabel(days, WINDOW), "Fri 9");
});

test("an event is on its own day only", () => {
  const days = eventDaysOn("2026-10-09T19:30:00Z", null, WINDOW);
  assert.equal(daysOnLabel(days, WINDOW), "Fri 9");
  assert.equal(isOnAnyDate(days, ["2026-10-10", "2026-10-11"]), false);
  assert.equal(daysOnLabel(eventDaysOn("2026-11-01T19:00:00Z", null, WINDOW), WINDOW), "not in the next week");
});

test("no dates asked means no filtering; junk dates are ignored", () => {
  assert.equal(isOnAnyDate(new Set(["2026-10-08"]), []), true);
  assert.deepEqual(parseDates(["2026-10-10", "Saturday", 5, " 2026-10-11 "]), ["2026-10-10", "2026-10-11"]);
  assert.deepEqual(parseDates("2026-10-10"), []);
});
