/**
 * Which calendar days a What's on card covers. Pure, so both the client date
 * filters (components/happenings/DateFilterRow.tsx) and server-rendered pages
 * (This weekend's first paint) can share it; DateFilterRow re-exports these.
 */
import { weeklySpanOf } from "@/lib/events/format";
import { localDayDate, weekdayOf } from "@/lib/happenings/occurrence";
import type { FeedCardData } from "@/lib/happenings/feed-types";

/** A What's on card's local calendar day — `occurrence.dayDate` for a
 *  happening/series card, else derived from an event's `starts_at` the same
 *  way lib/happenings/build-feed.ts's own `dayDateOf` does. Used only by
 *  date filtering over an already-built card list (the feed already
 *  sorts/groups server-side; this re-derives the same day string purely for
 *  filtering the list the caller already has, not for re-bucketing it). */
export function cardDayDate(card: FeedCardData): string {
  if (card.kind === "event") return localDayDate(new Date(card.event.starts_at));
  if (card.kind === "recurring") return card.dates[0];
  return card.occurrence.dayDate;
}

/** Last day a card is on — a multi-day run's `lastDayDate`, else its one day.
 *  For a recurring card (lib/happenings/recurring.ts) this is its LAST
 *  occurrence date, but see `cardOnDay`'s own override below — its
 *  occurrences aren't a contiguous run, so this range alone would wrongly
 *  match days in between two dates it doesn't actually run on. */
function cardLastDayDate(card: FeedCardData): string {
  if (card.kind === "recurring") return card.dates[card.dates.length - 1];
  return card.kind === "event" ? cardDayDate(card) : card.occurrence.lastDayDate;
}

/** Whether a card is on `day` — inside its run for multi-day happenings, or
 *  (a recurring card) one of its exact occurrence dates — its dates aren't
 *  necessarily contiguous (e.g. every Tuesday), so this checks membership
 *  rather than a `first <= day <= last` range. A weekly span event
 *  (lib/events/format.ts's `weeklySpanOf`: "Easy Sundays", 13 Sep – 29 Nov)
 *  is on each of its run's matching weekdays. */
export function cardOnDay(card: FeedCardData, day: string): boolean {
  if (card.kind === "recurring") return card.dates.includes(day);
  if (card.kind === "event") {
    const span = weeklySpanOf(card.event);
    if (span) return span.firstDay <= day && day <= span.lastDay && weekdayOf(day) === span.weekday;
  }
  return cardDayDate(card) <= day && day <= cardLastDayDate(card);
}
