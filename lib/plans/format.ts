/**
 * Words for a plan: the headline ("A £7 weekend in Edinburgh"), the date
 * range and per-line day labels. Shared by the /plan page, its metadata and
 * its OG image. Pure; `day` strings are Edinburgh calendar days.
 */
import { poundsLabel, planTotal, type PlanTotal } from "./price";
import type { PlanItem } from "./types";

function utc(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** "SAT" */
export function dayCode(day: string): string {
  return utc(day).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }).toUpperCase();
}

/** "Sat 17 Oct" */
export function dayLabel(day: string): string {
  return utc(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** "17–18 Oct", "31 Oct – 1 Nov", "17 Oct". */
export function dayRange(days: string[]): string {
  if (days.length === 0) return "";
  const sorted = [...days].sort();
  const a = utc(sorted[0]);
  const b = utc(sorted[sorted.length - 1]);
  const month = (d: Date) => d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  if (sorted[0] === sorted[sorted.length - 1]) return `${a.getUTCDate()} ${month(a)}`;
  if (month(a) === month(b)) return `${a.getUTCDate()}–${b.getUTCDate()} ${month(b)}`;
  return `${a.getUTCDate()} ${month(a)} – ${b.getUTCDate()} ${month(b)}`;
}

/** True when every day falls in one Fri–Sun stretch. */
export function isWeekendPlan(days: string[]): boolean {
  if (days.length === 0) return false;
  const sorted = [...days].sort();
  const first = utc(sorted[0]);
  const spanDays = (utc(sorted[sorted.length - 1]).getTime() - first.getTime()) / 86_400_000;
  const weekend = (d: Date) => [5, 6, 0].includes(d.getUTCDay());
  return spanDays <= 2 && sorted.every((d) => weekend(utc(d)));
}

export interface PlanSummary {
  total: PlanTotal;
  /** "A £7 weekend in Edinburgh", "A free weekend in Edinburgh", "A weekend in Edinburgh: 4 things, 2 free" */
  headline: string;
  /** "17–18 Oct" */
  range: string;
  weekend: boolean;
}

/**
 * The headline states a price only when it is the real one: every line free
 * ("A free weekend"), or every line an exact price ("A £7 weekend"), or a
 * floor ("…from £12.50"). With any price unknown (a "20% off" deal, an event
 * with no listed price) a sum would read as "£0+", which says nothing, so it
 * counts things and free things instead.
 */
export function planSummary(items: PlanItem[]): PlanSummary {
  const total = planTotal(items.map((i) => i.price));
  const days = items.map((i) => i.day);
  const weekend = isWeekendPlan(days);
  const span = weekend ? "weekend" : days.length > 0 && new Set(days).size === 1 ? "day out" : "plan";
  const money = poundsLabel(total.amount);
  const freeCount = items.filter((i) => i.price.amount === 0).length;
  let headline: string;
  if (total.unknown > 0) {
    const lead = span === "plan" ? "An Edinburgh plan" : `A ${span} in Edinburgh`;
    // Non-breaking spaces keep "4 things" and "2 free" on one line when the headline wraps.
    const things = `${items.length}\u00a0thing${items.length === 1 ? "" : "s"}`;
    headline = freeCount > 0 ? `${lead}: ${things}, ${freeCount}\u00a0free` : `${lead}: ${things}`;
  } else if (total.amount === 0) {
    headline = `A free ${span} in Edinburgh`;
  } else if (total.from) {
    headline = `A ${span} in Edinburgh from ${money}`;
  } else {
    headline = `A ${money} ${span} in Edinburgh`;
  }
  return { total, headline, range: dayRange(days), weekend };
}
