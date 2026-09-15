/**
 * Fomo Happenings — recurrence expansion.
 *
 * Turns a happening into concrete dated occurrences so the feed can sort and
 * bucket it. "2-for-1 every Monday" and "annually on 30 Nov" have no single
 * `starts_at`, but the timeline needs real dates.
 *
 * NOT `server-only` on purpose — the feed is a client component. Same
 * deliberate exclusion as lib/events/format.ts.
 *
 * ## The central simplification: calendar days, not instants
 *
 * Recurring happenings have no clock time. Synthesising one ("every Monday at
 * 00:00 Europe/London") is where the bugs live — DST transitions, midnight
 * rollovers, off-by-one days — and it buys nothing, because the feed buckets by
 * day. So the unit here is a local calendar day string, "YYYY-MM-DD", and a
 * real instant is carried only when the row actually has one.
 *
 * That confines the timezone to exactly one operation: deciding which local day
 * a given instant falls on (`localDayDate`). Everything downstream is integer
 * arithmetic on a proleptic calendar, done in UTC, which is DST-immune
 * precisely because the result is never converted back into an instant.
 *
 * ISO day strings also compare correctly with `<` / `>`, so range checks need
 * no parsing at all.
 *
 * No date library: package.json carries no date-fns/luxon/dayjs, and this repo
 * hand-rolled a geohash rather than take a dependency for one call site
 * (lib/events/geohash.ts). `Intl` covers what's needed.
 */

import { CITY } from "@/lib/city";
import type { Happening, Occurrence, Recurrence, Weekday } from "./types";

/**
 * A weekly rule over a 12-month window is 52 occurrences; 40 such rows would be
 * 2,080 cards. The cap is what makes the long "Coming up" window usable — the
 * feed only ever needs the next few instances of anything.
 */
export const MAX_OCCURRENCES_PER_HAPPENING = 8;

// --- calendar-day primitives ------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The local calendar day an instant falls on, as "YYYY-MM-DD".
 *
 * Assembled from `formatToParts` rather than trusting `format()` to emit
 * ISO order — en-CA does, but that is a locale-data detail, not a guarantee,
 * and a silent reordering here would misdate the entire feed.
 */
export function localDayDate(at: Date, timeZone: string = CITY.timezone): string {
  const parts = dayFormatter(timeZone).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Shifts a day string by whole days. UTC arithmetic: DST-immune, because the
 *  intermediate instant is never surfaced — only its calendar fields are. */
export function addDays(dayDate: string, n: number): string {
  const [y, m, d] = dayDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 0 = Sunday. Correct for the calendar date itself — the date has already been
 *  resolved in the city's zone before it gets here. */
export function weekdayOf(dayDate: string): Weekday {
  const [y, m, d] = dayDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
}

// --- local-day <-> instant --------------------------------------------------

const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = offsetFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormatterCache.set(timeZone, f);
  }
  return f;
}

/** How far `timeZone`'s wall clock is ahead of UTC at the instant `at`, in ms. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    // h23 still emits "24" for midnight in some ICU versions — normalize so
    // the reconstructed instant lands on the right day rather than the next.
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  return asIfUtc - at.getTime();
}

/**
 * The exact instant a local calendar day begins in `timeZone`.
 *
 * Two passes, because the zone's offset at UTC-midnight isn't necessarily the
 * one in force at *local* midnight: on a DST-shift day the first guess lands
 * on the wrong side of the transition, and re-resolving the offset at that
 * candidate corrects it. Needed by the feed's window ranges, which must start
 * and end on true day boundaries so "Now" (today + tomorrow) and "Coming up"
 * (everything after) can't overlap or leave a gap between them.
 */
export function startOfLocalDay(dayDate: string, timeZone: string = CITY.timezone): Date {
  const [y, m, d] = dayDate.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  const firstPass = utcMidnight - zoneOffsetMs(new Date(utcMidnight), timeZone);
  return new Date(utcMidnight - zoneOffsetMs(new Date(firstPass), timeZone));
}

/** The last representable instant of a local calendar day — i.e. 1ms before
 *  the next day starts, so `[startOfLocalDay(a), endOfLocalDay(b)]` is a
 *  closed range that can't double-count the boundary midnight. */
export function endOfLocalDay(dayDate: string, timeZone: string = CITY.timezone): Date {
  return new Date(startOfLocalDay(addDays(dayDate, 1), timeZone).getTime() - 1);
}

function yearOf(dayDate: string): number {
  return Number(dayDate.slice(0, 4));
}

/** Guards against a month/day pair that doesn't exist (31 Feb), which would
 *  otherwise silently roll forward into the next month. */
function makeDayDate(year: number, month: number, day: number): string | null {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Defensive parse. The research pipeline validates recurrence before insert,
 * but rows can be hand-edited in the Supabase dashboard, and a malformed rule
 * must degrade to "undated" rather than throw inside a render.
 */
export function normalizeRecurrence(value: unknown): Recurrence {
  const fallback: Recurrence = { type: "once" };
  if (!value || typeof value !== "object") return fallback;
  const r = value as Record<string, unknown>;

  switch (r.type) {
    case "always":
      return { type: "always" };
    case "weekly": {
      const days = Array.isArray(r.days)
        ? r.days.filter((d): d is Weekday => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
        : [];
      if (days.length === 0) return fallback;
      return { type: "weekly", days, until: typeof r.until === "string" ? r.until : undefined };
    }
    case "annual": {
      const month = Number(r.month);
      const day = Number(r.day);
      if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return fallback;
      const endDay = Number(r.endDay);
      return {
        type: "annual",
        month,
        day,
        endDay: endDay >= day && endDay <= 31 ? endDay : undefined,
        until: typeof r.until === "string" ? r.until : undefined,
      };
    }
    case "dates": {
      const dates = Array.isArray(r.dates)
        ? r.dates.filter((d): d is string => typeof d === "string" && DAY_RE.test(d)).sort()
        : [];
      if (dates.length === 0) return fallback;
      return { type: "dates", dates };
    }
    default:
      return fallback;
  }
}

// --- expansion --------------------------------------------------------------

function occ(
  happeningId: string,
  dayDate: string,
  lastDayDate: string,
  seriesEndDayDate: string | null,
  exact: boolean,
  startsAt: string | null = null,
  endsAt: string | null = null
): Occurrence {
  return { happeningId, dayDate, lastDayDate, seriesEndDayDate, exact, startsAt, endsAt };
}

/** A one-off ("once") occurrence with a real clock time and no `ends_at` is
 *  assumed to run this long — long enough for a normal talk/tour/showing,
 *  short enough that it doesn't linger as "live" into the evening. Mirrors
 *  the analogous default used for provider events (lib/events/format.ts). */
const DEFAULT_OCCURRENCE_DURATION_MS = 2 * 60 * 60 * 1000;

/** True for an instant at exactly 00:00:00 UTC — how the pipeline stores a
 *  date with no time. Such a row runs all day, so the 2h default above must
 *  not end it at 3am. */
function isMidnightUtc(iso: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

/**
 * Expands a happening into its occurrences inside `[from, to]`, soonest first,
 * capped at MAX_OCCURRENCES_PER_HAPPENING.
 *
 * Returns `[]` for a retired row, and for a `once` row whose window has fully
 * passed. An `always` row yields exactly one occurrence pinned to `from`'s day,
 * so "free, any time" sorts to the top of the window — which is correct, and is
 * why the feed keeps those in their own trailing zone rather than letting them
 * crowd out genuinely time-limited things.
 */
export function nextOccurrences(
  h: Pick<Happening, "id" | "starts_at" | "ends_at" | "recurrence" | "status">,
  from: Date,
  to: Date,
  timeZone: string = CITY.timezone
): Occurrence[] {
  if (h.status === "retired") return [];

  const windowFrom = localDayDate(from, timeZone);
  const windowTo = localDayDate(to, timeZone);
  if (windowTo < windowFrom) return [];

  const rec = normalizeRecurrence(h.recurrence);

  // When a rule is present, starts_at/ends_at are its VALIDITY BOUNDS, not an
  // occurrence ("Mondays, until 31 Dec"). When it isn't, they are the occurrence.
  const validFrom = h.starts_at ? localDayDate(new Date(h.starts_at), timeZone) : null;
  const validTo = h.ends_at ? localDayDate(new Date(h.ends_at), timeZone) : null;

  // The RULE's own overall end — `min` of the row's validity bound and the
  // rule's own `until`, whichever are actually set. `null` means open-ended
  // (no last chance — see `daysUntilLastChance`). Irrelevant to `once`
  // (there's no separate "rule"; see that case's own seriesEnd) and to
  // `always`, which computes its own from `validTo` alone (no `until` field
  // on that recurrence shape).
  function recurringSeriesEnd(until: string | undefined): string | null {
    let end: string | null = until ?? null;
    if (validTo && (end === null || validTo < end)) end = validTo;
    return end;
  }

  switch (rec.type) {
    case "once": {
      if (!h.starts_at) return [];
      const start = validFrom!;
      const end = validTo ?? start;
      if (end < windowFrom) return []; // already over
      if (start > windowTo) return []; // beyond the window
      // The day-level check above can't see that a same-day item's actual
      // end INSTANT has already passed (a 10:00-11:00 item is still "today"
      // at 21:00) — only matters when this occurrence's last day is `from`'s
      // own day; any other day is already correctly excluded/included by the
      // day comparison above.
      const allDay = h.ends_at ? isMidnightUtc(h.ends_at) : isMidnightUtc(h.starts_at);
      if (end === windowFrom && !allDay) {
        const effectiveEndMs = h.ends_at
          ? new Date(h.ends_at).getTime()
          : new Date(h.starts_at).getTime() + DEFAULT_OCCURRENCE_DURATION_MS;
        if (effectiveEndMs <= from.getTime()) return [];
      }
      return [occ(h.id, start, end, end, true, h.starts_at, h.ends_at)];
    }

    case "always": {
      if (validTo && validTo < windowFrom) return [];
      return [occ(h.id, windowFrom, windowFrom, validTo, false)];
    }

    case "weekly": {
      const days = new Set<number>(rec.days);
      let cursor = validFrom && validFrom > windowFrom ? validFrom : windowFrom;
      let limit = windowTo;
      if (rec.until && rec.until < limit) limit = rec.until;
      if (validTo && validTo < limit) limit = validTo;
      const seriesEnd = recurringSeriesEnd(rec.until);

      const out: Occurrence[] = [];
      while (cursor <= limit && out.length < MAX_OCCURRENCES_PER_HAPPENING) {
        if (days.has(weekdayOf(cursor))) out.push(occ(h.id, cursor, cursor, seriesEnd, false));
        cursor = addDays(cursor, 1);
      }
      return out;
    }

    case "annual": {
      let limit = windowTo;
      if (rec.until && rec.until < limit) limit = rec.until;
      if (validTo && validTo < limit) limit = validTo;
      const seriesEnd = recurringSeriesEnd(rec.until);

      const out: Occurrence[] = [];
      for (let y = yearOf(windowFrom); y <= yearOf(limit); y++) {
        const start = makeDayDate(y, rec.month, rec.day);
        if (!start) continue;
        const end = rec.endDay ? (makeDayDate(y, rec.month, rec.endDay) ?? start) : start;
        // Intersects the window if it ends on/after the start and begins on/before the end.
        if (end >= windowFrom && start <= limit) out.push(occ(h.id, start, end, seriesEnd, false));
        if (out.length >= MAX_OCCURRENCES_PER_HAPPENING) break;
      }
      return out;
    }

    case "dates": {
      let limit = windowTo;
      if (validTo && validTo < limit) limit = validTo;
      // "dates" has no `until` field of its own (Recurrence's `dates` shape
      // carries only the list) — its series end is purely the row's own
      // `ends_at`, if any.
      const seriesEnd = validTo ?? null;
      return rec.dates
        .filter((d) => d >= windowFrom && d <= limit)
        .slice(0, MAX_OCCURRENCES_PER_HAPPENING)
        .map((d) => occ(h.id, d, d, seriesEnd, false));
    }
  }
}

/** The soonest occurrence in the window, or null. Convenience for the card and
 *  the hero generator, which only ever show one instance per happening —
 *  never two cards for the same deal. */
export function nextOccurrence(
  h: Pick<Happening, "id" | "starts_at" | "ends_at" | "recurrence" | "status">,
  from: Date,
  to: Date,
  timeZone: string = CITY.timezone
): Occurrence | null {
  return nextOccurrences(h, from, to, timeZone)[0] ?? null;
}

/**
 * How far ahead `happeningHasEnded` looks before concluding a happening will
 * never produce another occurrence — long enough that any open-ended
 * recurring row (a weekly/annual rule with no `until`) always finds at
 * least one and is correctly judged "not ended", short enough to stay cheap
 * as a per-row guard. Same order of magnitude as the lookahead used
 * elsewhere for "how far into the future could this still matter"
 * (app/api/feed/route.ts's BOOK_EARLY_LOOKAHEAD_DAYS).
 */
const ENDED_CHECK_LOOKAHEAD_DAYS = 366;

/**
 * THE "has this happening ended as of `at`" predicate — the happenings half
 * of the "no ended items ever leave an API" guard (see lib/events/format.ts's
 * `eventHasEnded` for the events-table half). Every list route's query-time
 * `nextOccurrence`/`nextOccurrences` call already excludes a fully-passed
 * happening from ITS OWN window; this is the belt-and-braces check a route
 * runs once more, right before serialising, against a row that may have
 * reached it some other way (a merge/dedupe step, a future code path that
 * forgets to call nextOccurrence at all).
 *
 * A recurring happening is "ended" only once its whole SERIES has finished —
 * its `until`/`ends_at` validity bound has passed, or it's `status:
 * "retired"` — never merely because today isn't one of its occurrence days
 * (a weekly Monday deal isn't "ended" on a Tuesday; an annual one isn't
 * "ended" for the eleven months between instances). Implemented as "does
 * this produce zero occurrences anywhere in the next year" rather than a
 * second, independently-maintained definition of "ended" — that would drift
 * from what `nextOccurrences` itself decides the moment either one changed
 * without the other. `season_valid_until` is NOT re-checked here — it's
 * filtered at the query layer (lib/db/happenings.ts's `isPastSeason`) before
 * a row ever reaches this guard, same as `status !== "live"` more generally.
 */
export function happeningHasEnded(
  h: Pick<Happening, "id" | "starts_at" | "ends_at" | "recurrence" | "status">,
  at: Date,
  timeZone: string = CITY.timezone
): boolean {
  const to = new Date(at.getTime() + ENDED_CHECK_LOOKAHEAD_DAYS * 86_400_000);
  return nextOccurrence(h, at, to, timeZone) === null;
}

/** True when `at` falls inside an occurrence's span. `always` rows are always
 *  active; that is the point of them. */
export function isActiveNow(
  h: Pick<Happening, "id" | "starts_at" | "ends_at" | "recurrence" | "status">,
  at: Date,
  timeZone: string = CITY.timezone
): boolean {
  const today = localDayDate(at, timeZone);
  return nextOccurrences(h, at, at, timeZone).some(
    (o) => o.dayDate <= today && today <= o.lastDayDate
  );
}

/**
 * Whole days from `at` until the happening's overall last chance — the
 * "last chance" clock the hero generator tiers its base score on. Negative
 * once past.
 *
 * Measured against `occurrence.seriesEndDayDate` (when the RULE stops, not
 * when today's single instance does) — a daily/weekly rule with no end date
 * has `seriesEndDayDate === null` and therefore no last chance at all
 * (`+Infinity`, never "today only"/"Last Chance"). Using `lastDayDate`
 * instead here was the bug: every occurrence of a recurring rule reports its
 * OWN day as its last day, so a plain daily walk looked like it was ending
 * today, every day, forever.
 */
export function daysUntilLastChance(
  occurrence: Occurrence,
  at: Date,
  timeZone: string = CITY.timezone
): number {
  if (occurrence.seriesEndDayDate == null) return Number.POSITIVE_INFINITY;
  const today = localDayDate(at, timeZone);
  const [ty, tm, td] = today.split("-").map(Number);
  const [ly, lm, ld] = occurrence.seriesEndDayDate.split("-").map(Number);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}
