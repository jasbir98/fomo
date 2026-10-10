import { parseWeekHours } from "@/lib/chat/hours";
import { localDayDate, weekdayOf } from "@/lib/happenings/occurrence";

/**
 * True when a happening's scheduled hours for the current local occurrence
 * have all finished. Notes we cannot confidently parse, days with no stated
 * hours, and future occurrences remain eligible rather than being guessed
 * closed. The schedule parser understands the same sourced time-note formats
 * used by Ask Fomo.
 */
export function occurrenceIsPastLocalHours(
  timeNote: string | null | undefined,
  occurrenceDay: string,
  now: Date,
  timeZone: string
): boolean {
  if (localDayDate(now, timeZone) !== occurrenceDay) return false;

  const spans = parseWeekHours(timeNote)?.get(weekdayOf(occurrenceDay));
  if (!spans?.length) return false;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const localMinute = hour * 60 + minute;

  // A happening can have split hours; keep it eligible until its last
  // scheduled period has ended, rather than hiding it during a midday gap.
  return !spans.some(([, end]) => localMinute < end);
}