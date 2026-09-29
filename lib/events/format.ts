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
import { addDays, localDayDate } from "@/lib/happenings/occurrence";
import { monthShort } from "@/lib/happenings/format";
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
export function eventIsInProgress(e: Pick<EventItem, "starts_at" | "ends_at">, at: Date = new Date()): boolean {
  const startMs = new Date(e.starts_at).getTime();
  // A date-only row (00:00 UTC, no real clock time) is never claimed as "on now".
  return !Number.isNaN(startMs) && !isDateOnlyStart(e.starts_at) && startMs <= at.getTime() && eventIsLive(e, at);
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
  timeZone: string = CITY.timezone
): string {
  void ends_at;
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";
  const date = formatEventDate(starts_at, timeZone);
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
export function formatEventDate(starts_at: string, timeZone: string = CITY.timezone): string {
  const d = new Date(starts_at);
  if (Number.isNaN(d.getTime())) return "";

  const label = eventDayLabel(starts_at, new Date(), timeZone);
  if (label) return label;

  const eventDay = localDayDate(d, timeZone);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone }).format(d);
  return `${weekday} ${Number(eventDay.slice(8, 10))} ${monthShort(eventDay)}`;
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
  const currency = row.currency ?? "GBP";
  const symbol =
    currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  const amount = Number.isInteger(row.price_from)
    ? String(row.price_from)
    : row.price_from.toFixed(2);
  return `From ${symbol}${amount}`;
}
