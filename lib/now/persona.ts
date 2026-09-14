import "server-only";
import type { CardSignal, Place, TravelPreferences } from "@/lib/types";
import { interestsForPlace, type InterestTag } from "@/lib/taxonomy";

/**
 * Persona schema (Phase 5, plan-v1.2-accounts.md §C.4) — one resolved view
 * so generators read `ctx.persona.x` instead of each null-coalescing
 * `prefs?.x ?? default` independently.
 *
 * These unions aren't re-exported from anywhere canonical yet — the setup
 * screens each declare their own local copy today
 * (components/onboarding/TasteForm.tsx's `BudgetBand`/`WalkTolerance`).
 * Duplicated here rather than imported: TasteForm.tsx is a "use client"
 * component, and this file is server-only — importing it would either pull
 * client-component code into the server bundle or vice versa. The string
 * literals are the real contract (they're what's written to Postgres); the
 * type names are just labels on top of it.
 *
 * `party`/`firstTime`/`planStage` were trip-scoped (read off the now-deleted
 * `trips` table's party_type/first_time/plan_stage columns) and are gone
 * with the trip layer — nothing reads them once lib/now/rails.ts is deleted.
 * `hasYoungKids` had the same source and is kept only because `familyPick`
 * (lib/now/generators.ts) and reach.ts's `effectiveWalkTolerance` still read
 * it; with no trip to carry `kid_ages` anymore it's permanently `false` —
 * `familyPick` is effectively dormant until a person-scoped replacement
 * exists. See the v0 report for this trade-off.
 */
export type BudgetBand = "shoestring" | "middle" | "treat";
export type WalkTolerance = "high" | "medium" | "low";
export type Pace = "packed" | "balanced" | "slow";
export type DayRhythm = "early" | "steady" | "night";

export interface Persona {
  budget: BudgetBand;
  dietary: string[];
  walk: WalkTolerance;
  interests: Set<InterestTag>;
  cuisines: Set<string>;
  pace: Pace;
  rhythm: DayRhythm;
  /** Always false — see the file doc comment above. */
  hasYoungKids: boolean;
  /** True once at least one person-scoped taste field has been answered. */
  stated: boolean;
  /** 0..1 — share of the ~6 person-scoped taste fields that are non-null. Damps `prefFit` at cold start (Phase 6, plan §D.1/§D.8) so a traveller who answered one screen isn't hard-steered by it. */
  confidence: number;
}

/** The person-scoped taste fields `confidence` is computed over — see supabase/add_person_persona.sql. Kept as a single list so the denominator and the field checks can't drift apart. */
const CONFIDENCE_FIELDS = 6;

function countAnsweredTasteFields(prefs: TravelPreferences | null): number {
  if (!prefs) return 0;
  let n = 0;
  if (prefs.budget_band) n++;
  if (prefs.walk_tolerance) n++;
  if (prefs.interest_tags?.length) n++;
  if (prefs.cuisine_tags?.length) n++;
  if (prefs.day_rhythm) n++;
  if (prefs.pace) n++;
  return n;
}

/**
 * Resolves the traveller's persona from person-scoped `travel_preferences`
 * (may not exist yet — `getPreferences` returns null until the traveller
 * has saved anything). Must never throw and must always return a
 * fully-populated object — every field here has a sane fallback, because
 * most setup screens are skippable by design and a skipped answer is the
 * common case, not an edge case.
 *
 * Defaults deliberately mirror the values the setup screens themselves
 * default their controls to (e.g. `pace: "balanced"`, `rhythm: "steady"`),
 * so a resolved Persona for someone who skipped everything reads the same
 * as what the (unsaved) form would have shown them.
 */
export function resolvePersona(prefs: TravelPreferences | null): Persona {
  const confidence = countAnsweredTasteFields(prefs) / CONFIDENCE_FIELDS;

  return {
    budget: (prefs?.budget_band as BudgetBand | null) ?? "middle",
    dietary: prefs?.dietary ?? [],
    walk: (prefs?.walk_tolerance as WalkTolerance | null) ?? "medium",
    interests: new Set((prefs?.interest_tags ?? []) as InterestTag[]),
    cuisines: new Set(prefs?.cuisine_tags ?? []),
    pace: (prefs?.pace as Pace | null) ?? "balanced",
    rhythm: (prefs?.day_rhythm as DayRhythm | null) ?? "steady",
    hasYoungKids: false,
    stated: confidence > 0,
    confidence,
  };
}

/**
 * Interest tags implied by places the traveller has positively signaled
 * (saved, not dismissed — a "Nah" says nothing about taste, only about that
 * one card). Phase 6 unions this in at half weight, and only once
 * `recentSignals` holds >= 8 entries (plan §D.8); this function only builds
 * the set, it doesn't gate or weight it — nothing calls it yet.
 */
export function learnedInterests(signals: CardSignal[], places: Place[]): Set<InterestTag> {
  const placeById = new Map(places.map((p) => [p.id, p]));
  const result = new Set<InterestTag>();
  for (const signal of signals) {
    if (signal.action !== "saved" || signal.subject_type !== "place") continue;
    const place = placeById.get(signal.subject_id);
    if (!place) continue;
    for (const tag of interestsForPlace(place)) result.add(tag);
  }
  return result;
}
