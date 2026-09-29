"use client";

import { Chip } from "@/components/ui";
import { localDayDate } from "@/lib/happenings/occurrence";
import { monthShort } from "@/lib/happenings/format";
import type { FeedCardData } from "@/lib/happenings/feed-types";

/** A What's on card's local calendar day — `occurrence.dayDate` for a
 *  happening/series card, else derived from an event's `starts_at` the same
 *  way app/api/feed/route.ts's own `dayDateOf` does. Used only by client-side
 *  date filtering over an already-fetched card list (the route already
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

/** The day pill a card contributes, or null for something already running
 *  (an exhibition that opened in June would otherwise add a "Jun 27" pill to
 *  a list of upcoming dates). Ongoing cards still match any day in their run
 *  via `cardOnDay`. */
export function cardPillDate(card: FeedCardData, today: string = localDayDate(new Date())): string | null {
  const day = cardDayDate(card);
  return day < today ? null : day;
}

/** Whether a card is on `day` — inside its run for multi-day happenings, or
 *  (a recurring card) one of its exact occurrence dates — its dates aren't
 *  necessarily contiguous (e.g. every Tuesday), so this checks membership
 *  rather than a `first <= day <= last` range. */
export function cardOnDay(card: FeedCardData, day: string): boolean {
  if (card.kind === "recurring") return card.dates.includes(day);
  return cardDayDate(card) <= day && day <= cardLastDayDate(card);
}

/** "Sep" / "26" / "Sat" for one date pill — `monthShort` (not
 *  `Intl.DateTimeFormat(…, {month:"short"})`) sidesteps the en-GB "Sept" ICU
 *  quirk lib/happenings/format.ts's own module doc calls out; weekday
 *  abbreviation is safe straight from `Intl` (no such quirk there), same as
 *  that file's own date-label helpers. */
export function dayPillParts(dayDate: string): { weekday: string; day: number; month: string } {
  const [y, m, d] = dayDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(date);
  return { weekday, day: d, month: monthShort(dayDate) };
}

export interface DateFilterRowProps {
  dates: string[];
  selected: string;
  onSelect: (value: string) => void;
}

/**
 * "All dates" / "This weekend" chips plus one compact calendar pill per date
 * that has at least one card — used to narrow an already-fetched card list
 * (Home's Coming up tab, and both windows on /whats-on) by the day the
 * caller actually cares about, replacing the old "This weekend" / "Later on"
 * bucket split (see app/api/feed/route.ts's doc comment on `whatsOn`).
 * Single-select, horizontally scrollable, no wrapping — same convention as
 * every other filter-chip row in the app. Purely a display of `dates`, which
 * the caller derives from the already-fetched card list — no fetch of its
 * own.
 *
 * Extracted from app/(shell)/page.tsx (was `ComingUpDateFilterRow`) so
 * app/(shell)/whats-on/page.tsx can reuse the exact same chips/logic instead
 * of a second copy.
 */
export function DateFilterRow({ dates, selected, onSelect }: DateFilterRowProps) {
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 [&::-webkit-scrollbar]:hidden">
      <Chip label="All dates" selected={selected === "all"} onClick={() => onSelect("all")} />
      <Chip label="This weekend" selected={selected === "weekend"} onClick={() => onSelect("weekend")} />
      {dates.map((dayDate, i) => {
        const { weekday, day, month } = dayPillParts(dayDate);
        const showMonth = i === 0 || dayPillParts(dates[i - 1]).month !== month;
        const active = selected === dayDate;
        return (
          <button
            key={dayDate}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(dayDate)}
            className={`flex min-w-[44px] shrink-0 flex-col items-center gap-0.5 rounded-2xl px-2.5 py-1.5 text-center transition-colors ${
              active
                ? "bg-primary text-on-primary border border-primary shadow-sm"
                : "bg-surface-container text-on-surface-variant border border-transparent hover:bg-surface-container-high"
            }`}
          >
            <span className="h-3.5 text-label-sm font-bold uppercase leading-none tracking-wide opacity-70">
              {showMonth ? month : ""}
            </span>
            <span className="text-label-sm font-semibold uppercase leading-none">{weekday}</span>
            <span className="text-label-md font-extrabold leading-none">{day}</span>
          </button>
        );
      })}
    </div>
  );
}

export default DateFilterRow;
