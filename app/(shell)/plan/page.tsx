"use client";

import { Fragment, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeviceId } from "@/lib/device";
import { createItem, getCurrentTrip, listItems, listPlacesByIds, updateItem } from "@/lib/db";
import type { ItineraryItem, Place, Trip } from "@/lib/types";
import type { DayForecast, WeatherCondition } from "@/lib/weather";
import { WEATHER_THEME } from "@/lib/weatherUi";
import { distanceKm, useGeolocation, walkMinutes } from "@/lib/geo";
import type { DayPlanResponse, GapBlock } from "@/lib/now/types";
import type { DraftDayResponse, DraftItemSuggestion } from "@/lib/now/draftDay";
import { Button, Card, Icon, SegmentedControl, StatusPill } from "@/components/ui";
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
 * Straight-line-distance leave-by estimate for a timeline row (v1.1 W4 #1) —
 * "Leave 19:05 · 12 min walk". No routing/ETA API is wired up anywhere in
 * this codebase (lib/now/generators.ts's server-only `walkMinutes` is the
 * same approximation the ranker already uses for every other walk-time
 * line), so this reuses that same ~4.8km/h straight-line heuristic via the
 * client copy in lib/geo.ts. `origin` is the previous stop's place (or the
 * traveller's live location for the day's first stop) — see
 * `itemsWithLogistics` below for how that's threaded through the day.
 */
function computeLogistics(
  item: ItineraryItem,
  origin: { lat: number; lng: number } | null,
  dest: { lat: number; lng: number } | null
): { leaveLabel: string; walkLabel: string } | null {
  if (!item.starts_at || !origin || !dest) return null;
  const minutes = walkMinutes(distanceKm(origin, dest));
  const leaveAt = new Date(new Date(item.starts_at).getTime() - minutes * 60_000);
  return {
    leaveLabel: leaveAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    walkLabel: `${minutes} min walk`,
  };
}

/**
 * A thin rule between timeline rows carrying the gap's free time
 * (plan-v1.1-overhaul.md W4 #2) — tapping it expands the same candidate list
 * the old always-open GapBlockView rendered (now 6 cards, W4 #3), rather
 * than being a second parallel implementation of gap-candidate rendering.
 */
function GapConnector({
  gap,
  expanded,
  onToggle,
  deviceId,
  tripId,
  onAdded,
}: {
  gap: GapBlock;
  expanded: boolean;
  onToggle: () => void;
  deviceId: string;
  tripId: string;
  onAdded: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-2 px-1 py-1 text-left"
      >
        <span className="h-px flex-1 bg-outline-variant/60" aria-hidden="true" />
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-secondary">
          {gap.label}
          <Icon name={expanded ? "expand_less" : "expand_more"} size={14} />
        </span>
        <span className="h-px flex-1 bg-outline-variant/60" aria-hidden="true" />
      </button>
      {expanded ? (
        gap.candidates.length === 0 ? (
          <p className="px-1 pb-1 text-label-sm text-on-surface-variant">Nothing lines up for this window yet.</p>
        ) : (
          <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-outline-variant p-3">
            <div className="flex gap-2.5 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
              {gap.candidates.map((c) => (
                <div key={`${c.subject.type}:${c.subject.id}`} className="shrink-0">
                  <RoameoCard candidate={c} variant="tile" deviceId={deviceId} tripId={tripId} onAdded={onAdded} />
                </div>
              ))}
            </div>
            <Link
              href={`/discover/gap?minutes=${Math.max(0, Math.round(gap.minutes))}`}
              className="flex w-fit items-center gap-1 text-label-sm font-semibold text-primary hover:underline"
            >
              More for this gap
              <Icon name="arrow_forward" size={14} />
            </Link>
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * "Draft my day" (plan-v1.1-overhaul.md W4 #4) — the empty-day state. Calls
 * `POST /api/now/draft-day`, shows ~3 suggested items, and lets the
 * traveller accept (reuses the same `createItem` mutation every other
 * "Add to today" action in the app uses) or ignore each one individually.
 * `autoOpen` fires the draft automatically — Home's "Nothing booked today"
 * entry point (app/(shell)/page.tsx) links here with `?draftDay=1` rather
 * than opening a menu of four tiles that all led to the same form.
 */
function DraftDayBlock({
  day,
  deviceId,
  tripId,
  coords,
  autoOpen,
  onAccepted,
}: {
  day: string;
  deviceId: string;
  tripId: string;
  coords: { lat: number; lng: number } | null;
  autoOpen: boolean;
  onAccepted: () => void;
}) {
  // Lazy-initialized from `autoOpen` (Home's ?draftDay=1 entry point) rather
  // than set from inside an effect — the parent gives this component a
  // `key={selectedDay}` so a fresh instance (and a fresh initializer run)
  // exists per day, same as any other per-day reset here.
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "empty">(() =>
    autoOpen ? "loading" : "idle"
  );
  const [suggestions, setSuggestions] = useState<DraftItemSuggestion[]>([]);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [addingId, setAddingId] = useState<string | null>(null);

  // Pure data fetch — deliberately calls no setState itself. The
  // set-state-in-effect lint rule flags *any* setState reachable from a
  // function invoked directly inside an effect body, even behind an
  // `await`, so (matching every other effect in this file) the actual
  // setState calls below live inline in each call site's own async IIFE
  // instead of inside a shared named async function.
  async function fetchDraft(): Promise<DraftDayResponse> {
    const res = await fetch("/api/now/draft-day", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, tripId, day, lat: coords?.lat, lng: coords?.lng }),
    });
    return (await res.json()) as DraftDayResponse;
  }

  function draft() {
    setStatus("loading");
    (async () => {
      try {
        const json = await fetchDraft();
        setSuggestions(json.suggestions);
        setResolvedIds(new Set());
        setStatus(json.suggestions.length > 0 ? "ready" : "empty");
      } catch (err) {
        console.error("[plan] draft-day failed", err);
        setStatus("empty");
      }
    })();
  }

  useEffect(() => {
    if (!autoOpen) return;
    // `status` already starts "loading" (see the initializer above) — this
    // just kicks off the fetch that fills it in. Fires once per mount when
    // Home links in with ?draftDay=1 — deliberately not re-running on `day`
    // changes (switching days manually shouldn't silently re-trigger a
    // draft fetch the traveller didn't ask for again).
    let cancelled = false;
    (async () => {
      try {
        const json = await fetchDraft();
        if (cancelled) return;
        setSuggestions(json.suggestions);
        setResolvedIds(new Set());
        setStatus(json.suggestions.length > 0 ? "ready" : "empty");
      } catch (err) {
        if (!cancelled) {
          console.error("[plan] draft-day failed", err);
          setStatus("empty");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);

  async function accept(s: DraftItemSuggestion) {
    if (addingId) return;
    setAddingId(s.id);
    try {
      await createItem(deviceId, {
        trip_id: tripId,
        day_date: day,
        time_label: s.timeLabel,
        starts_at: s.startsAt,
        duration_minutes: null,
        category: s.category,
        title: s.title,
        location: s.location,
        weather_alert: false,
        color_tag: s.category === "dining" ? "orange" : "green",
        place_id: s.subject.id,
      });
      setResolvedIds((prev) => new Set(prev).add(s.id));
      onAccepted();
    } catch (err) {
      console.error("[plan] draft accept failed", err);
    } finally {
      setAddingId(null);
    }
  }

  function ignore(s: DraftItemSuggestion) {
    setResolvedIds((prev) => new Set(prev).add(s.id));
  }

  if (status === "idle") {
    return (
      <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed border-outline-variant/60 p-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-fixed text-primary">
          <Icon name="auto_awesome" size={26} filled />
        </div>
        <div>
          <h3 className="text-headline-sm text-primary">Nothing planned for this day yet</h3>
          <p className="mt-1 text-body-md text-on-surface-variant">Let Roameo put a few ideas together.</p>
        </div>
        <Button variant="navy" onClick={() => void draft()}>
          Draft my day
        </Button>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="mt-6 flex flex-col items-center gap-2 py-10 text-center">
        <Icon name="auto_awesome" size={28} className="animate-pulse text-primary" />
        <p className="text-body-md text-on-surface-variant">Putting a day together…</p>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed border-outline-variant/60 p-6 text-center">
        <p className="text-body-md text-on-surface-variant">
          Roameo doesn&rsquo;t know this area well enough yet to draft a day here — try adding something yourself.
        </p>
      </div>
    );
  }

  const remaining = suggestions.filter((s) => !resolvedIds.has(s.id));

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div>
        <h3 className="text-headline-sm text-primary">A day, drafted</h3>
        <p className="mt-0.5 text-body-md text-on-surface-variant">Accept what you like, ignore the rest.</p>
      </div>
      {remaining.length === 0 ? (
        <p className="text-body-md text-on-surface-variant">
          All set — {suggestions.length > 1 ? "those" : "that"} either made it onto your day or got skipped.
        </p>
      ) : (
        remaining.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-xl border border-outline-variant/60 bg-surface-container-lowest p-3"
          >
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-container">
              {s.image.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.image.url} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary to-primary-container">
                  <Icon name={categoryMeta(s.category).icon} size={20} filled className="text-on-primary/70" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-on-surface-variant">
                {s.timeLabel} · {categoryMeta(s.category).label}
              </p>
              <h4 className="truncate text-label-md font-bold text-primary">{s.title}</h4>
              <p className="truncate text-label-sm text-on-surface-variant">{s.why}</p>
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              <button
                type="button"
                disabled={addingId === s.id}
                onClick={() => void accept(s)}
                aria-label="Accept"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container disabled:opacity-60"
              >
                <Icon name="check" size={18} />
              </button>
              <button
                type="button"
                onClick={() => ignore(s)}
                aria-label="Ignore"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-outline-variant text-on-surface-variant"
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function PlanPageInner() {
  const deviceId = useDeviceId();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [items, setItems] = useState<ItineraryItem[]>([]);
  const [placesById, setPlacesById] = useState<Record<string, Place>>({});
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
  // Same trick as dismissedForDay above — track *which* day "Other options"
  // is open for and compare against selectedDay, rather than a plain
  // boolean + an effect to reset it when the day changes.
  const [otherOptionsShownForDay, setOtherOptionsShownForDay] = useState<string | null>(null);
  const showOtherOptions = otherOptionsShownForDay === selectedDay;
  // Gap keys are each gap's full ISO startsAt, which already encodes the
  // day — entries from a previously-viewed day simply never match any gap
  // rendered for a different day, so this needs no day-keyed reset either.
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set());
  // Bumped after any local mutation (a swap, an accepted draft suggestion, a
  // gap/disruption candidate added inline) that the dayPlan/items fetches
  // wouldn't otherwise notice — same pattern app/(shell)/events/page.tsx
  // uses for its own refreshTick (v1.1 W4 #6). Included in the dayPlan
  // fetch's dependency array below so a swap or an add elsewhere on this
  // page actually refreshes gaps/disruption instead of going stale.
  const [refreshTick, setRefreshTick] = useState(0);
  const { coords } = useGeolocation();

  const dayParam = searchParams.get("day");
  const autoOpenDraft = searchParams.get("draftDay") === "1";

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

  // Batch-resolve each item's place_id (timeline thumbnails + leave-by
  // origin/destination, v1.1 W4 #1) via the existing listPlacesByIds
  // batch-fetch helper (lib/db/places.ts) — no new query shape needed.
  useEffect(() => {
    const ids = Array.from(new Set(items.map((i) => i.place_id).filter((id): id is string => !!id)));
    // No place-bearing items — leave any previously-resolved entries as-is
    // rather than resetting synchronously in the effect body (same
    // no-op-when-empty convention the forecast effect below uses); stale
    // entries for place_ids no longer on this day are harmless since lookups
    // below are always by the current item's own place_id.
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listPlacesByIds(ids);
        if (!cancelled) setPlacesById(Object.fromEntries(rows.map((p) => [p.id, p])));
      } catch (err) {
        console.error("[plan] place lookup failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

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
  // selected day, past or future. `refreshTick` (v1.1 W4 #6) is the fix for
  // this previously never refreshing after a swap or an add elsewhere on
  // this same page.
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
  }, [deviceId, trip, selectedDay, coords, refreshTick]);

  /** Re-fetches both `items` and (via `refreshTick`) the day plan — the single mutation-completion hook every local write on this page funnels through (v1.1 W4 #6). */
  async function refetchAll() {
    if (deviceId && trip) {
      try {
        const rows = await listItems(deviceId, trip.id);
        setItems(rows);
      } catch (err) {
        console.error("[plan] refetch failed", err);
      }
    }
    setRefreshTick((t) => t + 1);
  }

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
      await refetchAll();
      setDismissedForDay(selectedDay);
    } catch (err) {
      console.error("[plan] swap failed", err);
    }
  }

  function toggleGap(key: string) {
    setExpandedGaps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
  // which always shows exactly one pre-selected day. A `?day=` query param
  // (Home's draft-day entry point, or any future deep link) wins over both
  // when it names a real day in this trip. Adjusting state during render
  // (converging: the guard is false once set) is the React-sanctioned
  // pattern for deriving initial state from freshly-loaded data.
  if (!selectedDay && days.length > 0) {
    const fromQuery = dayParam && days.includes(dayParam) ? dayParam : null;
    const firstWithItems = days.find((d) => (itemsByDay.get(d)?.length ?? 0) > 0);
    setSelectedDay(fromQuery ?? firstWithItems ?? days[0]);
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

  const selectedItems = useMemo(
    () => (selectedDay ? itemsByDay.get(selectedDay) ?? [] : []),
    [selectedDay, itemsByDay]
  );

  // Threads each row's leave-by origin from the previous stop's resolved
  // place coordinates, falling back to the traveller's live location for the
  // day's first stop (v1.1 W4 #1) — computed once per render of the selected
  // day's items rather than inline per-row, since each row's origin depends
  // on the row before it. A plain loop (not `.map()`) so the running
  // `origin` is a local variable reassigned once per iteration inside a
  // single function body, not a closure mutated across separate `.map()`
  // callback invocations.
  const itemsWithLogistics = useMemo(() => {
    const result: { item: ItineraryItem; place: Place | null; logistics: ReturnType<typeof computeLogistics> }[] = [];
    let origin = coords;
    for (const item of selectedItems) {
      const place = item.place_id ? placesById[item.place_id] : null;
      const dest = place && place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null;
      const logistics = computeLogistics(item, origin, dest);
      if (dest) origin = dest;
      result.push({ item, place, logistics });
    }
    return result;
  }, [selectedItems, placesById, coords]);

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
              weather + real per-city alternatives via /api/now/day, and now
              fires from that real forecast rather than requiring the manual
              weather_alert toggle (v1.1 W4 #5). */}
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
              {dayPlan.disruption.otherOptions.length > 0 ? (
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => setOtherOptionsShownForDay((prev) => (prev === selectedDay ? null : selectedDay))}
                    aria-expanded={showOtherOptions}
                    className="flex items-center gap-1 text-label-sm font-semibold text-on-primary/90 hover:underline"
                  >
                    Other options
                    <Icon name={showOtherOptions ? "expand_less" : "expand_more"} size={16} />
                  </button>
                  {showOtherOptions ? (
                    <div className="mt-2 flex gap-2.5 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden">
                      {dayPlan.disruption.otherOptions.map((c) => (
                        <div key={`${c.subject.type}:${c.subject.id}`} className="shrink-0">
                          <RoameoCard
                            candidate={c}
                            variant="tile"
                            deviceId={deviceId}
                            tripId={trip.id}
                            onAdded={() => void refetchAll()}
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Item cards for the selected day, with gap connectors
              (plan-v1-home-pivot.md §5.3, v1.1 W4 #2/#3) interleaved by
              position — a gap with afterItemId=null renders before the
              first item, others render immediately after the item they
              follow. An empty day never renders blank text (v1.1 W4 #4): it
              renders the real "Draft my day" block instead. */}
          <div className="flex flex-1 flex-col gap-3 px-5 pb-32 pt-2">
            {selectedItems.length === 0 ? (
              <DraftDayBlock
                // Remounts per day (fresh status/suggestions state) rather
                // than reusing one instance across day switches — also what
                // lets `status`'s lazy initializer below react to `autoOpen`
                // correctly on first mount instead of needing an effect to
                // set it.
                key={selectedDay ?? "draft"}
                day={selectedDay ?? trip.start_date ?? ""}
                deviceId={deviceId}
                tripId={trip.id}
                coords={coords}
                autoOpen={autoOpenDraft && selectedDay === dayParam}
                onAccepted={() => void refetchAll()}
              />
            ) : (
              <>
                {dayPlan?.gaps
                  .filter((g) => g.afterItemId === null)
                  .map((gap) => (
                    <GapConnector
                      key={`${gap.startsAt}-lead`}
                      gap={gap}
                      expanded={expandedGaps.has(gap.startsAt)}
                      onToggle={() => toggleGap(gap.startsAt)}
                      deviceId={deviceId}
                      tripId={trip.id}
                      onAdded={() => void refetchAll()}
                    />
                  ))}
                {itemsWithLogistics.map(({ item, place, logistics }) => {
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
                        className="relative flex h-[88px] cursor-pointer items-center gap-3 overflow-hidden pr-4 transition-opacity hover:opacity-90"
                        style={
                          dayForecast ? { backgroundColor: CARD_WEATHER_BG[dayForecast.condition] } : undefined
                        }
                      >
                        <span className={`absolute left-0 top-0 bottom-0 w-1 ${barClass}`} aria-hidden="true" />
                        {/* 56×56 thumbnail (v1.1 W4 #1) — sourced from
                            place_id → places.image_url, falling back to the
                            same navy-gradient + category-glyph placeholder
                            components/roameo/Card.tsx uses for a missing
                            photo, so a photo-less item still lines up with
                            the rest of the app rather than collapsing the
                            layout. */}
                        <div className="ml-4 h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-container">
                          {place?.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={place.image_url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary to-primary-container">
                              <Icon name={meta.icon} size={22} filled className="text-on-primary/70" />
                            </div>
                          )}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-medium text-on-surface-variant">
                              <Icon name={meta.icon} size={12} />
                              {[item.time_label, meta.label].filter(Boolean).join(" • ")}
                            </span>
                            {item.weather_alert ? (
                              <StatusPill label="Rain expected" tone="error" icon="warning" />
                            ) : weatherTheme ? (
                              <span
                                className={`flex shrink-0 items-center gap-1 text-[11px] font-semibold ${weatherTheme.iconClass}`}
                              >
                                <Icon name={weatherTheme.icon} size={14} filled />
                                {weatherTheme.label}
                              </span>
                            ) : null}
                          </div>
                          <h3 className="truncate text-[15px] font-bold leading-tight text-primary">{item.title}</h3>
                          {logistics ? (
                            <p className="truncate text-[11px] font-semibold text-secondary">
                              Leave {logistics.leaveLabel} · {logistics.walkLabel}
                            </p>
                          ) : item.location ? (
                            <p className="truncate text-label-sm text-on-surface-variant">{item.location}</p>
                          ) : null}
                        </div>
                      </Card>
                      {trailingGaps.map((gap) => (
                        <GapConnector
                          key={gap.startsAt}
                          gap={gap}
                          expanded={expandedGaps.has(gap.startsAt)}
                          onToggle={() => toggleGap(gap.startsAt)}
                          deviceId={deviceId}
                          tripId={trip.id}
                          onAdded={() => void refetchAll()}
                        />
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

export default function PlanPage() {
  return (
    <Suspense fallback={null}>
      <PlanPageInner />
    </Suspense>
  );
}
