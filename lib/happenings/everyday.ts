/**
 * Fomo Happenings — "Any day" classifier.
 *
 * Some What's on cards are on essentially every day (the free walking tour
 * runs 7 days a week). They're a fine activity but never a reason to pick
 * one day over another, and sorted chronologically they sat at the top of
 * Today (they start ~10am) every single day. Those cards are pulled out of
 * the dated list into their own trailing "Any day" section.
 *
 * Pure (no server-only, no db) so it's unit-testable — see everyday.test.ts.
 *
 * WHAT COUNTS AS EVERYDAY
 *   - a happening/series card whose happening (series: the lead OR any
 *     member) recurs `always`, or `weekly` on >= EVERYDAY_MIN_DAYS distinct
 *     weekdays;
 *   - a collapsed `recurring` card (same title+venue on several dates — see
 *     lib/happenings/recurring.ts) whose dates cover >= EVERYDAY_MIN_DAYS of
 *     the first 7 days of the window.
 * NEVER everyday: festivals, and anything whose recurrence is once / dates /
 * annual (a one-off or dated nature). A weekly one-night item (Monday pub
 * quiz) is not everyday either — it's a legitimate reason to pick a day.
 */
import { addDays, normalizeRecurrence, weekdayOf } from "@/lib/happenings/occurrence";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import type { Happening } from "@/lib/happenings/types";

/** Minimum distinct weekdays (or days out of the window's first 7) to count as "runs most days". */
export const EVERYDAY_MIN_DAYS = 5;

/** Recurrence rule alone: `always`, or `weekly` on >= EVERYDAY_MIN_DAYS distinct weekdays. */
export function isEverydayRecurrence(recurrence: unknown): boolean {
  const r = normalizeRecurrence(recurrence);
  if (r.type === "always") return true;
  if (r.type === "weekly") return new Set(r.days).size >= EVERYDAY_MIN_DAYS;
  return false;
}

/** True when the happening's recurrence rule lets it run on `dayDate`'s weekday (`always` runs on every day). */
export function recurrenceRunsOn(recurrence: unknown, dayDate: string): boolean {
  const r = normalizeRecurrence(recurrence);
  if (r.type === "always") return true;
  if (r.type === "weekly") return r.days.includes(weekdayOf(dayDate));
  return false;
}

function isEverydayHappening(h: Pick<Happening, "kind" | "recurrence">): boolean {
  return h.kind !== "festival" && isEverydayRecurrence(h.recurrence);
}

/** The happenings a card is built from: the happening itself, a series' lead + members (when given), nothing for a provider event. */
function happeningsOf(card: FeedCardData, seriesMembers?: (seriesKey: string) => Happening[]): Happening[] {
  if (card.kind === "happening") return [card.happening];
  if (card.kind === "series") return [card.lead, ...(seriesMembers?.(card.key) ?? [])];
  if (card.kind === "recurring") return happeningsOf(card.lead, seriesMembers);
  return [];
}

export interface EverydayContext {
  /** First calendar day of the feed window ("YYYY-MM-DD") — a recurring card's dates are counted over this day + the next 6. */
  windowStartDay: string;
  /** Members of a series by its key, so ANY member can qualify a series card (lead only when omitted). */
  seriesMembers?: (seriesKey: string) => Happening[];
}

/** True when a What's on card is an "Any day" item. See the module doc for the rule. */
export function isEverydayCard(card: FeedCardData, ctx: EverydayContext): boolean {
  if (card.kind === "event") return false; // a lone provider event is one dated listing
  if (card.kind === "recurring") {
    if (card.lead.kind === "happening" && card.lead.happening.kind === "festival") return false;
    const week = new Set(Array.from({ length: 7 }, (_, i) => addDays(ctx.windowStartDay, i)));
    return new Set(card.dates.filter((d) => week.has(d))).size >= EVERYDAY_MIN_DAYS;
  }
  const members = happeningsOf(card, ctx.seriesMembers);
  if (card.kind === "series" && card.lead.kind === "festival") return false;
  return members.some(isEverydayHappening);
}

/**
 * True when an everyday card is ALSO available on `dayDate` (today) purely by
 * its recurrence rule — used to keep Coming up from repeating what Today's own
 * Any day section already shows. Recurring (dates-based) cards have no rule to
 * check, so they return false.
 */
export function everydayCardRunsOn(card: FeedCardData, dayDate: string, seriesMembers?: (seriesKey: string) => Happening[]): boolean {
  if (card.kind === "recurring" || card.kind === "event") return false;
  return happeningsOf(card, seriesMembers).some((h) => isEverydayHappening(h) && recurrenceRunsOn(h.recurrence, dayDate));
}
