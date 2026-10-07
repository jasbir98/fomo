/**
 * Reads the valid hours out of an offer's free-text time note, so Ask Fomo
 * can hide an offer that isn't valid at the time someone asked about
 * ("Fri–Sat (1–4pm)" is no good for Friday night).
 *
 * Conservative on purpose: anything it can't read counts as "no restriction",
 * so a note we can't parse never hides a good answer.
 */
import type { Weekday } from "@/lib/happenings/types";

/** Minutes after midnight, [start, end). End may pass 24:00 for late finishes. */
export type Span = [number, number];
/** Weekday (0 = Sunday) → the spans it's valid. A weekday not in the map is unknown. */
export type WeekHours = Map<Weekday, Span[]>;

const DAY_NAMES: Record<string, Weekday> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ALL_DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

const DAY = "(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?";
const TIME = "(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?";
const TOKEN = new RegExp(
  [
    `(?<range>${DAY}\\s*(?:-|–|—|to)\\s*${DAY})`,
    `(?<every>\\b(?:daily|every ?day|7 days)\\b)`,
    `(?<weekdays>\\bweekdays\\b)`,
    `(?<weekends>\\bweekends?\\b)`,
    `(?<day>\\b${DAY})`,
    `(?<time>${TIME}\\s*(?:-|–|—|to|until|till)\\s*${TIME})`,
  ].join("|"),
  "gi"
);

function dayRange(from: Weekday, to: Weekday): Weekday[] {
  const days: Weekday[] = [];
  for (let d = from; ; d = ((d + 1) % 7) as Weekday) {
    days.push(d);
    if (d === to || days.length > 7) break;
  }
  return days;
}

function toMinutes(h: number, m: number, meridiem: string | undefined): number {
  let hour = h % 12;
  if (meridiem === "pm") hour += 12;
  if (!meridiem) hour = h; // 24-hour clock
  return hour * 60 + m;
}

/** "4–9pm" → [16:00, 21:00); "11–3pm" → [11:00, 15:00); "17:00–19:00" as written. */
function parseSpan(groups: string[]): Span | null {
  const [sh, sm, smer, eh, em, emer] = groups;
  const startH = Number(sh);
  const endH = Number(eh);
  if (!Number.isFinite(startH) || !Number.isFinite(endH) || startH > 24 || endH > 24) return null;
  const endMer = emer?.toLowerCase();
  let startMer = smer?.toLowerCase();
  // "4–9pm": the start shares the end's am/pm, unless that would put it after the end ("11–3pm").
  if (!startMer && endMer) {
    startMer = endMer;
    if (toMinutes(startH, Number(sm ?? 0), startMer) > toMinutes(endH, Number(em ?? 0), endMer)) startMer = "am";
  }
  // Bare "1–4" is as likely a date range as a time; needs am/pm or a 24-hour "17:00".
  if (!startMer && !endMer && sm === undefined && em === undefined) return null;
  const start = toMinutes(startH, Number(sm ?? 0), startMer);
  let end = toMinutes(endH, Number(em ?? 0), endMer);
  if (end <= start) end += 24 * 60; // runs past midnight
  return [start, end];
}

/** The hours in a time note, or null when it states none we can read. */
export function parseWeekHours(timeNote: string | null | undefined): WeekHours | null {
  if (!timeNote) return null;
  const hours: WeekHours = new Map();
  let pending: Weekday[] = [];
  let sawDays = false;
  const unassigned: Span[] = [];
  for (const match of timeNote.matchAll(TOKEN)) {
    const g = match.groups ?? {};
    if (g.range || g.every || g.weekdays || g.weekends || g.day) sawDays = true;
    if (g.range) {
      const [a, b] = g.range.toLowerCase().match(/sun|mon|tue|wed|thu|fri|sat/g) ?? [];
      if (a && b) pending.push(...dayRange(DAY_NAMES[a], DAY_NAMES[b]));
    } else if (g.every) pending.push(...ALL_DAYS);
    else if (g.weekdays) pending.push(1, 2, 3, 4, 5);
    else if (g.weekends) pending.push(0, 6);
    else if (g.day) pending.push(DAY_NAMES[g.day.slice(0, 3).toLowerCase()]);
    else if (g.time) {
      const span = parseSpan(match.slice(-6)); // the time alternative's six groups come last
      if (!span) continue;
      if (pending.length === 0) {
        unassigned.push(span);
        continue;
      }
      for (const d of new Set(pending)) hours.set(d, [...(hours.get(d) ?? []), span]);
      pending = [];
    }
  }
  // A time with no day before it ("12–3pm") applies every day, but only when the note names no days at all.
  if (!sawDays && unassigned.length > 0) for (const d of ALL_DAYS) hours.set(d, unassigned);
  return hours.size > 0 ? hours : null;
}

/** "HH:MM" → minutes, or null. "24:00" is allowed as an end. */
export function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins <= 24 * 60 ? mins : null;
}

/**
 * Whether an offer is valid at some point in [from, to) on that weekday.
 * Unknown hours (no parse, or that weekday not mentioned) count as valid.
 */
export function isValidAt(hours: WeekHours | null, weekday: Weekday, from: number, to: number): boolean {
  const spans = hours?.get(weekday);
  if (!spans) return true;
  return spans.some(([s, e]) => s < to && e > from);
}
