"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Chip, Icon } from "@/components/ui";
import { addDays, localDayDate, weekdayOf } from "@/lib/happenings/occurrence";

export interface DateCalendarProps {
  /** Sorted "YYYY-MM-DD" days (city timezone) that have at least one card — the same list DateFilterRow takes. */
  dates: string[];
  /** Same value contract as DateFilterRow: "all", "weekend", or one of `dates`. */
  selected: string;
  /** Same contract as DateFilterRow's `onSelect`: "all" | "weekend" | a "YYYY-MM-DD" day. */
  onSelect: (value: string) => void;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthOf(dayDate: string): string {
  return dayDate.slice(0, 7);
}

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1))
  );
}

function longDayLabel(dayDate: string): string {
  const [y, m, d] = dayDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Desktop replacement for DateFilterRow's pill strip: "All dates" / "This
 * weekend" chips plus a compact month calendar. Days that have cards are
 * clickable; the rest are disabled. Fully controlled (value in, onSelect out),
 * no effects, no fetching — and it speaks DateFilterRow's exact value language
 * ("all" | "weekend" | "YYYY-MM-DD"), so a page can swap one for the other.
 * The visible month is local UI state, bounded to the months that actually
 * have dates.
 */
export function DateCalendar({ dates, selected, onSelect }: DateCalendarProps) {
  const today = useMemo(() => localDayDate(new Date()), []);
  const dateSet = useMemo(() => new Set(dates), [dates]);
  const firstMonth = dates.length > 0 ? monthOf(dates[0]) : monthOf(today);
  const lastMonth = dates.length > 0 ? monthOf(dates[dates.length - 1]) : monthOf(today);

  const [viewMonth, setViewMonth] = useState<string | null>(null);
  const wanted = viewMonth ?? (dateSet.has(selected) ? monthOf(selected) : firstMonth);
  const month = wanted < firstMonth ? firstMonth : wanted > lastMonth ? lastMonth : wanted;

  const cells = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const first = `${month}-01`;
    const offset = (weekdayOf(first) + 6) % 7; // Monday-first
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out: (string | null)[] = Array.from({ length: offset }, () => null);
    for (let d = 0; d < count; d++) out.push(addDays(first, d));
    return out;
  }, [month]);

  const gridRef = useRef<HTMLDivElement>(null);

  function onGridKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step =
      e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -7 : e.key === "ArrowDown" ? 7 : 0;
    if (!step) return;
    const current = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (!current) return;
    e.preventDefault();
    const idx = cells.indexOf(current.dataset.day ?? "");
    if (idx < 0) return;
    // Walk in the arrow's direction to the next day that has items.
    for (let i = idx + step; i >= 0 && i < cells.length; i += step) {
      const day = cells[i];
      if (day && dateSet.has(day)) {
        gridRef.current?.querySelector<HTMLElement>(`[data-day="${day}"]`)?.focus();
        return;
      }
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Chip label="All dates" selected={selected === "all"} onClick={() => onSelect("all")} />
        <Chip label="This weekend" selected={selected === "weekend"} onClick={() => onSelect("weekend")} />
      </div>

      <div className="flex flex-col gap-2" role="group" aria-label="Pick a date">
        <div className="flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            disabled={month <= firstMonth}
            onClick={() => setViewMonth(shiftMonth(month, -1))}
            className="flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Icon name="chevron_left" size={20} />
          </button>
          <span className="text-label-lg font-bold text-on-surface" aria-live="polite">
            {monthTitle(month)}
          </span>
          <button
            type="button"
            aria-label="Next month"
            disabled={month >= lastMonth}
            onClick={() => setViewMonth(shiftMonth(month, 1))}
            className="flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Icon name="chevron_right" size={20} />
          </button>
        </div>

        <div className="grid grid-cols-7 text-center">
          {WEEKDAYS.map((w) => (
            <span key={w} className="py-1 text-label-sm font-semibold uppercase text-on-surface-variant opacity-70">
              {w.slice(0, 2)}
            </span>
          ))}
        </div>

        <div ref={gridRef} onKeyDown={onGridKeyDown} className="grid grid-cols-7 gap-y-1">
          {cells.map((day, i) => {
            if (!day) return <span key={`pad-${i}`} aria-hidden="true" />;
            const hasItems = dateSet.has(day);
            const active = selected === day;
            const isToday = day === today;
            const num = Number(day.slice(8, 10));
            return (
              <button
                key={day}
                type="button"
                data-day={day}
                disabled={!hasItems}
                aria-pressed={hasItems ? active : undefined}
                aria-label={longDayLabel(day)}
                onClick={() => onSelect(day)}
                className={`relative mx-auto flex h-9 w-9 items-center justify-center rounded-full text-label-md transition-colors ${
                  active
                    ? "bg-primary font-extrabold text-on-primary"
                    : hasItems
                      ? "font-bold text-on-surface hover:bg-surface-container-high"
                      : "text-on-surface-variant opacity-40"
                } ${isToday && !active ? "ring-1 ring-primary" : ""}`}
              >
                {num}
                {hasItems && !active ? (
                  <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-primary" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default DateCalendar;
