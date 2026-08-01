"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import { getCurrentTrip, listItems, updateItem } from "@/lib/db";
import type { ItineraryItem, Trip } from "@/lib/types";
import type { DayForecast, WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { useGeolocation } from "@/lib/geo";
import type { DayPlanResponse, GapBlock } from "@/lib/now/types";
import { Card, Icon, SegmentedControl, StatusPill } from "@/components/ui";
import { RoameoCard } from "@/components/roameo/Card";

/**
 * Source: `trip_timeline_tokyo_spring/code.html` + `trip_calendar_tokyo_spring/code.html`.
 * One `/plan` shell route; SegmentedControl toggles Timeline ⇄ Calendar.
 * Both views share `selectedDay` (a single day_date) — Calendar's "tap day"
 * jumps into Timeline scoped to that day, matching the prototype's behavior
 * of always showing exactly one day's items in the Timeline pane.
 */

type PlanView = "timeline" | "calendar";

// Item category → display label + Material Symbols icon. Superset of the
// 3 chips shown in edit_itinerary_item/code.html (Activity/Booking/Dining),
// extended with Reservation + Note to match add_item_menu's 4 entry points.
const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  activity: { label: "Activity", icon: "hiking" },
  dining: { label: "Dining", icon: "restaurant" },
  booking: { label: "Booking", icon: "confirmation_number" },
  reservation: { label: "Reservation", icon: "event" },
  note: { label: "Note", icon: "edit_note" },
};

function categoryMeta(category: string | null) {
  return CATEGORY_META[category ?? ""] ?? { label: category ?? "Item", icon: "bookmark" };
}

// color_tag (seeded on itinerary_items) → left-accent bar color. No accent-*
// tokens exist in globals.css for this, so green/blue use arbitrary values
// (matching accent-green/accent-blue in the source code.html) while orange
// reuses our real Sunset Orange token.
const COLOR_TAG_CLASS: Record<string, string> = {
  green: "bg-[#22c55e]",
  orange: "bg-secondary-container",
  blue: "bg-[#3b82f6]",
};

function colorTagClass(colorTag: string | null): string {
  return COLOR_TAG_CLASS[colorTag ?? ""] ?? "bg-outline-variant";
}

// lib/weather.ts is server-only, so pickForecastDay can't be imported here —
// this mirrors its lookup+fallback exactly. Open-Meteo only forecasts ~10
// days out, so an item whose day_date falls outside that window (a trip
// planned months ahead, or already past) has no exact match; falling back to
// the place's first available day ("around now") beats showing no weather at
// all for the whole trip, same tradeoff lib/weather.ts's pickForecastDay
// documents.
function forecastForDay(days: DayForecast[], date: string | null): DayForecast | null {
  if (days.length === 0) return null;
  if (date) {
    const exact = days.find((d) => d.date === date);
    if (exact) return exact;
  }
  return days[0];
}

// Timeline cards apply the weather tint as an inline background-color rather
// than WEATHER_THEME's Tailwind classes: Card's own className already hardc­odes
// bg-surface-container-lowest, and a second bg-* utility competing for the
// same property has no guaranteed win over it (Tailwind's cascade order
// depends on generated-CSS source order, not className string order) — this
// was tried and the tint silently lost every time. An inline style always
// wins, so it's the only reliable way to override it here. Values mirror
// WEATHER_THEME's chipClass opacities (lib/weatherUi.ts), just expressed as
// color-mix() against the same design tokens instead of Tailwind utilities.
const CARD_WEATHER_BG: Record<WeatherCondition, string> = {
  sunny: "color-mix(in srgb, var(--color-secondary-container) 15%, var(--color-surface-container-lowest))",
  cloudy: "var(--color-surface-container)",
  rainy: "color-mix(in srgb, var(--color-error-container) 50%, var(--color-surface-container-lowest))",
  windy: "color-mix(in srgb, var(--color-tertiary-fixed) 40%, var(--color-surface-container-lowest))",
};

// Weather is fetched per place, not just once for the whole trip — a
// multi-city itinerary (e.g. a Tokyo trip with a Kyoto day trip) needs each
// leg's own forecast. item.location is typically "<Place>, <City>" (seed
// data / add-item flow both write it that way); the segment after the last
// comma is close enough to a city for Open-Meteo's day-granularity forecast.
// Falls back to the trip's destination when an item has no location.
function weatherKeyFor(location: string | null, tripDestination: string | null): string | null {
  if (location?.includes(",")) {
    const city = location.split(",").pop()?.trim();
    if (city) return city;
  }
  return tripDestination;
}

function parseDate(d: string): Date {
  return new Date(`${d}T00:00:00`);
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function eachDateInRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = parseDate(start);
  const last = parseDate(end);
  while (cur.getTime() <= last.getTime()) {
    out.push(toISODate(cur));
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return out;
}

function formatDayLabel(iso: string): { weekday: string; day: string } {
  const d = parseDate(iso);
  return {
    weekday: d.toLocaleDateString("en-US", { weekday: "short" }),
    day: String(d.getDate()),
  };
}

function formatTripDates(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  const short = (v: string) =>
    parseDate(v).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (start && end) return `${short(start)} – ${short(end)}`;
  return short((start ?? end) as string);
}

const WEEKDAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * A gap over 90 minutes, rendered as a dashed block holding real candidates
 * (plan-v1-home-pivot.md §5.3) — `90-minute-wins`'s replacement: gap-length
 * aware, location aware, weather aware, drawn from real places instead of a
 * hardcoded array.
 */
function GapBlockView({ gap, deviceId, tripId }: { gap: GapBlock; deviceId: string; tripId: string }) {
  if (gap.candidates.length === 0) return null;
  return (
    <div className="rounded-xl border border-dashed border-outline-variant p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-secondary">{gap.label}</p>
      <h4 className="mb-2 text-label-md font-bold text-primary">Worth a look for the gap</h4>
      <div className="flex gap-2.5 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
        {gap.candidates.map((c) => (
          <div key={`${c.subject.type}:${c.subject.id}`} className="shrink-0">
            <RoameoCard candidate={c} variant="tile" deviceId={deviceId} tripId={tripId} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PlanPage() {
  const deviceId = useDeviceId();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [items, setItems] = useState<ItineraryItem[]>([]);
  const [view, setView] = useState<PlanView>("timeline");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [calMonth, setCalMonth] = useState<{ year: number; month: number } | null>(null);
  const [forecastByPlace, setForecastByPlace] = useState<Record<string, DayForecast[]>>({});
  const [dayPlan, setDayPlan] = useState<DayPlanResponse | null>(null);
  // Tracks which day's disruption block the user dismissed ("Leave it" /
  // "Swap them"), rather than a plain boolean + an effect to reset it on day
  // change — comparing against selectedDay directly means no reset effect is
  // needed at all.
  const [dismissedForDay, setDismissedForDay] = useState<string | null>(null);
  const disruptionDismissed = dismissedForDay === selectedDay;
  const { coords } = useGeolocation();

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const currentTrip = await getCurrentTrip(deviceId);
        if (cancelled) return;
        setTrip(currentTrip);
        if (currentTrip) {
          const rows = await listItems(deviceId, currentTrip.id);
          if (cancelled) return;
          setItems(rows);
        }
      } catch (err) {
        console.error("[roameo] plan load failed", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  // Re-fetch items whenever this tab/route regains focus — items can be
  // added from the chat screen (see app/(shell)/roameo/page.tsx), and
  // without this a trip's items only ever loaded once on mount, so newly
  // added items wouldn't show up here without a hard reload.
  useEffect(() => {
    if (!deviceId || !trip) return;
    let cancelled = false;
    async function refetch() {
      if (!deviceId || !trip) return;
      try {
        const rows = await listItems(deviceId, trip.id);
        if (!cancelled) setItems(rows);
      } catch (err) {
        console.error("[roameo] plan refetch failed", err);
      }
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onVisibilityChange);
    };
  }, [deviceId, trip]);

  // Real per-day forecast for the timeline cards' weather background, fetched
  // per place (see weatherKeyFor) so a multi-city trip's Kyoto day gets
  // Kyoto's forecast rather than the trip's overall destination. Same
  // day-granularity `/api/weather` call Home's weather chip uses
  // (app/(shell)/page.tsx). Silently leaves a place's cards unthemed on any
  // failure for that place alone.
  useEffect(() => {
    const keys = Array.from(
      new Set(
        items
          .map((item) => weatherKeyFor(item.location, trip?.destination ?? null))
          .filter((k): k is string => !!k)
      )
    );
    if (keys.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        keys.map(async (key) => {
          try {
            const res = await fetch(`/api/weather?destination=${encodeURIComponent(key)}`);
            const json = (await res.json()) as { days?: DayForecast[] };
            return [key, json.days ?? []] as const;
          } catch (err) {
            console.error("[plan] weather fetch failed", key, err);
            return [key, []] as const;
          }
        })
      );
      if (!cancelled) setForecastByPlace(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [items, trip?.destination]);

  // Plan's per-day view (plan-v1-home-pivot.md §5) — the disruption block and
  // gap-filler candidates for whichever day is selected. Distinct from
  // Home's /api/now: this isn't anchored to "right now", it shows the whole
  // selected day, past or future.
  useEffect(() => {
    if (!deviceId || !trip || !selectedDay) return;
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ deviceId, tripId: trip.id, day: selectedDay });
        if (coords) {
          params.set("lat", String(coords.lat));
          params.set("lng", String(coords.lng));
        }
        const res = await fetch(`/api/now/day?${params.toString()}`);
        const json = (await res.json()) as DayPlanResponse;
        if (!cancelled) setDayPlan(json);
      } catch (err) {
        console.error("[plan] /api/now/day fetch failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, trip, selectedDay, coords]);

  async function applySwap() {
    if (!deviceId || !dayPlan?.disruption) return;
    const d = dayPlan.disruption;
    try {
      await updateItem(deviceId, d.itemId, {
        title: d.alternativeTitle,
        category: d.alternativeCategory,
        location: d.alternativeLocation,
        weather_alert: false,
      });
      const rows = trip ? await listItems(deviceId, trip.id) : [];
      setItems(rows);
      setDismissedForDay(selectedDay);
    } catch (err) {
      console.error("[plan] swap failed", err);
    }
  }

  const startDate = trip?.start_date ?? null;
  const endDate = trip?.end_date ?? null;
  const days = useMemo(
    () => (startDate && endDate ? eachDateInRange(startDate, endDate) : []),
    [startDate, endDate]
  );

  const itemsByDay = useMemo(() => {
    const map = new Map<string, ItineraryItem[]>();
    for (const item of items) {
      if (!item.day_date) continue;
      const list = map.get(item.day_date) ?? [];
      list.push(item);
      map.set(item.day_date, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.starts_at && b.starts_at) return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
        if (a.starts_at) return -1;
        if (b.starts_at) return 1;
        return (a.time_label ?? "").localeCompare(b.time_label ?? "");
      });
    }
    return map;
  }, [items]);

  // Default the selected day to the first day (in trip order) that actually
  // has items, falling back to the trip's first day — mirrors the prototype,
  // which always shows exactly one pre-selected day. Adjusting state during
  // render (converging: the guard is false once set) is the React-sanctioned
  // pattern for deriving initial state from freshly-loaded data.
  if (!selectedDay && days.length > 0) {
    const firstWithItems = days.find((d) => (itemsByDay.get(d)?.length ?? 0) > 0);
    setSelectedDay(firstWithItems ?? days[0]);
  }

  if (!calMonth && startDate) {
    const start = parseDate(startDate);
    setCalMonth({ year: start.getFullYear(), month: start.getMonth() });
  }

  const startMonth = trip?.start_date ? parseDate(trip.start_date) : null;
  const endMonth = trip?.end_date ? parseDate(trip.end_date) : null;

  function canGoPrevMonth() {
    if (!calMonth || !startMonth) return false;
    return calMonth.year > startMonth.getFullYear() || calMonth.month > startMonth.getMonth();
  }
  function canGoNextMonth() {
    if (!calMonth || !endMonth) return false;
    return calMonth.year < endMonth.getFullYear() || calMonth.month < endMonth.getMonth();
  }

  function selectDayAndShowTimeline(iso: string) {
    setSelectedDay(iso);
    setView("timeline");
  }

  function addToDay() {
    const day = selectedDay ?? trip?.start_date ?? "";
    router.push(day ? `/plan/add?day=${day}` : "/plan/add");
  }

  if (!deviceId || loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Icon name="calendar_month" size={32} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (!trip) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-40 flex min-h-[56px] items-center bg-background/90 px-5 pt-safe backdrop-blur-sm">
          <h1 className="text-headline-sm text-primary">Plan</h1>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-5 px-8 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary-fixed text-primary">
            <Icon name="calendar_month" size={40} filled />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-headline-md text-primary">Nothing to plan yet</h2>
            <p className="text-body-lg text-on-surface-variant">
              Create a trip to start building your day-by-day itinerary.
            </p>
          </div>
          <Link
            href="/plan/new-trip"
            className="mt-2 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
          >
            <Icon name="add" size={20} />
            Create a trip
          </Link>
        </div>
      </div>
    );
  }

  const selectedItems = selectedDay ? itemsByDay.get(selectedDay) ?? [] : [];

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 flex flex-col gap-3 bg-background/90 px-5 pt-safe pb-3 backdrop-blur-sm">
        <div className="flex items-start justify-between pt-3">
          <div className="flex flex-col">
            <h1 className="text-headline-sm text-primary">{trip.name ?? "Your Trip"}</h1>
            <p className="text-label-sm font-medium text-on-surface-variant mt-1">
              {formatTripDates(trip.start_date, trip.end_date)}
            </p>
          </div>
        </div>
        <SegmentedControl<PlanView>
          value={view}
          onChange={setView}
          options={[
            { value: "timeline", label: "Timeline", icon: "view_agenda" },
            { value: "calendar", label: "Calendar", icon: "calendar_month" },
          ]}
          className="w-full"
        />
      </header>

      {view === "timeline" ? (
        <>
          {/* Horizontal day scroller */}
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-5 py-2">
            {days.map((iso) => {
              const { weekday, day } = formatDayLabel(iso);
              const active = iso === selectedDay;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => setSelectedDay(iso)}
                  className={`flex h-16 min-w-[64px] shrink-0 flex-col items-center justify-center rounded-xl transition-all ${
                    active
                      ? "scale-105 bg-primary text-on-primary shadow-md"
                      : "bg-surface-container-low text-on-surface-variant hover:bg-surface-container"
                  }`}
                >
                  <span className="text-[11px] font-medium uppercase tracking-wider">{weekday}</span>
                  <span className="mt-1 text-lg font-bold">{day}</span>
                </button>
              );
            })}
          </div>

          {/* Disruption block (plan-v1-home-pivot.md §5.1) — full reasoning,
              unlike Home's one-line hero. Reuses lib/disruption.ts's real
              weather + real per-city alternatives via /api/now/day. */}
          {dayPlan?.disruption && !disruptionDismissed ? (
            <div className="mx-5 mt-2 rounded-xl bg-primary p-4 text-on-primary">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-secondary-container">
                {dayPlan.disruption.why}
              </p>
              <h3 className="mt-1 text-headline-sm">{dayPlan.disruption.headline}</h3>
              <p className="mt-1.5 text-body-md text-on-primary/80">{dayPlan.disruption.detail}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void applySwap()}
                  className="flex-1 rounded-full bg-secondary-container px-4 py-2 text-label-md font-semibold text-on-secondary-container transition-opacity hover:opacity-90"
                >
                  Swap them
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedForDay(selectedDay)}
                  className="rounded-full border border-on-primary/30 px-4 py-2 text-label-md font-semibold text-on-primary/80 transition-colors hover:bg-on-primary/10"
                >
                  Leave it
                </button>
              </div>
            </div>
          ) : null}

          {/* Item cards for the selected day, with gap blocks
              (plan-v1-home-pivot.md §5.3) interleaved by position — a gap
              with afterItemId=null renders before the first item, others
              render immediately after the item they follow. */}
          <div className="flex flex-1 flex-col gap-4 px-5 pb-32 pt-2">
            {/* `dayPlan.gaps.length === 0` alone doesn't guarantee anything
                renders below: an uncovered city can still produce a gap
                *window* with zero fillable candidates, and GapBlockView
                renders nothing for those (see GapBlockView above) — the two
                null-outs combine into a silently blank screen. Checking for
                at least one gap with real candidates closes that hole. */}
            {selectedItems.length === 0 && !(dayPlan?.gaps ?? []).some((g) => g.candidates.length > 0) ? (
              <p className="mt-8 text-center text-body-md text-on-surface-variant">
                Nothing planned for this day yet.
              </p>
            ) : (
              <>
                {dayPlan?.gaps
                  .filter((g) => g.afterItemId === null)
                  .map((gap) => <GapBlockView key={`${gap.startsAt}-lead`} gap={gap} deviceId={deviceId} tripId={trip.id} />)}
                {selectedItems.map((item) => {
                const meta = categoryMeta(item.category);
                const barClass = item.weather_alert ? "bg-error" : colorTagClass(item.color_tag);
                const weatherKey = weatherKeyFor(item.location, trip.destination);
                const dayForecast = forecastForDay(
                  weatherKey ? forecastByPlace[weatherKey] ?? [] : [],
                  item.day_date
                );
                const weatherTheme = dayForecast ? WEATHER_THEME[dayForecast.condition] : null;
                const trailingGaps = dayPlan?.gaps.filter((g) => g.afterItemId === item.id) ?? [];
                return (
                  <Fragment key={item.id}>
                  <Card
                    noPadding
                    role="button"
                    tabIndex={0}
                    onClick={() => router.push(`/plan/item/${item.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        router.push(`/plan/item/${item.id}`);
                      }
                    }}
                    className="relative flex min-h-[72px] cursor-pointer overflow-hidden transition-opacity hover:opacity-90"
                    style={
                      dayForecast ? { backgroundColor: CARD_WEATHER_BG[dayForecast.condition] } : undefined
                    }
                  >
                    <span className={`absolute left-0 top-0 bottom-0 w-1 ${barClass}`} aria-hidden="true" />
                    <div className="flex w-full flex-col justify-center py-3 pl-5 pr-4">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-[11px] font-medium text-on-surface-variant">
                          <Icon name={meta.icon} size={14} />
                          {[item.time_label, meta.label].filter(Boolean).join(" • ")}
                        </span>
                        {item.weather_alert ? (
                          <StatusPill label="Rain expected" tone="error" icon="warning" />
                        ) : weatherTheme ? (
                          <span
                            className={`flex items-center gap-1 text-[11px] font-semibold ${weatherTheme.iconClass}`}
                          >
                            <Icon name={weatherTheme.icon} size={14} filled />
                            {weatherTheme.label}
                          </span>
                        ) : null}
                      </div>
                      <h3 className="text-[16px] font-bold leading-tight text-primary">{item.title}</h3>
                      {item.location ? (
                        <p className="mt-0.5 text-label-sm text-on-surface-variant">{item.location}</p>
                      ) : null}
                      {item.weather_alert ? (
                        <Link
                          href={`/plan/disruption/${item.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-1 flex items-center gap-1 text-[12px] font-bold text-secondary hover:underline"
                        >
                          Tap for a covered alternative
                          <Icon name="arrow_forward" size={14} />
                        </Link>
                      ) : null}
                    </div>
                  </Card>
                  {trailingGaps.map((gap) => (
                    <GapBlockView key={gap.startsAt} gap={gap} deviceId={deviceId} tripId={trip.id} />
                  ))}
                  </Fragment>
                );
                })}
              </>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col gap-6 px-5 pt-4 pb-32">
          {calMonth ? (
            <>
              {/* Month navigator */}
              <div className="flex items-center justify-between">
                <h3 className="text-headline-md text-on-surface">
                  {new Date(calMonth.year, calMonth.month, 1).toLocaleDateString("en-US", {
                    month: "long",
                  })}{" "}
                  {calMonth.year}
                </h3>
                <div className="flex gap-2">
                  <button
                    type="button"
                    aria-label="Previous month"
                    disabled={!canGoPrevMonth()}
                    onClick={() =>
                      setCalMonth((m) => (m ? { year: m.month === 0 ? m.year - 1 : m.year, month: (m.month + 11) % 12 } : m))
                    }
                    className="flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container disabled:opacity-30"
                  >
                    <Icon name="chevron_left" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next month"
                    disabled={!canGoNextMonth()}
                    onClick={() =>
                      setCalMonth((m) => (m ? { year: m.month === 11 ? m.year + 1 : m.year, month: (m.month + 1) % 12 } : m))
                    }
                    className="flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container disabled:opacity-30"
                  >
                    <Icon name="chevron_right" />
                  </button>
                </div>
              </div>

              {/* Weekday headers */}
              <div className="grid grid-cols-7 gap-1 text-center -mb-4">
                {WEEKDAY_HEADERS.map((w, i) => (
                  <div key={i} className="py-2 text-label-sm text-outline-variant">
                    {w}
                  </div>
                ))}
              </div>

              {/* Day grid */}
              <div className="grid grid-cols-7 gap-x-1 gap-y-3">
                {(() => {
                  const firstWeekday = new Date(calMonth.year, calMonth.month, 1).getDay();
                  const daysInMonth = new Date(calMonth.year, calMonth.month + 1, 0).getDate();
                  const cells: React.ReactNode[] = [];
                  for (let i = 0; i < firstWeekday; i++) {
                    cells.push(<div key={`blank-${i}`} className="aspect-square" />);
                  }
                  for (let d = 1; d <= daysInMonth; d++) {
                    const iso = toISODate(new Date(calMonth.year, calMonth.month, d));
                    const dayItems = itemsByDay.get(iso) ?? [];
                    const inTrip = days.includes(iso);
                    const active = iso === selectedDay;
                    cells.push(
                      <button
                        key={iso}
                        type="button"
                        disabled={!inTrip}
                        onClick={() => selectDayAndShowTimeline(iso)}
                        className={`relative flex aspect-square flex-col items-center justify-start rounded-xl pt-2 transition-transform ${
                          active
                            ? "scale-105 bg-primary text-on-primary shadow-md"
                            : inTrip
                              ? "bg-surface-container-lowest text-on-surface hover:bg-surface-container-low"
                              : "text-on-surface-variant/40"
                        }`}
                      >
                        <span className="text-body-md">{d}</span>
                        {dayItems.length > 0 ? (
                          <span className="absolute bottom-2 flex gap-1">
                            {dayItems.slice(0, 3).map((it, i) => (
                              <span
                                key={i}
                                className={`h-1.5 w-1.5 rounded-full ${
                                  it.weather_alert ? "bg-error" : colorTagClass(it.color_tag)
                                } ${active ? "opacity-90" : ""}`}
                              />
                            ))}
                          </span>
                        ) : null}
                      </button>
                    );
                  }
                  return cells;
                })()}
              </div>

              {/* Legend */}
              <div className="mt-2 flex justify-center gap-4">
                <span className="flex items-center gap-2 text-label-sm text-on-surface-variant">
                  <span className="h-2 w-2 rounded-full bg-[#22c55e]" /> Activity
                </span>
                <span className="flex items-center gap-2 text-label-sm text-on-surface-variant">
                  <span className="h-2 w-2 rounded-full bg-secondary-container" /> Dining
                </span>
                <span className="flex items-center gap-2 text-label-sm text-on-surface-variant">
                  <span className="h-2 w-2 rounded-full bg-[#3b82f6]" /> Booking
                </span>
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* Sticky bottom action */}
      <div className="fixed bottom-[88px] left-1/2 z-30 w-full max-w-[480px] -translate-x-1/2 bg-gradient-to-t from-background via-background to-transparent px-5 pb-2 pt-8">
        <button
          type="button"
          onClick={addToDay}
          className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-full bg-primary text-on-primary text-label-md font-bold shadow-lg transition-colors hover:bg-primary-container"
        >
          <Icon name="add" size={20} />
          Add to this day
        </button>
      </div>
    </div>
  );
}
