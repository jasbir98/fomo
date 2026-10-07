// Run with `npx tsx --test lib/places/hours.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OpeningHoursPeriod } from "@/lib/types";
import { isOpenAt, localWeekday, todayHoursLabel, weekHoursLines } from "./hours";

const TZ = "Europe/London";
// 2026-10-07 is a Wednesday (day 3); BST (UTC+1) until 25 Oct, so 12:00Z = 13:00 local.
const wed = (utcTime: string) => new Date(`2026-10-07T${utcTime}Z`);
const p = (day: number, open: string, close: string): OpeningHoursPeriod => ({ day, open, close });

test("todayHoursLabel: single period, closed day, unknown", () => {
  const hours = [p(3, "10:00", "17:00"), p(4, "10:00", "17:00")];
  assert.equal(todayHoursLabel(hours, wed("12:00:00"), TZ), "Open today 10:00–17:00");
  assert.equal(todayHoursLabel([p(4, "10:00", "17:00")], wed("12:00:00"), TZ), "Closed today");
  assert.equal(todayHoursLabel(null, wed("12:00:00"), TZ), null);
  assert.equal(todayHoursLabel([], wed("12:00:00"), TZ), null);
});

test("todayHoursLabel: multiple periods and past-midnight close", () => {
  const hours = [p(3, "17:00", "01:00"), p(3, "12:00", "14:30")];
  assert.equal(todayHoursLabel(hours, wed("12:00:00"), TZ), "Open today 12:00–14:30, 17:00–01:00");
  assert.equal(todayHoursLabel([p(3, "00:00", "00:00")], wed("12:00:00"), TZ), "Open today 24 hours");
});

test("todayHoursLabel uses the venue's timezone for the day", () => {
  // 23:30Z on Wednesday is already Thursday 00:30 in London (BST).
  const hours = [p(4, "09:00", "18:00")];
  assert.equal(todayHoursLabel(hours, wed("23:30:00"), TZ), "Open today 09:00–18:00");
  assert.equal(localWeekday(wed("23:30:00"), TZ), 4);
});

test("isOpenAt: inside, outside and unknown", () => {
  const hours = [p(3, "12:00", "14:30"), p(3, "17:00", "22:00")];
  assert.equal(isOpenAt(hours, wed("12:00:00"), TZ), true); // 13:00 local
  assert.equal(isOpenAt(hours, wed("14:00:00"), TZ), false); // 15:00 local
  assert.equal(isOpenAt(hours, wed("11:00:00"), TZ), true); // 12:00 local, opens on the dot
  assert.equal(isOpenAt(hours, wed("13:30:00"), TZ), false); // 14:30 local, closes on the dot
  assert.equal(isOpenAt(null, wed("12:00:00"), TZ), null);
});

test("isOpenAt: a past-midnight close carries into the next day", () => {
  const hours = [p(3, "18:00", "01:00")];
  // Thursday 00:30 local = Wednesday 23:30Z: still Wednesday's session.
  assert.equal(isOpenAt(hours, wed("23:30:00"), TZ), true);
  // Thursday 01:30 local: closed.
  assert.equal(isOpenAt(hours, new Date("2026-10-08T00:30:00Z"), TZ), false);
  // Wednesday 17:00 local (16:00Z): not yet open.
  assert.equal(isOpenAt(hours, wed("16:00:00"), TZ), false);
});

test("weekHoursLines: Monday first, closed days filled in", () => {
  const lines = weekHoursLines([p(0, "11:00", "16:00"), p(1, "09:00", "17:00"), p(1, "19:00", "23:00")]);
  assert.equal(lines.length, 7);
  assert.deepEqual(lines[0], { day: "Monday", dayIndex: 1, text: "09:00–17:00, 19:00–23:00" });
  assert.deepEqual(lines[1], { day: "Tuesday", dayIndex: 2, text: "Closed" });
  assert.equal(lines[6].day, "Sunday");
  assert.equal(lines[6].text, "11:00–16:00");
  assert.deepEqual(weekHoursLines(null), []);
});
