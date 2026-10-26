/**
 * Out-of-season happenings: rows that are still `status: "live"` but describe
 * an offer that only exists part of the year, read on a day outside it.
 *
 * Three cases, all seen on Home in October 2026:
 *
 *  1. A dated row whose title names an edition that has already passed.
 *     "Edinburgh Marathon 2026 entry" recurs every May, so its next occurrence
 *     is May 2027, and Book early was selling a race that had already run.
 *     Same for "2026 Made in Scotland Lineup Released" and, once 1 Nov comes,
 *     "Samhuinn Fire Festival 2026". `staleEditionYear` below.
 *  2. A `recurrence: "always"` row that is really tied to the August
 *     festivals. "EIF Free Young Musicians Pass Tickets" was researched as
 *     "always" and so led Free any time in October. `festivalSeasonOf` below.
 *  3. An annual deal far from its next window. "Edinburgh Fringe Student
 *     Concession Tickets" (every August) sat in Deals ten months early.
 *
 * `isOutOfSeason` is applied once to the live catalogue at the top of
 * `buildFeed`, so the hero, What's on, Deals, Book early and Free any time
 * all agree. Nothing is written back: the row reappears by itself when its
 * season comes round (or, for case 1, once research refreshes the title).
 */
import { CITY } from "@/lib/city";
import { localDayDate, nextOccurrence, normalizeRecurrence } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";

const DAY_MS = 86_400_000;
/** How far ahead to look for a dated row's next occurrence (same as Book early). */
const LOOKAHEAD_DAYS = 366;
/** An annual deal or free-access row shows from this many days before its window opens. */
export const ANNUAL_OFFER_LEAD_DAYS = 45;

/**
 * Edition years named in a title. "2026" → [2026]. A season range
 * "2026/27" or "2026-27" names the edition that STARTS in 2026, so it
 * counts as 2026 for a dated row and as 2027 (its end) for an `always` row:
 * `{ start, end }` keeps both.
 */
export function titleEditionYears(title: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /\b(20\d{2})(?:\s*[/–-]\s*(\d{2}|20\d{2}))?\b/g;
  for (const m of title.matchAll(re)) {
    const start = Number(m[1]);
    let end = start;
    if (m[2]) {
      const tail = Number(m[2]);
      end = m[2].length === 2 ? Math.floor(start / 100) * 100 + tail : tail;
      if (end !== start + 1) end = start; // "2026-12" is a date, not a season
    }
    out.push({ start, end });
  }
  return out;
}

/** Years further than this from the row's own date are names, not editions ("Back to 2009 Night"). */
const EDITION_YEAR_SLACK = 3;

/**
 * True when the title names an edition year older than the occurrence it is
 * about to be shown for. `refYear` is the year of the row's next occurrence
 * (dated rows) or today's year (`always` rows).
 */
export function staleEditionYear(title: string, refYear: number, always: boolean): boolean {
  const years = titleEditionYears(title).filter((y) => Math.abs(y.start - refYear) <= EDITION_YEAR_SLACK);
  if (years.length === 0) return false;
  const latest = Math.max(...years.map((y) => (always ? y.end : y.start)));
  return latest < refYear;
}

/** A recurring festival season: [startMonth/startDay, endMonth/endDay], inclusive, within one year. */
interface FestivalSeason {
  key: string;
  /** Matched against title, summary and source name. */
  re: RegExp;
  start: [month: number, day: number];
  end: [month: number, day: number];
}

/**
 * Seasons an `always` row can belong to. Only the August festivals for now:
 * EIF and the Fringe are the ones research keeps tagging "always". The window
 * opens on 1 July, a month ahead, because passes and concessions have to be
 * claimed before the shows start.
 */
export const FESTIVAL_SEASONS: FestivalSeason[] = [
  {
    key: "august-festivals",
    re: /\bEIF\b|\bEdinburgh International Festival\b|\bInternational Festival\b|\bFestival Fringe\b|\bEdinburgh Fringe\b|\bFringe Society\b|\bMade in Scotland\b/i,
    start: [7, 1],
    end: [8, 31],
  },
];

/** The festival season an `always` row is really tied to, or null. */
export function festivalSeasonOf(h: Pick<Happening, "title" | "summary" | "source_name">): FestivalSeason | null {
  const text = `${h.title} ${h.summary ?? ""} ${h.source_name ?? ""}`;
  return FESTIVAL_SEASONS.find((s) => s.re.test(text)) ?? null;
}

function inSeason(season: FestivalSeason, dayDate: string): boolean {
  const md = dayDate.slice(5); // "MM-DD"
  const fmt = ([m, d]: [number, number]) => `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return md >= fmt(season.start) && md <= fmt(season.end);
}

type SeasonFields = Pick<
  Happening,
  "id" | "title" | "summary" | "source_name" | "kind" | "starts_at" | "ends_at" | "recurrence" | "status"
>;

/** True when `h` should be left out of every feed section on `now`'s day. See the module comment. */
export function isOutOfSeason(h: SeasonFields, now: Date, timeZone: string = CITY.timezone): boolean {
  const today = localDayDate(now, timeZone);
  const type = normalizeRecurrence(h.recurrence).type;

  if (type === "always") {
    if (staleEditionYear(h.title, Number(today.slice(0, 4)), true)) return true;
    const season = festivalSeasonOf(h);
    return season != null && !inSeason(season, today);
  }

  const next = nextOccurrence(h, now, new Date(now.getTime() + LOOKAHEAD_DAYS * DAY_MS), timeZone);
  if (!next) return false; // nothing to show anyway; the sections drop it themselves
  if (staleEditionYear(h.title, Number(next.dayDate.slice(0, 4)), false)) return true;

  if (type === "annual" && (h.kind === "deal" || h.kind === "free_access")) {
    const leadDays = (Date.parse(`${next.dayDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS;
    return leadDays > ANNUAL_OFFER_LEAD_DAYS;
  }
  return false;
}
