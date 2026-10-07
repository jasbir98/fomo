/**
 * Opening-hours helpers for `places.opening_hours` — pure, no I/O. The jsonb is
 * [{ day: 0-6 (0 = Sunday), open: "HH:MM", close: "HH:MM" }], several periods
 * per day allowed (lunch + dinner), `close` at or before `open` meaning it
 * runs past midnight into the next day ("17:00"–"01:00"). No `server-only`:
 * the place detail page (a client component) and the chat route both use it.
 */
import type { OpeningHoursPeriod } from "@/lib/types";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const DAY_MINUTES = 24 * 60;

/** "HH:MM" → minutes since midnight, or null if malformed. */
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Local weekday (0 = Sunday) and minutes since local midnight in `timeZone`. */
function localDayAndMinutes(date: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: WEEKDAY_INDEX[get("weekday")] ?? 0,
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

interface Span {
  open: number;
  /** Minutes from midnight of the period's own day; > 1440 when it runs past midnight. */
  close: number;
  openLabel: string;
  closeLabel: string;
}

function periodsOn(hours: OpeningHoursPeriod[], day: number): Span[] {
  const spans: Span[] = [];
  for (const p of hours) {
    if (p.day !== day) continue;
    const open = toMinutes(p.open);
    const close = toMinutes(p.close);
    if (open == null || close == null) continue;
    // close <= open: wraps past midnight (open == close reads as all day).
    spans.push({ open, close: close <= open ? close + DAY_MINUTES : close, openLabel: p.open, closeLabel: p.close });
  }
  return spans.sort((a, b) => a.open - b.open);
}

function spanLabel(s: Span): string {
  return s.openLabel === s.closeLabel ? "24 hours" : `${s.openLabel}–${s.closeLabel}`;
}

/** "Open today 10:00–17:00" / "Open today 12:00–14:30, 17:00–22:00" / "Closed today"; null when the hours are unknown (no data). */
export function todayHoursLabel(
  hours: OpeningHoursPeriod[] | null | undefined,
  now: Date,
  timeZone: string
): string | null {
  if (!hours || hours.length === 0) return null;
  const { day } = localDayAndMinutes(now, timeZone);
  const spans = periodsOn(hours, day);
  if (spans.length === 0) return "Closed today";
  if (spans.length === 1 && spans[0].openLabel === spans[0].closeLabel) return "Open today 24 hours";
  return `Open today ${spans.map(spanLabel).join(", ")}`;
}

/** Whether the place is open at `date`; null when the hours are unknown. Counts a late close carried over from the previous day. */
export function isOpenAt(
  hours: OpeningHoursPeriod[] | null | undefined,
  date: Date,
  timeZone: string
): boolean | null {
  if (!hours || hours.length === 0) return null;
  const { day, minutes } = localDayAndMinutes(date, timeZone);
  if (periodsOn(hours, day).some((s) => minutes >= s.open && minutes < s.close)) return true;
  const yesterday = (day + 6) % 7;
  return periodsOn(hours, yesterday).some((s) => minutes + DAY_MINUTES < s.close);
}

/** One line per day, Monday first, for the expandable week: { day: "Monday", text: "10:00–17:00" | "Closed" }. Empty when the hours are unknown. */
export function weekHoursLines(
  hours: OpeningHoursPeriod[] | null | undefined
): { day: string; dayIndex: number; text: string }[] {
  if (!hours || hours.length === 0) return [];
  return [1, 2, 3, 4, 5, 6, 0].map((dayIndex) => {
    const spans = periodsOn(hours, dayIndex);
    return {
      day: DAY_NAMES[dayIndex],
      dayIndex,
      text: spans.length === 0 ? "Closed" : spans.map(spanLabel).join(", "),
    };
  });
}

/** Today's local weekday index (0 = Sunday) in `timeZone`, to highlight a row in the week list. */
export function localWeekday(now: Date, timeZone: string): number {
  return localDayAndMinutes(now, timeZone).day;
}
