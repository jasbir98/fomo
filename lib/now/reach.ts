import "server-only";
import type { Persona, WalkTolerance } from "@/lib/now/persona";

// ---------------------------------------------------------------------------
// Phase 6 (plan §D.4) — one owner for the three radii that used to be
// hardcoded literals scattered across lib/now/generators.ts:
//   closingSoon's `dist > 3`        (3 km flat)   -> reachKm(p, "commit")
//   NEAR_NEXT_RADIUS_KM = 0.8                      -> reachKm(p, "detour")
//   REEL_ECHO_MAX_WALK_MIN = 30 (minutes, not km)  -> reachMinutes(p, "browse")
// "medium" below equals each of those old literals (REEL_ECHO_MAX_WALK_MIN's
// 30 min converted to the equivalent km at the old flat 4.8km/h pace, so all
// three reach kinds live in one persona-scoped km table instead of one being
// minutes-native). low/high scale off medium by roughly the same ratio
// lib/now/rank.ts's WALK_BUDGET table uses for its own low/high proximityDecay
// tiers, so the two systems move the same direction for the same persona.
// ---------------------------------------------------------------------------

export type ReachKind = "browse" | "detour" | "commit";

const REACH_KM: Record<WalkTolerance, Record<ReachKind, number>> = {
  low: { browse: 0.8, detour: 0.3, commit: 1.0 },
  medium: { browse: 2.4, detour: 0.8, commit: 3.0 },
  high: { browse: 4.0, detour: 1.3, commit: 5.0 },
};

/**
 * Same "a child under 5 forces the short reach regardless of what walk
 * tolerance was stated" override lib/now/rank.ts's `proximityDecay` applies —
 * pulled out here so both places share one override instead of two copies
 * that could drift.
 */
export function effectiveWalkTolerance(p: Persona): WalkTolerance {
  return p.hasYoungKids ? "low" : p.walk;
}

export function reachKm(p: Persona, kind: ReachKind): number {
  return REACH_KM[effectiveWalkTolerance(p)][kind];
}

/** Walking-pace-adjusted minutes for a reach kind, e.g. "closing_soon" candidates within `reachMinutes(p, "commit")` minutes. */
export function reachMinutes(p: Persona, kind: ReachKind): number {
  return walkMinutes(reachKm(p, kind), p);
}

/**
 * Persona-aware walking pace (plan §D.4): 4.8 km/h neutral (medium/high walk
 * tolerance, or no persona at all), 4.0 km/h for a stated low tolerance,
 * 3.0 km/h — overriding walk tolerance — with a child under 5 in the party.
 * `p` stays optional so a caller that genuinely has no persona in scope still
 * compiles at the old flat pace, but every call site touched by this phase
 * (lib/now/generators.ts, lib/now/discover.ts, lib/now/draftDay.ts,
 * lib/now/dayplan.ts) now passes one.
 */
export function walkMinutes(km: number, p?: Persona): number {
  const speedKmh = !p ? 4.8 : p.hasYoungKids ? 3.0 : p.walk === "low" ? 4.0 : 4.8;
  return Math.round((km / speedKmh) * 60);
}
