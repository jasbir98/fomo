import "server-only";
import type { Candidate, DiscoverChip, NextCard, NowResponse, RankContext } from "@/lib/now/types";
import { generateCandidates } from "@/lib/now/generators";
import { buildRails } from "@/lib/now/rails";

// ---------------------------------------------------------------------------
// Scoring — plan-v1-home-pivot.md §9.4:
//   score = baseScore × urgencyMultiplier × proximityDecay × noveltyDecay × prefFit × coherence
// `coherence` (booked-item clash detection) is left at 1.0 in v1 — the
// generators that could clash with a booked window (gap_filler,
// experience_leadtime) already constrain their own firing conditions, so a
// dedicated conflict pass is deferred rather than half-built here.
// ---------------------------------------------------------------------------

function urgencyMultiplier(candidate: Candidate, at: Date): number {
  const until = new Date(candidate.validUntil).getTime();
  const minutesLeft = (until - at.getTime()) / 60_000;
  if (!Number.isFinite(minutesLeft) || minutesLeft <= 0) return 1.0;
  if (minutesLeft <= 30) return 1.6;
  if (minutesLeft <= 90) return 1.3;
  return 1.0;
}

function proximityDecay(distanceKm: number | null): number {
  if (distanceKm == null) return 1.0; // unanchored (current activity, weather swap, arrival copy) — never penalized
  if (distanceKm <= 0.3) return 1.0;
  if (distanceKm >= 6) return 0;
  return Math.max(0.4, 1 - distanceKm / 6);
}

/** Dismissal count for this exact subject within the signals window (lib/db/signals.ts listRecentSignals, 72h default). One "Nah" damps it hard; two effectively retires it for the window. */
function noveltyDecay(ctx: RankContext, candidate: Candidate): number {
  const dismissals = ctx.recentSignals.filter(
    (s) =>
      s.action === "dismissed" &&
      s.subject_type === candidate.subject.type &&
      s.subject_id === candidate.subject.id
  ).length;
  if (dismissals >= 2) return 0;
  if (dismissals === 1) return 0.15;
  const shownRecently = ctx.recentSignals.some(
    (s) =>
      s.action === "shown" &&
      s.subject_type === candidate.subject.type &&
      s.subject_id === candidate.subject.id
  );
  return shownRecently ? 0.5 : 1.0;
}

const MEAT_HINTS = ["yakitori", "yakiniku", "steak", "bbq", "butcher", "ham", "bacon"];

/** Dietary is a hard filter, not a score (plan-v1-home-pivot.md §9.4) — a vegetarian traveler should never see a meat-forward place ranked at all, not just ranked lower. Best-effort keyword match; not exhaustive. */
function passesHardFilters(ctx: RankContext, candidate: Candidate): boolean {
  const dietary = ctx.prefs?.dietary ?? [];
  if (dietary.some((d) => /vegetarian|vegan/i.test(d))) {
    const hay = candidate.headline.toLowerCase() + " " + candidate.detail.toLowerCase();
    if (MEAT_HINTS.some((hint) => hay.includes(hint))) return false;
  }
  return true;
}

function prefFit(ctx: RankContext, candidate: Candidate): number {
  const interests = ctx.prefs?.interests ?? [];
  if (interests.length === 0) return 1.0;
  const hay = (candidate.headline + " " + candidate.detail).toLowerCase();
  const match = interests.some((i) => hay.includes(i.toLowerCase().split(" ")[0]));
  return match ? 1.2 : 0.85;
}

function scoreCandidate(ctx: RankContext, candidate: Candidate): number {
  return (
    candidate.baseScore *
    urgencyMultiplier(candidate, ctx.at) *
    proximityDecay(candidate.distanceKm) *
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
 * once urgency/proximity have brought them close — it will never override a
 * genuinely urgent card like `leave_by` or `weather_swap`.
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

/**
 * Picks the hero (highest score, with the photo-preference nudge from
 * `pickHeroIndex`) and returns the rest of the subject-deduped pool for
 * lib/now/rails.ts to bucket into situational rails (v1.1 W2). Before W2,
 * this also built a single diversity-constrained "rail" (one card per
 * generator) — that's now unnecessary: each rail already draws from exactly
 * one generator family, so diversity across the page comes from having
 * multiple rails rather than from forcing variety into one.
 */
function selectHeroAndPool(ranked: Candidate[]): { hero: Candidate | null; pool: Candidate[] } {
  const seenSubjects = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of ranked) {
    const key = subjectKey(c);
    if (seenSubjects.has(key)) continue;
    seenSubjects.add(key);
    deduped.push(c);
  }
  if (deduped.length === 0) return { hero: null, pool: [] };

  // Home is image-led (plan-v1-home-pivot.md §4), and only an `ok` image can
  // carry a photo hero (§11.2). A thin-image candidate may still win outright
  // — that's the spec — but when a hero-eligible candidate is scoring within
  // HERO_PHOTO_TOLERANCE of it, prefer the one that renders as a photo. Without
  // this, a single 200px event flyer beats a whole city of photographed places
  // and every Home open lands on the typographic fallback (§15, risk 2).
  const heroIndex = pickHeroIndex(deduped);
  const hero = deduped[heroIndex];
  const pool = deduped.filter((_, i) => i !== heroIndex);

  return { hero, pool };
}

function buildNext(ctx: RankContext): NextCard {
  if (!ctx.nextAnchor) {
    return {
      kind: "empty",
      itemId: null,
      title: ctx.planDensity === "none" ? "Nothing booked today" : "Nothing else today",
      subtitle: ctx.planDensity === "none" ? "Tap to let Roameo build you one" : "Enjoy the rest of the day",
      image: { url: null, quality: "none" },
    };
  }
  const place = ctx.candidatePlaces.find((p) => p.id === ctx.nextAnchor!.place_id);
  const start = new Date(ctx.nextAnchor.starts_at!);
  return {
    kind: "anchor",
    itemId: ctx.nextAnchor.id,
    title: ctx.nextAnchor.title ?? "Next up",
    subtitle: `${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${
      ctx.nextAnchor.location ?? "on your plan"
    }`,
    image: place ? { url: place.image_url, quality: place.image_quality ?? "thin" } : { url: null, quality: "none" },
  };
}

/**
 * Every candidate chip that's actually relevant right now is built first,
 * each carrying a fixed priority — only THEN is the set ranked and capped at
 * 3. The old version pushed gap/eat/tonight unconditionally and only
 * considered "book" for whatever slot was left over, so on any day with an
 * open gap the quota was already full before book was ever weighed — it
 * could structurally never render. Ranking the full relevant set instead
 * means every intent gets a fair shot based on context, not push order.
 *
 * v1.1 W2: Home no longer renders these — it has a fixed five-icon
 * quick-action row instead (app/(shell)/page.tsx), which is the direct fix
 * for the "book" chip's structural unrenderability this comment describes.
 * Kept (and exported) because `/discover/[intent]` still keys off the same
 * `DiscoverChip.intent` slugs this produces; nothing currently calls this
 * function, but it isn't dead in the sense of being safe to delete.
 */
export function buildChips(ctx: RankContext): DiscoverChip[] {
  const isRaining = ctx.weather?.condition === "rainy" || ctx.weather?.condition === "windy";
  const hasGap = ctx.gaps.length > 0;
  const hasEvents = ctx.candidateEvents.length > 0;
  const hasExperiences = ctx.candidateExperiences.length > 0;

  const candidates: (DiscoverChip & { priority: number })[] = [];
  if (hasGap) {
    candidates.push({
      intent: isRaining ? "indoors" : "gap",
      label: isRaining ? "Indoors near me" : "A few hours",
      priority: 4,
    });
  }
  if (hasEvents) candidates.push({ intent: "tonight", label: "Tonight", priority: 3 });
  if (hasExperiences) candidates.push({ intent: "book", label: "Book something", priority: 2 });
  candidates.push({ intent: "eat", label: "Eat near me", priority: 1 });

  return candidates
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3)
    .map(({ intent, label }) => ({ intent, label }));
}

export async function buildNowResponse(ctx: RankContext): Promise<NowResponse> {
  const raw = await generateCandidates(ctx);
  const filtered = raw.filter((c) => passesHardFilters(ctx, c));
  const scored = filtered
    .map((c) => ({ ...c, score: scoreCandidate(ctx, c) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const { hero, pool } = selectHeroAndPool(scored);

  let degraded: NowResponse["degraded"] = null;
  if (!ctx.coords) degraded = "no-location";
  else if (ctx.candidatePlaces.length === 0) degraded = "no-coverage";

  return {
    mode: ctx.planDensity === "none" ? "drifter" : "planner",
    hero,
    next: buildNext(ctx),
    rails: buildRails(ctx, pool),
    degraded,
  };
}
