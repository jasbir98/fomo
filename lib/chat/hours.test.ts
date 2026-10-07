import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidAt, parseClock, parseWeekHours } from "@/lib/chat/hours";

const at = (hh: number, mm = 0) => hh * 60 + mm;
const EVENING: [number, number] = [at(17), at(24)];

test("Bar 50's voucher: weekday evenings, Friday afternoon only", () => {
  const h = parseWeekHours("Valid Mon–Thu (4–9pm), Fri–Sat (1–4pm), Sun (1–9pm). Voucher bookings until 30 September 2026.");
  assert.deepEqual(h?.get(1), [[at(16), at(21)]]);
  assert.deepEqual(h?.get(5), [[at(13), at(16)]]);
  assert.deepEqual(h?.get(0), [[at(13), at(21)]]);
  assert.equal(isValidAt(h, 5, ...EVENING), false); // Friday night
  assert.equal(isValidAt(h, 4, ...EVENING), true); // Thursday night
  assert.equal(isValidAt(h, 5, at(12), at(17)), true); // Friday afternoon
});

test("am/pm inference and 24-hour times", () => {
  assert.deepEqual(parseWeekHours("Daily 11–3pm")?.get(2), [[at(11), at(15)]]);
  assert.deepEqual(parseWeekHours("Weekdays 10am-2pm")?.get(1), [[at(10), at(14)]]);
  assert.equal(parseWeekHours("Weekdays 10am-2pm")?.get(6), undefined);
  assert.deepEqual(parseWeekHours("Sat 17:00–19:30")?.get(6), [[at(17), at(19, 30)]]);
  assert.deepEqual(parseWeekHours("Fri 9pm–2am")?.get(5), [[at(21), at(26)]]);
});

test("a time with no days applies every day", () => {
  const h = parseWeekHours("12–3pm, while stocks last");
  assert.equal(h?.size, 7);
  assert.equal(isValidAt(h, 6, ...EVENING), false);
});

test("anything unreadable is no restriction", () => {
  assert.equal(parseWeekHours(null), null);
  assert.equal(parseWeekHours("All day, every day"), null);
  assert.equal(parseWeekHours("Runs 1–4 October"), null); // a date range, not hours
  assert.equal(isValidAt(null, 5, ...EVENING), true);
  assert.equal(isValidAt(parseWeekHours("Mon–Thu 4–9pm"), 5, ...EVENING), true); // Friday not mentioned
});

test("clock strings", () => {
  assert.equal(parseClock("17:00"), at(17));
  assert.equal(parseClock("24:00"), at(24));
  assert.equal(parseClock("5pm"), null);
});
