import "server-only";
import { closingSoon, reelEcho } from "@/lib/now/generators";
import type { Candidate, Rail, RankContext } from "@/lib/now/types";

/**
 * Every generator id lib/now/rails.ts's registry can point a rail at. A
 * subset of the full generator-id space in lib/now/generators.ts — only the
 * ones a rail actually draws from (weather_swap/current_activity/leave_by/
 * arrival feed the hero slot only and never appear in a rail).
 */
export type GeneratorId =
  | "gap_filler"
  | "near_next"
  | "event_tonight"
  | "closing_soon"
  | "indoor_pick"
  | "experience_pick"
  | "reel_echo"
  | "saved_pick";

export interface RailSpec {
  id: string;
  /** Hidden when false — coarse, ctx-only gate. The real backstop is `minItems` below, checked after generation. */
  condition: (ctx: RankContext) => boolean;
  /** Situation, never a data source — "2h 50m before dinner", not "Places". */
  title: (ctx: RankContext) => string;
  /** One causal line — why this rail, why now. Rendered as SectionHeader's `meta`. */
  reason: (ctx: RankContext) => string;
  generators: GeneratorId[];
  seeAll: (ctx: RankContext) => string;
  /** Rail is dropped entirely when its generated item count falls below this. */
  minItems: number;
}

/** Per-rail cap — mirrors the old single-rail RAIL_SIZE (lib/now/rank.ts, v1.1 W1: 5→10). */
const RAIL_MAX_ITEMS = 10;

function isRainingNow(ctx: RankContext): boolean {
  // Day-level forecast only (lib/weather.ts has no hourly granularity) — the
  // same "today's condition stands in for right now" proxy weatherSwap and
  // gapFiller already use elsewhere in this package.
  return ctx.weather?.condition === "rainy" || ctx.weather?.condition === "windy";
}

function cityName(ctx: RankContext): string {
  return ctx.trip.destination?.split(",")[0]?.trim() || "town";
}

function gapDurationPrefix(minutes: number): string {
  // Round the total first, then split into h/m — rounding each part
  // separately can carry a 59.6min remainder up to "60m".
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return hours > 0 ? `${hours}h ${mins > 0 ? `${mins}m ` : ""}` : `${mins}m `;
}

function eventsWithinHours(ctx: RankContext, hours: number): number {
  const until = ctx.at.getTime() + hours * 3_600_000;
  return ctx.candidateEvents.filter((e) => {
    const start = new Date(e.starts_at).getTime();
    return start >= ctx.at.getTime() && start <= until;
  }).length;
}

/**
 * The rail registry (v1.1 W2) — the Home page renders whatever this returns,
 * in this order. Each entry is a situation, not a data source: title/reason
 * are written from the traveller's point of view, and `condition` is the
 * whole trick that keeps Home from reading as an unconditional dashboard —
 * a rail simply doesn't exist on a request where its condition is false.
 */
export const RAIL_REGISTRY: RailSpec[] = [
  {
    id: "gap",
    condition: (ctx) => ctx.gaps.length > 0,
    title: (ctx) => {
      const gap = ctx.gaps[0];
      if (!gap) return "Free time";
      const prefix = gapDurationPrefix(gap.minutes);
      return ctx.nextAnchor?.title ? `${prefix}before ${ctx.nextAnchor.title}` : `${prefix}free`;
    },
    reason: (ctx) =>
      isRainingNow(ctx) ? "Rain nearby — good time to duck inside" : "Enough time to fit something in nearby",
    generators: ["gap_filler"],
    seeAll: () => "/discover/gap",
    minItems: 1,
  },
  {
    id: "near_next",
    condition: (ctx) => ctx.nextAnchorCoords != null,
    title: () => "Near your next stop",
    reason: (ctx) => (ctx.nextAnchor?.title ? `Around ${ctx.nextAnchor.title}` : "Around your next stop"),
    generators: ["near_next"],
    seeAll: () => "/discover/near-next",
    minItems: 1,
  },
  {
    id: "tonight",
    condition: (ctx) => eventsWithinHours(ctx, 6) > 0,
    title: (ctx) => `Tonight in ${cityName(ctx)}`,
    reason: (ctx) => {
      const n = eventsWithinHours(ctx, 6);
      return n > 1 ? `${n} events on nearby` : "One event on nearby";
    },
    generators: ["event_tonight"],
    seeAll: () => "/events",
    minItems: 1,
  },
  {
    id: "closing",
    condition: (ctx) => closingSoon(ctx, new Set()).length >= 2,
    title: () => "Closing within the hour",
    reason: (ctx) => `${closingSoon(ctx, new Set()).length} places nearby shut within 90 min`,
    generators: ["closing_soon"],
    seeAll: () => "/discover/closing",
    minItems: 2,
  },
  {
    id: "indoors",
    condition: (ctx) => isRainingNow(ctx),
    title: () => "Somewhere dry",
    reason: () => "It's raining — these are all indoors",
    generators: ["indoor_pick"],
    seeAll: () => "/discover/indoors",
    minItems: 1,
  },
  {
    id: "book",
    condition: (ctx) => ctx.candidateExperiences.length > 0,
    title: () => "Worth booking ahead",
    reason: () => "Popular tours fill up — reserve today for tomorrow",
    generators: ["experience_pick"],
    seeAll: () => "/experiences",
    minItems: 1,
  },
  {
    id: "reels",
    condition: (ctx) => reelEcho(ctx, new Set()).length > 0,
    title: () => "From reels you watched",
    reason: () => "Close enough to walk to now",
    generators: ["reel_echo"],
    seeAll: () => "/reels",
    minItems: 1,
  },
  {
    id: "saved",
    condition: (ctx) => ctx.savedItems.length > 0,
    title: () => "You saved these",
    reason: () => "From your saves, ready when you are",
    generators: ["saved_pick"],
    seeAll: () => "/saved",
    minItems: 1,
  },
];

/**
 * Resolves the registry against one request: `pool` is the already
 * hard-filtered, scored, subject-deduped candidate list with the hero's own
 * subject removed (lib/now/rank.ts). Each rail buckets `pool` by its
 * `generators` list, sorted by score, capped at RAIL_MAX_ITEMS — a rail whose
 * condition fails, or whose bucket comes up short of `minItems`, is simply
 * omitted from the result rather than rendered empty.
 */
export function buildRails(ctx: RankContext, pool: Candidate[]): Rail[] {
  const rails: Rail[] = [];
  for (const spec of RAIL_REGISTRY) {
    if (!spec.condition(ctx)) continue;
    const items = pool
      .filter((c) => (spec.generators as string[]).includes(c.generator))
      .sort((a, b) => b.score - a.score)
      .slice(0, RAIL_MAX_ITEMS);
    if (items.length < spec.minItems) continue;
    rails.push({
      id: spec.id,
      title: spec.title(ctx),
      meta: spec.reason(ctx),
      items,
      seeAllHref: spec.seeAll(ctx),
    });
  }
  return rails;
}
