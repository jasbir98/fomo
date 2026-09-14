import "server-only";
import type { Candidate, FeedContext, NowResponse } from "@/lib/now/types";
import { generateCandidates } from "@/lib/now/generators";
import type { WalkTolerance } from "@/lib/now/persona";
import { learnedInterests } from "@/lib/now/persona";
import { effectiveWalkTolerance } from "@/lib/now/reach";
import { priceFit, priceSignalForEvent, priceSignalForExperience, priceSignalForPlace } from "@/lib/now/price";
import { DWELL_MINUTES, HARD_MEAT_CUISINES, interestsForEvent, interestsForExperience, interestsForPlace } from "@/lib/taxonomy";
import type { InterestTag } from "@/lib/taxonomy";

// ---------------------------------------------------------------------------
// Scoring — plan-v1-home-pivot.md §9.4:
//   score = baseScore × urgencyMultiplier × proximityDecay × noveltyDecay × prefFit × coherence
// `coherence` (booked-item clash detection) stays at 1.0 — there is no
// itinerary to clash with anymore.
// ---------------------------------------------------------------------------

function urgencyMultiplier(candidate: Candidate, at: Date): number {
  const until = new Date(candidate.validUntil).getTime();
  const minutesLeft = (until - at.getTime()) / 60_000;
  if (!Number.isFinite(minutesLeft) || minutesLeft <= 0) return 1.0;
  if (minutesLeft <= 30) return 1.6;
  if (minutesLeft <= 90) return 1.3;
  return 1.0;
}

/**
 * Phase 6 rewrite (plan §D.3) of the old flat 0.3/6 literals. `medium`'s
 * values are ~today's hardcoded ones (0.3 -> 0.3, 6 -> 5.0 — tightened
 * slightly to match the plan's literal table). `flat` is the radius that
 * still scores 1.0 (no decay at all); `zero` is where the candidate drops
 * out entirely (score 0).
 */
const WALK_BUDGET: Record<WalkTolerance, { flat: number; zero: number }> = {
  high: { flat: 0.6, zero: 8.0 },
  medium: { flat: 0.3, zero: 5.0 },
  low: { flat: 0.2, zero: 1.6 },
};

/**
 * Widening factor applied to `flat` when `!ctx.coordsAreLive` — the anchor is
 * a stale cached point (lib/db/location.ts's `user_location` fallback, not a
 * fresh browser reading this request), so treating it as precise enough to
 * decay a candidate's score at the same tight radius as a live GPS fix would
 * be pretending to more precision than the data actually has.
 */
const STALE_COORDS_FLAT_WIDEN = 1.5;

/** Rain shrinks the outer reach by 40% — same "today's condition stands in for right now" rainy/windy proxy used elsewhere in lib/now/. */
const RAIN_ZERO_SHRINK = 0.6;

function proximityDecay(ctx: FeedContext, candidate: Candidate): number {
  const distanceKm = candidate.distanceKm;
  if (distanceKm == null) return 1.0; // unanchored — never penalized

  // A child under 5 forces the short-reach tier regardless of what walk
  // tolerance was stated — same override lib/now/reach.ts's reachKm applies,
  // shared via effectiveWalkTolerance so the two systems can't drift apart.
  const tier = WALK_BUDGET[effectiveWalkTolerance(ctx.persona)];
  const flat = ctx.coordsAreLive ? tier.flat : tier.flat * STALE_COORDS_FLAT_WIDEN;
  const isRaining = ctx.weather?.condition === "rainy" || ctx.weather?.condition === "windy";
  const zero = isRaining ? tier.zero * RAIN_ZERO_SHRINK : tier.zero;

  if (distanceKm <= flat) return 1.0;
  if (distanceKm >= zero) return 0;
  return Math.max(0.4, 1 - distanceKm / zero);
}

/** Dismissal count for this exact subject within the signals window (lib/db/signals.ts listRecentSignals, 72h default). One "Nah" damps it hard; two effectively retires it for the window. */
function noveltyDecay(ctx: FeedContext, candidate: Candidate): number {
  const dismissals = ctx.signals.filter(
    (s) =>
      s.action === "dismissed" &&
      s.subject_type === candidate.subject.type &&
      s.subject_id === candidate.subject.id
  ).length;
  if (dismissals >= 2) return 0;
  if (dismissals === 1) return 0.15;
  const shownRecently = ctx.signals.some(
    (s) =>
      s.action === "shown" &&
      s.subject_type === candidate.subject.type &&
      s.subject_id === candidate.subject.id
  );
  return shownRecently ? 0.5 : 1.0;
}

/**
 * Structured evidence only, and only for vegan/vegetarian — no `cuisine`
 * column exists on `places`, so this matches against `place.category` and
 * `place.name` as the documented last-resort structured signal,
 * word-bounded so "hamlet" doesn't match "ham".
 */
function passesHardFilters(ctx: FeedContext, candidate: Candidate): boolean {
  const dietary = ctx.persona.dietary;
  const isVegetarianOrVegan = dietary.some((d) => /vegetarian|vegan/i.test(d));
  if (!isVegetarianOrVegan) return true;
  if (candidate.subject.type !== "place") return true; // no structured cuisine evidence for events/experiences/itinerary items
  const place = ctx.candidatePlaces.find((p) => p.id === candidate.subject.id);
  if (!place) return true;
  const hay = `${place.category ?? ""} ${place.name ?? ""}`.toLowerCase();
  const hitsMeatCuisine = HARD_MEAT_CUISINES.some((cuisine) => new RegExp(`\\b${cuisine}\\b`, "i").test(hay));
  return !hitsMeatCuisine;
}

/**
 * Resolves a candidate back to its underlying place/event/experience by id
 * lookup against the ctx pools that already loaded them — `Candidate` itself
 * carries no interest/price/dwell fields.
 */
function candidateInterestTags(ctx: FeedContext, c: Candidate): Set<InterestTag> {
  if (c.subject.type === "place") {
    const place = ctx.candidatePlaces.find((p) => p.id === c.subject.id);
    return place ? interestsForPlace(place) : new Set();
  }
  if (c.subject.type === "event") {
    const event = ctx.candidateEvents.find((e) => e.id === c.subject.id);
    return event ? interestsForEvent(event) : new Set();
  }
  if (c.subject.type === "experience") {
    const exp = ctx.candidateExperiences.find((e) => e.id === c.subject.id);
    return exp ? interestsForExperience(exp) : new Set();
  }
  return new Set();
}

/**
 * Cold-start wiring (plan §D.8): once 8+ `signals` exist, a place the
 * traveller positively signaled (saved, via `lib/now/persona.ts`'s
 * `learnedInterests`) counts toward interest overlap too, but at HALF the
 * weight of a stated interest.
 */
function interestOverlapScore(ctx: FeedContext, tags: Set<InterestTag>): number {
  let score = 0;
  for (const tag of tags) if (ctx.persona.interests.has(tag)) score += 1;
  if (ctx.signals.length >= 8) {
    const learned = learnedInterests(ctx.signals, ctx.candidatePlaces);
    for (const tag of tags) {
      if (!ctx.persona.interests.has(tag) && learned.has(tag)) score += 0.5;
    }
  }
  return score;
}

/** Tag overlap between the candidate and the persona (plan §D.1). No resolvable tags on the candidate -> 1.0 (neutral, never a penalty). */
function interestFit(ctx: FeedContext, c: Candidate): number {
  const tags = candidateInterestTags(ctx, c);
  if (tags.size === 0) return 1.0;
  const overlap = interestOverlapScore(ctx, tags);
  if (overlap === 0) return ctx.persona.interests.size >= 3 ? 0.9 : 1.0;
  return 1 + 0.15 * Math.min(overlap, 2);
}

function candidatePriceSignal(ctx: FeedContext, c: Candidate) {
  if (c.subject.type === "place") {
    const place = ctx.candidatePlaces.find((p) => p.id === c.subject.id);
    return place ? priceSignalForPlace(place) : null;
  }
  if (c.subject.type === "experience") {
    const exp = ctx.candidateExperiences.find((e) => e.id === c.subject.id);
    return exp ? priceSignalForExperience(exp) : null;
  }
  if (c.subject.type === "event") {
    const event = ctx.candidateEvents.find((e) => e.id === c.subject.id);
    return event ? priceSignalForEvent(event) : null;
  }
  return null;
}

/** Only applies when a price signal exists on the candidate (plan §D.1) — see lib/now/price.ts's `priceFit`. */
function budgetFit(ctx: FeedContext, c: Candidate): number {
  return priceFit(ctx.persona.budget, candidatePriceSignal(ctx, c));
}

/** High-dwell categories only (plan §D.1) — `DWELL_MINUTES >= 60` is this phase's line for "high-dwell". A `slow` persona gets a small bump toward long, sit-down places; `packed` inverts. */
const HIGH_DWELL_MINUTES = 60;

function candidateDwellMinutes(ctx: FeedContext, c: Candidate): number | null {
  if (c.subject.type !== "place") return null;
  const place = ctx.candidatePlaces.find((p) => p.id === c.subject.id);
  if (!place?.category) return null;
  return DWELL_MINUTES[place.category] ?? null;
}

function paceFit(ctx: FeedContext, c: Candidate): number {
  const dwell = candidateDwellMinutes(ctx, c);
  if (dwell == null || dwell < HIGH_DWELL_MINUTES) return 1.0;
  if (ctx.persona.pace === "slow") return 1.1;
  if (ctx.persona.pace === "packed") return 0.9;
  return 1.0;
}

/**
 * The candidate's one relevant clock hour, when it has one — an event's
 * actual start time, or a place's earliest listed opening hour. Experiences
 * carry no opening-hours-equivalent field, so they resolve to null (neutral).
 */
function candidateRelevantHour(ctx: FeedContext, c: Candidate): number | null {
  if (c.subject.type === "event") {
    const event = ctx.candidateEvents.find((e) => e.id === c.subject.id);
    return event ? new Date(event.starts_at).getHours() : null;
  }
  if (c.subject.type === "place") {
    const place = ctx.candidatePlaces.find((p) => p.id === c.subject.id);
    const periods = place?.opening_hours;
    if (!periods || periods.length === 0) return null;
    return Math.min(...periods.map((p) => Number(p.open.split(":")[0])));
  }
  return null;
}

/** `early` favors a candidate timed/opening before 10:00 and penalizes one after 20:00; `night` is the literal inversion. `steady` is neutral throughout. No relevant hour on the candidate -> 1.0. */
function rhythmFit(ctx: FeedContext, c: Candidate): number {
  const hour = candidateRelevantHour(ctx, c);
  if (hour == null) return 1.0;
  const isEarly = hour < 10;
  const isLate = hour >= 20;
  if (!isEarly && !isLate) return 1.0;
  if (ctx.persona.rhythm === "early") return isEarly ? 1.1 : 0.85;
  if (ctx.persona.rhythm === "night") return isEarly ? 0.85 : 1.1;
  return 1.0;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Compresses `value` toward 1.0 as `confidence` falls — confidence 0 (no persona answered at all) always yields 1.0 regardless of `value`; confidence 1 yields `value` unchanged. */
function damp(value: number, confidence: number): number {
  return 1 + (value - 1) * confidence;
}

/**
 * Phase 6 rewrite (plan §D.1) of the old headline-substring `prefFit`. Never
 * suppresses a high-urgency card — persona shouldn't get a vote on "this
 * closes in 10 minutes".
 */
function prefFit(ctx: FeedContext, candidate: Candidate): number {
  if (candidate.urgency === "high") return 1.0;
  const f = interestFit(ctx, candidate) * budgetFit(ctx, candidate) * paceFit(ctx, candidate) * rhythmFit(ctx, candidate);
  return damp(clamp(f, 0.7, 1.45), ctx.persona.confidence);
}

function scoreCandidate(ctx: FeedContext, candidate: Candidate): number {
  return (
    candidate.baseScore *
    urgencyMultiplier(candidate, ctx.at) *
    proximityDecay(ctx, candidate) *
    noveltyDecay(ctx, candidate) *
    prefFit(ctx, candidate)
  );
}

function subjectKey(c: Candidate): string {
  return `${c.subject.type}:${c.subject.id}`;
}

/**
 * How far below the top score a hero-eligible (photo-carrying) candidate may
 * sit and still be promoted over a photo-less leader. 0.75 lets a `local_pick`
 * with a real photo (base 40) outrank an `event_tonight` flyer (base 70) only
 * once urgency/proximity have brought them close.
 */
const HERO_PHOTO_TOLERANCE = 0.75;

function heroEligible(c: Candidate): boolean {
  return c.image.quality === "ok" && c.image.url != null;
}

function pickHeroIndex(deduped: Candidate[]): number {
  if (heroEligible(deduped[0])) return 0;
  // High-urgency leaders are the whole point of the ranker — never demote one
  // for a prettier picture.
  if (deduped[0].urgency === "high") return 0;
  const floor = deduped[0].score * HERO_PHOTO_TOLERANCE;
  const promoted = deduped.findIndex((c) => heroEligible(c) && c.score >= floor);
  return promoted === -1 ? 0 : promoted;
}

/** Picks the hero (highest score, with the photo-preference nudge from `pickHeroIndex`). Rails are gone (v0) — this is now the ranker's only job besides scoring/filtering. */
function selectHero(ranked: Candidate[]): Candidate | null {
  const seenSubjects = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of ranked) {
    const key = subjectKey(c);
    if (seenSubjects.has(key)) continue;
    seenSubjects.add(key);
    deduped.push(c);
  }
  if (deduped.length === 0) return null;

  // Home is image-led (plan-v1-home-pivot.md §4), and only an `ok` image can
  // carry a photo hero (§11.2). A thin-image candidate may still win outright
  // — that's the spec — but when a hero-eligible candidate is scoring within
  // HERO_PHOTO_TOLERANCE of it, prefer the one that renders as a photo.
  return deduped[pickHeroIndex(deduped)];
}

export async function buildNowResponse(ctx: FeedContext): Promise<NowResponse> {
  const raw = await generateCandidates(ctx);
  const filtered = raw.filter((c) => passesHardFilters(ctx, c));
  const scored = filtered
    .map((c) => ({ ...c, score: scoreCandidate(ctx, c) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const hero = selectHero(scored);

  let degraded: NowResponse["degraded"] = null;
  if (!ctx.coords) degraded = "no-location";
  else if (ctx.candidatePlaces.length === 0) degraded = "no-coverage";

  return {
    mode: "drifter",
    hero,
    degraded,
  };
}
