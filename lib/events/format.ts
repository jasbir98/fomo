// Client-safe event formatting helpers — imported by both the /api/events
// route (indirectly, via shared logic) and Phase 2's UI components. This
// file deliberately has NO `import "server-only"`, unlike everything else in
// lib/events/: it runs in client components (EventCard, the /event/[id] and
// /events pages, the Home carousel).
//
// Every "what day/time is this" question below is answered in CITY.timezone
// (Europe/London), never the device's own zone — a user on holiday abroad,
// or just on a phone set to a different locale, must see the exact same
// "Tonight"/"Tomorrow" as the curated happenings feed does (lib/happenings/
// format.ts, which has always been city-zoned). The old `toLocaleTimeString
// (undefined, …)` / `Date#getFullYear()` calls here used whatever zone the
// device happened to be in instead — same class of bug lib/happenings/
// occurrence.ts's module doc warns about, just not yet fixed in this file.
import { CITY } from "@/lib/city";
import { addDays, localDayDate, weekdayOf } from "@/lib/happenings/occurrence";
import { monthShort, shortDayLabel } from "@/lib/happenings/format";
import type { Weekday } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";

/** An event with no `ends_at` is assumed to run this long — mirrors the
 *  identical default for a dateless happening occurrence (lib/happenings/
 *  occurrence.ts's `DEFAULT_OCCURRENCE_DURATION_MS`). Exported so
 *  lib/db/events.ts's query-layer "is this still running" filter uses this
 *  exact same number rather than a second, independently-tuned one — the
 *  SQL filter and `eventEffectiveEndMs` below must never disagree about
 *  what "still running" means. */
export const DEFAULT_EVENT_DURATION_MS = 2 * 60 * 60 * 1000;

/** True when `iso` is a date-only event stored as midnight UTC — a heuristic
 *  for "we don't actually know the time" (mirroring scripts/lib/describe.mjs's
 *  `isMidnightUtcSentinel`). Real UK events essentially never start at the
 *  literal top of the UTC hour with zero minutes/seconds, so this is safe. */
export function isDateOnlyStart(iso: string): boolean {
  if (typeof iso !== "string") return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

const WEEKDAY_STEMS: Record<string, Weekday> = { sun: 0, mon: 1, tues: 2, wednes: 3, thurs: 4, fri: 5, satur: 6 };
const WEEKDAY_WORD_RE = /\b(sun|mon|tues|wednes|thurs|fri|satur)days?\b/gi;
/** Named one-off days ("Black Friday", "Easter Sunday") say nothing about
 *  which weekday a run is on, so they're blanked out before matching. */
const NAMED_DAY_RE =
  /\b(?:black|good|cyber|easter|palm|ash|maundy|shrove|super|giving)\s+(?:sun|mon|tues|wednes|thurs|fri|satur)day\b/gi;

/** A date-only span that's really one night a week (see `weeklySpanOf`). Days
 *  are "YYYY-MM-DD"; `lastDay` is inclusive. */
export interface WeeklySpan {
  weekday: Weekday;
  firstDay: string;
  lastDay: string;
}

/**
 * Some imported listings are a weekly night stored as one long date-only run:
 * "Victoria Bar's Wednesday Quiz Night", 1 Sep – 30 Dec. Taken at face value
 * that's on every day, so the feed floored it into Today on a Thursday too.
 * When such a run's title names exactly one weekday ("Wednesday", "Easy
 * Sundays"), it only happens on that weekday — this returns that weekday and
 * the run's first/last day, else null. Requires a date-only start (a timed
 * row's own clock already pins it) and an end on a later day than the start
 * (a one-day row has no other days to wrongly appear on). A run that never
 * touches the named weekday at all is left alone (null): the title's day isn't
 * its schedule then. Days are read off the UTC calendar date, since these
 * rows store the bare date as midnight / 23:59:59 UTC.
 */
export function weeklySpanOf(
  e: Pick<EventItem, "starts_at" | "ends_at"> & { name?: string | null }
): WeeklySpan | null {
  if (!e.ends_at || !isDateOnlyStart(e.starts_at)) return null;
  const end = new Date(e.ends_at);
  if (Number.isNaN(end.getTime())) return null;
  const firstDay = new Date(e.starts_at).toISOString().slice(0, 10);
  const lastDay = end.toISOString().slice(0, 10);
  if (lastDay <= firstDay) return null;

  const named = new Set<Weekday>();
  for (const m of String(e.name ?? "").replace(NAMED_DAY_RE, " ").matchAll(WEEKDAY_WORD_RE)) {
    named.add(WEEKDAY_STEMS[m[1].toLowerCase()]);
  }
  if (named.size !== 1) return null;
  const [weekday] = named;
  const span = { weekday, firstDay, lastDay };
  return nextWeeklySpanDay(span, firstDay) ? span : null;
}

/** The first day on/after `fromDay` (and the run's own first day) that falls
 *  on the span's weekday, or null when the run has none left. */
export function nextWeeklySpanDay(span: WeeklySpan, fromDay: string): string | null {
  const start = fromDay > span.firstDay ? fromDay : span.firstDay;
  const day = addDays(start, (span.weekday - weekdayOf(start) + 7) % 7);
  return day <= span.lastDay ? day : null;
}

/**
 * The local day an event is next on, as of `today` — the day the feed
 * buckets and sorts it by. A run already under way counts as on today (never
 * its long-gone start day); a weekly span (see `weeklySpanOf`) is on its next
 * matching weekday instead, and null once it has none left.
 */
export function eventNextDay(
  e: Pick<EventItem, "starts_at" | "ends_at"> & { name?: string | null },
  today: string,
  timeZone: string = CITY.timezone
): string | null {
  const span = weeklySpanOf(e);
  if (span) return nextWeeklySpanDay(span, today);
  const startDay = localDayDate(new Date(e.starts_at), timeZone);
  return startDay < today ? today : startDay;
}

/** Events at/after this local hour read as "Tonight"; earlier same-day ones
 *  read as "Today". Previously ANY same-day event said "Tonight" — a 12:30
 *  lunch slot included. */
const EVENING_HOUR = 17;

/** Local hour (0-23) an instant falls on in `timeZone` — used only for the
 *  Today/Tonight cutoff above, never to pick the calendar day itself (that's
 *  `localDayDate`, which alone is DST/offset-correct). */
function localHour(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(at);
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

/**
 * The instant an event actually stops being "live" — its own `ends_at` when
 * it has one (this alone already covers a multi-day exhibition correctly,
 * since ITS `ends_at` is genuinely days later), else `starts_at` plus the
 * default duration. Exported for `lib/db/events.ts`'s query-time "is this
 * still running" filter as well as any UI that wants the same rule.
 */
export function eventEffectiveEndMs(e: Pick<EventItem, "starts_at" | "ends_at">): number {
  if (e.ends_at) {
    const t = new Date(e.ends_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const startMs = new Date(e.starts_at).getTime();
  return Number.isNaN(startMs) ? Number.NEGATIVE_INFINITY : startMs + DEFAULT_EVENT_DURATION_MS;
}

/** True while `e` is still running (or hasn't started) as of `at` — i.e. it
 *  hasn't yet reached its effective end. A malformed `starts_at` is never
 *  "live". */
export function eventIsLive(e: Pick<EventItem, "starts_at" | "ends_at">, at: Date = new Date()): boolean {
  return eventEffectiveEndMs(e) > at.getTime();
}

/** True while `e` is actually IN PROGRESS at `at` — started, and not yet at
 *  its effective end (see `eventEffectiveEndMs`). The strict "happening right
 *  now" check behind the feed's "On now" pill; `eventIsLive` alone is also
 *  true for a future event, so it can't be used for this. */
export function eventIsInProgress(
  e: Pick<EventItem, "starts_at" | "ends_at"> & { name?: string | null },
  at: Date = new Date(),
  timeZone: string = CITY.timezone
): boolean {
  const startMs = new Date(e.starts_at).getTime();
  if (Number.isNaN(startMs) || startMs > at.getTime() || !eventIsLive(e, at)) return false;
  // A date-only row (00:00 UTC, no real clock time) isn't claimed as "on now"
  // on its own first day — but one whose start day is already behind today
  // and is still live is a running span (a "1 Sep – 30 Dec" listing), on now
  // for the whole day, like an all-day happening span (occurrence.ts's
  // `occurrenceIsLive`). Without this the feed floors it into Today but its
  // card still read "Tue 1 Sep", the long-gone start date. A weekly span
  // (`weeklySpanOf`) is only on now on its own weekday.
  if (!isDateOnlyStart(e.starts_at)) return true;
  const today = localDayDate(at, timeZone);
  if (localDayDate(new Date(startMs), timeZone) >= today) return false;
  const span = weeklySpanOf(e);
  return !span || weekdayOf(today) === span.weekday;
}

/**
 * THE "has this event ended as of `at`" predicate — the events-table half of
 * the "no ended items ever leave an API" guard (see lib/happenings/
 * occurrence.ts's `happeningHasEnded` for the happenings half). Plain
 * negation of `eventIsLive`, named for symmetry at guard call sites that
 * read more naturally as "drop it if eventHasEnded" than "drop it if
 * !eventIsLive" — e.g. every list route's final in-memory filter right
 * before serialising a response.
 */
export function eventHasEnded(e: Pick<EventItem, "starts_at" | "ends_at">, at: Date = new Date()): boolean {
  return !eventIsLive(e, at);
}

/**
 * "Today"/"Tonight"/"Tomorrow" for `starts_at` relative to `now`, entirely in
 * `timeZone` — or `null` when it's neither (caller falls back to a full
 * weekday+date string). Split out from `formatEventDate` so a caller that
 * already has its own (possibly fixed-for-testing) clock — lib/happenings/
 * hero.ts's `eventRecommendationScore`, which scores against a `now` it was
 * handed, not the wall clock — can reuse the exact same cutoff instead of
 * `formatEventDate`'s own hardcoded `new Date()`.
 */
export function eventDayLabel(
  starts_at: string,
  now: Date,
  timeZone: string = CITY.timezone
): "Today" | "Tonight" | "Tomorrow" | null {
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return null;
  const eventDay = localDayDate(d, timeZone);
  const today = localDayDate(now, timeZone);
  if (eventDay === today) return localHour(d, timeZone) >= EVENING_HOUR ? "Tonight" : "Today";
  if (eventDay === addDays(today, 1)) return "Tomorrow";
  return null;
}

/** "7:30 PM" in `timeZone` (defaults to CITY.timezone) — never the device's
 *  own zone. Returns "" for date-only events (those stored as midnight UTC). */
export function formatEventTime(starts_at: string, timeZone: string = CITY.timezone): string {
  if (isDateOnlyStart(starts_at)) return "";
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
}

/**
 * "Today · 12:30 PM" / "Tonight · 7:30 PM" / "Sat 8 Aug · 8:00 PM" / "Today" (date-only).
 * `ends_at` is accepted for signature symmetry with the rest of the module (a future
 * "Tonight · 7:30–10 PM" span format could use it) but isn't rendered yet.
 */
export function formatEventWhen(
  starts_at: string,
  ends_at?: string | null,
  timeZone: string = CITY.timezone,
  now: Date = new Date()
): string {
  void ends_at;
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";
  const date = formatEventDate(starts_at, timeZone, now);
  const time = formatEventTime(starts_at, timeZone);
  return time ? `${date} · ${time}` : date;
}

/**
 * "Today", "Tonight", "Tomorrow", or "Sat 8 Aug" — just the date part
 * without the time. "Today" only for a same-day start before 5pm local;
 * 5pm-or-later reads "Tonight" (see `EVENING_HOUR`) — previously ANY
 * same-day event, including a lunchtime one, said "Tonight". Same-day/
 * tomorrow comparisons are calendar days in `timeZone`, never the device's
 * own date.
 */
export function formatEventDate(starts_at: string, timeZone: string = CITY.timezone, now: Date = new Date()): string {
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";

  const label = eventDayLabel(starts_at, now, timeZone);
  if (label) return label;

  const eventDay = localDayDate(d, timeZone);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone }).format(d);
  return `${weekday} ${Number(eventDay.slice(8, 10))} ${monthShort(eventDay)}`;
}

/**
 * A feed card's date label: `formatEventDate`, except a weekly span (see
 * `weeklySpanOf`) reads as its next matching day ("Wed 21 Oct", "Tomorrow")
 * rather than the run's long-gone first day — it's sorted under that day.
 */
export function eventDateLabel(
  e: Pick<EventItem, "starts_at" | "ends_at"> & { name?: string | null },
  now: Date = new Date(),
  timeZone: string = CITY.timezone
): string {
  const span = weeklySpanOf(e);
  const today = localDayDate(now, timeZone);
  const day = span ? nextWeeklySpanDay(span, today) : null;
  if (!day) return formatEventDate(e.starts_at, timeZone, now);
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return shortDayLabel(day);
}

/**
 * "7:30 PM" or "7:30 PM – 10:30 PM" when ends_at is present and on the same
 * (`timeZone`) calendar day. Returns "" for date-only events (no time display).
 * Reuses the formatting style of formatEventTime for consistency.
 */
export function formatEventTimeSpan(
  starts_at: string,
  ends_at?: string | null,
  timeZone: string = CITY.timezone
): string {
  if (isDateOnlyStart(starts_at)) return "";
  const startTime = formatEventTime(starts_at, timeZone);
  if (!startTime || !ends_at) return startTime;

  const endDate = new Date(ends_at);
  if (Number.isNaN(endDate.getTime())) return startTime;

  if (localDayDate(new Date(starts_at), timeZone) !== localDayDate(endDate, timeZone)) return startTime;

  const endTime = formatEventTime(ends_at, timeZone);
  return `${startTime} – ${endTime}`;
}

/** "YYYY-MM-DD" in the event's `timeZone` calendar day (defaults to
 *  CITY.timezone) — for itinerary day_date. */
export function eventDayDate(starts_at: string, timeZone: string = CITY.timezone): string {
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";
  return localDayDate(d, timeZone);
}

/** "Free", "From £12", or "" when price is unknown. */
export function formatEventPrice(
  row: Pick<EventItem, "is_free" | "price_from" | "currency">
): string {
  if (row.is_free) return "Free";
  if (row.price_from == null) return "";
  // Upper-cased: some sources store "gbp", which printed as "From gbp 5".
  const currency = (row.currency ?? "GBP").trim().toUpperCase() || "GBP";
  const symbol =
    currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  const amount = Number.isInteger(row.price_from)
    ? String(row.price_from)
    : row.price_from.toFixed(2);
  return `From ${symbol}${amount}`;
}
