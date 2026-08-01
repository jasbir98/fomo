import "server-only";
import { getTrip } from "@/lib/db/trips";
import { listItemsByDay } from "@/lib/db/items";
import { getForecastForDestination, pickForecastDay } from "@/lib/weather";
import { buildDisruptionAlert, getAlternatives } from "@/lib/disruption";
import { loadCandidatePlaces } from "@/lib/now/context";
import { candidatesForGap } from "@/lib/now/generators";
import type { ItineraryItem } from "@/lib/types";
import type { Coordinates } from "@/lib/geo";
import type { DayPlanResponse, DisruptionBlock, GapBlock } from "@/lib/now/types";

const DEFAULT_DURATION_MINUTES = 90;
const MIN_GAP_MINUTES = 90;
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 22;

function itemEnd(item: ItineraryItem): Date | null {
  if (!item.starts_at) return null;
  return new Date(new Date(item.starts_at).getTime() + (item.duration_minutes ?? DEFAULT_DURATION_MINUTES) * 60_000);
}

/** Formats a UTC-offset in seconds as an ISO offset suffix, e.g. 32400 -> "+09:00", -18000 -> "-05:00". */
function offsetSuffix(utcOffsetSeconds: number): string {
  const sign = utcOffsetSeconds >= 0 ? "+" : "-";
  const abs = Math.abs(utcOffsetSeconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function gapLabel(minutes: number): string {
  // Round the total first, then split into h/m — rounding each part
  // separately can carry a 59.6min remainder up to "60m" (e.g. "18h 60m").
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return hours > 0 ? `${hours}h ${mins > 0 ? `${mins}m ` : ""}free` : `${mins}m free`;
}

/**
 * Pure gap math for a whole day (no "now" dependency, unlike
 * lib/now/context.ts's computeGaps — Plan shows any day of the trip, past or
 * future, so gaps here run day-start (08:00) to day-end (22:00) rather than
 * from the live clock). Returns each gap tagged with the item it follows, so
 * the caller can interleave gap blocks into the timeline in render order.
 *
 * `utcOffsetSeconds` anchors 08:00/22:00 to the *destination's* local time
 * (from Open-Meteo's `timezone=auto` lookup, see lib/weather.ts) rather than
 * UTC — building day bounds in UTC silently shifts them by the
 * destination's offset (e.g. Tokyo's day would run 17:00-07:00 local).
 * Falls back to UTC when the offset couldn't be resolved (no destination,
 * geocode/forecast failure) — degrades rather than throwing.
 */
function computeDayGaps(
  day: string,
  items: ItineraryItem[],
  utcOffsetSeconds: number | null
): { startsAt: Date; endsAt: Date; minutes: number; afterItemId: string | null }[] {
  const suffix = utcOffsetSeconds != null ? offsetSuffix(utcOffsetSeconds) : "Z";
  const dayStart = new Date(`${day}T${String(DAY_START_HOUR).padStart(2, "0")}:00:00${suffix}`);
  const dayEnd = new Date(`${day}T${String(DAY_END_HOUR).padStart(2, "0")}:00:00${suffix}`);
  const scheduled = items
    .filter((i) => i.starts_at != null)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());

  const gaps: { startsAt: Date; endsAt: Date; minutes: number; afterItemId: string | null }[] = [];
  if (scheduled.length === 0) {
    const minutes = (dayEnd.getTime() - dayStart.getTime()) / 60_000;
    if (minutes >= MIN_GAP_MINUTES) gaps.push({ startsAt: dayStart, endsAt: dayEnd, minutes, afterItemId: null });
    return gaps;
  }

  const first = new Date(scheduled[0].starts_at!);
  if (first > dayStart) {
    const minutes = (first.getTime() - dayStart.getTime()) / 60_000;
    if (minutes >= MIN_GAP_MINUTES) gaps.push({ startsAt: dayStart, endsAt: first, minutes, afterItemId: null });
  }

  for (let i = 0; i < scheduled.length - 1; i++) {
    const end = itemEnd(scheduled[i]);
    const nextStart = new Date(scheduled[i + 1].starts_at!);
    if (!end || end >= nextStart) continue;
    const minutes = (nextStart.getTime() - end.getTime()) / 60_000;
    if (minutes >= MIN_GAP_MINUTES) gaps.push({ startsAt: end, endsAt: nextStart, minutes, afterItemId: scheduled[i].id });
  }

  const last = scheduled[scheduled.length - 1];
  const lastEnd = itemEnd(last);
  if (lastEnd && lastEnd < dayEnd) {
    const minutes = (dayEnd.getTime() - lastEnd.getTime()) / 60_000;
    if (minutes >= MIN_GAP_MINUTES) gaps.push({ startsAt: lastEnd, endsAt: dayEnd, minutes, afterItemId: last.id });
  }

  return gaps;
}

export interface BuildDayPlanInput {
  deviceId: string;
  tripId: string;
  day: string; // YYYY-MM-DD
  coords: Coordinates | null;
}

/** Assembles Plan's per-day view: the disruption block (if today's forecast conflicts with a flagged item) plus every gap over 90 minutes, each filled with real candidates. Never throws — degrades to an empty (but valid) plan. */
export async function buildDayPlan(input: BuildDayPlanInput): Promise<DayPlanResponse> {
  const { deviceId, tripId, day, coords } = input;
  const trip = await getTrip(deviceId, tripId);
  if (!trip) return { disruption: null, gaps: [], degraded: "no-trip" };

  const [items, candidatePlaces, forecast] = await Promise.all([
    listItemsByDay(deviceId, tripId, day).catch((err) => {
      console.error("[dayplan] listItemsByDay failed", err);
      return [] as ItineraryItem[];
    }),
    loadCandidatePlaces(trip.destination, coords),
    trip.destination
      ? getForecastForDestination(trip.destination).catch(() => ({ center: null, days: [], utcOffsetSeconds: null, degraded: "error" }))
      : Promise.resolve({ center: null, days: [], utcOffsetSeconds: null, degraded: "no-destination" }),
  ]);

  const weather = pickForecastDay(forecast.days, day);
  const isRaining = weather?.condition === "rainy" || weather?.condition === "windy";

  let disruption: DisruptionBlock | null = null;
  if (weather?.isDisruptive && trip.destination) {
    const flagged = items.find((i) => i.weather_alert);
    if (flagged) {
      const alert = buildDisruptionAlert(weather, flagged.title);
      const { alternatives } = await getAlternatives(trip.destination);
      const pick = alternatives[0];
      if (pick) {
        disruption = {
          itemId: flagged.id,
          itemTitle: flagged.title ?? "Your plan",
          why: `Because your ${flagged.time_label ?? ""} plan is outdoors`.replace("  ", " "),
          headline: `${alert.headline.split(" (")[0]}. Move "${flagged.title}" and do ${pick.title} instead.`,
          detail: pick.why,
          alternativeTitle: pick.title,
          alternativeCategory: pick.category,
          alternativeLocation: pick.location,
          alternativeImage: { url: pick.image_url, quality: pick.image_url ? "thin" : "none" },
        };
      }
    }
  }

  const rawGaps = computeDayGaps(day, items, forecast.utcOffsetSeconds);
  const used = new Set<string>();
  const gaps: GapBlock[] = rawGaps.map((g) => {
    const candidates = candidatesForGap(candidatePlaces, g, isRaining, used, coords, 3);
    for (const c of candidates) used.add(`${c.subject.type}:${c.subject.id}`);
    return {
      afterItemId: g.afterItemId,
      startsAt: g.startsAt.toISOString(),
      endsAt: g.endsAt.toISOString(),
      minutes: g.minutes,
      label: gapLabel(g.minutes),
      candidates,
    };
  });

  return { disruption, gaps, degraded: null };
}
