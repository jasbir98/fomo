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
  exact: boolean,
  startsAt: string | null = null,
  endsAt: string | null = null
): Occurrence {
  return { happeningId, dayDate, lastDayDate, exact, startsAt, endsAt };
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

  switch (rec.type) {
    case "once": {
      if (!h.starts_at) return [];
      const start = validFrom!;
      const end = validTo ?? start;
      if (end < windowFrom) return []; // already over
      if (start > windowTo) return []; // beyond the window
      return [occ(h.id, start, end, true, h.starts_at, h.ends_at)];
    }

    case "always": {
      if (validTo && validTo < windowFrom) return [];
      return [occ(h.id, windowFrom, windowFrom, false)];
    }

    case "weekly": {
      const days = new Set<number>(rec.days);
      let cursor = validFrom && validFrom > windowFrom ? validFrom : windowFrom;
      let limit = windowTo;
      if (rec.until && rec.until < limit) limit = rec.until;
      if (validTo && validTo < limit) limit = validTo;

      const out: Occurrence[] = [];
      while (cursor <= limit && out.length < MAX_OCCURRENCES_PER_HAPPENING) {
        if (days.has(weekdayOf(cursor))) out.push(occ(h.id, cursor, cursor, false));
        cursor = addDays(cursor, 1);
      }
      return out;
    }

    case "annual": {
      let limit = windowTo;
      if (rec.until && rec.until < limit) limit = rec.until;
      if (validTo && validTo < limit) limit = validTo;

      const out: Occurrence[] = [];
      for (let y = yearOf(windowFrom); y <= yearOf(limit); y++) {
        const start = makeDayDate(y, rec.month, rec.day);
        if (!start) continue;
        const end = rec.endDay ? (makeDayDate(y, rec.month, rec.endDay) ?? start) : start;
        // Intersects the window if it ends on/after the start and begins on/before the end.
        if (end >= windowFrom && start <= limit) out.push(occ(h.id, start, end, false));
        if (out.length >= MAX_OCCURRENCES_PER_HAPPENING) break;
      }
      return out;
    }

    case "dates": {
      let limit = windowTo;
      if (validTo && validTo < limit) limit = validTo;
      return rec.dates
        .filter((d) => d >= windowFrom && d <= limit)
        .slice(0, MAX_OCCURRENCES_PER_HAPPENING)
        .map((d) => occ(h.id, d, d, false));
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

/** Whole days from `at` until the last day of an occurrence — the "last chance"
 *  clock the hero generator tiers its base score on. Negative once past. */
export function daysUntilLastChance(
  occurrence: Occurrence,
  at: Date,
  timeZone: string = CITY.timezone
): number {
  const today = localDayDate(at, timeZone);
  const [ty, tm, td] = today.split("-").map(Number);
  const [ly, lm, ld] = occurrence.lastDayDate.split("-").map(Number);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}
