/**
 * Week helpers for "Under the radar". A featured pick is keyed by the Monday
 * (YYYY-MM-DD, Europe/London) of its week, so "this week's pick" is an exact
 * match on that string. Pure; scripts/lib/weekly-picks.mjs keeps a port.
 */
import { addDays, localDayDate, weekdayOf } from "@/lib/happenings/occurrence";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isDayDate(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The Monday on or before a day string. */
export function mondayOf(dayDate: string): string {
  const back = (weekdayOf(dayDate) + 6) % 7; // Monday 0 ... Sunday 6
  return addDays(dayDate, -back);
}

/** The Monday of the week an instant falls in, in the city's zone. */
export function currentWeekStart(now: Date): string {
  return mondayOf(localDayDate(now));
}
