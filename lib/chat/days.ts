/**
 * Which days an Ask Fomo catalogue item is on, so the model can match a
 * "this weekend" or "Friday" question to things that actually run then, and
 * the route can drop cards that don't.
 *
 * Days are local "YYYY-MM-DD" strings (see lib/happenings/occurrence.ts).
 * `null` means every day: an "always" offer has no day pattern to check.
 */
import { CITY } from "@/lib/city";
import { addDays, localDayDate, nextOccurrences, normalizeRecurrence, weekdayOf } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";

export type DaysOn = Set<string> | null;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The local days in the window, today first. */
export function windowDays(now: Date, days: number, timeZone: string = CITY.timezone): string[] {
  const today = localDayDate(now, timeZone);
  return Array.from({ length: days }, (_, i) => addDays(today, i));
}

/** Every local day in [first, last] that falls inside the window. */
function spanInWindow(first: string, last: string, window: string[]): string[] {
  return window.filter((d) => first <= d && d <= last);
}

/** The window days a happening is on, or null when it's an every-day offer. */
export function happeningDaysOn(
  h: Pick<Happening, "id" | "starts_at" | "ends_at" | "recurrence" | "status">,
  window: string[],
  timeZone: string = CITY.timezone
): DaysOn {
  if (normalizeRecurrence(h.recurrence).type === "always") return null;
  const from = new Date(`${window[0]}T12:00:00Z`);
  const to = new Date(`${window[window.length - 1]}T12:00:00Z`);
  const days = new Set<string>();
  for (const occ of nextOccurrences(h, from, to, timeZone)) {
    for (const d of spanInWindow(occ.dayDate, occ.lastDayDate, window)) days.add(d);
  }
  return days;
}

/** The window days an event is on: its start day through its end day. */
export function eventDaysOn(startsAt: string, endsAt: string | null, window: string[], timeZone: string = CITY.timezone): DaysOn {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return new Set();
  const end = endsAt ? new Date(endsAt) : null;
  const first = localDayDate(start, timeZone);
  const last = end && !Number.isNaN(end.getTime()) && end > start ? localDayDate(end, timeZone) : first;
  return new Set(spanInWindow(first, last, window));
}

/** "Thu 8 Oct" for a local day string. */
export function shortDay(dayDate: string): string {
  const [, m, d] = dayDate.split("-").map(Number);
  return `${WEEKDAY_SHORT[weekdayOf(dayDate)]} ${d} ${MONTH_SHORT[m - 1]}`;
}

/** The catalogue's "on" field: "every day", or the days it runs, e.g. "Thu 8, Fri 9". */
export function daysOnLabel(days: DaysOn, window: string[]): string {
  if (days === null || window.every((d) => days.has(d))) return "every day";
  const on = window.filter((d) => days.has(d));
  if (on.length === 0) return "not in the next week";
  return on.map((d) => `${WEEKDAY_SHORT[weekdayOf(d)]} ${Number(d.slice(8))}`).join(", ");
}

/** The prompt's date key, so the model can turn "Friday" into a date: "Wed 7 Oct (today) = 2026-10-07, ...". */
export function dateKeyLine(window: string[]): string {
  return window.map((d, i) => `${shortDay(d)}${i === 0 ? " (today)" : ""} = ${d}`).join(", ");
}

/** The valid "YYYY-MM-DD" strings from a model-supplied `dates` argument. */
export function parseDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && DAY_DATE.test(v.trim())).map((v) => v.trim());
}

/** Whether an item is on any of the asked-for dates. No dates asked, or an every-day item, always passes. */
export function isOnAnyDate(days: DaysOn, dates: string[]): boolean {
  if (dates.length === 0 || days === null) return true;
  return dates.some((d) => days.has(d));
}
