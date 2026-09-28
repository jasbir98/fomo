/**
 * Fomo Home feed — hero recommendation scoring.
 *
 * `happeningHeroScore` (lib/happenings/format.ts) picked the hero from
 * urgency + priority alone, over dated happenings only — provider events
 * (Skiddle/Ticketmaster) and genuine-deal status never entered the score, so
 * an urgent-but-mediocre, image-less row regularly beat a much better pick.
 * This module replaces it with a fuller "how good a recommendation is this"
 * score — value, actionability, scarcity, curation, presentation, trust and
 * audience-fit signals, each capped/weighted so no one factor (urgency,
 * especially) can dominate the rest — plus a short human `reason` string
 * built from whichever factors actually contributed, for the hero card's
 * "why this" pill.
 *
 * Pure and deterministic, same testability rationale as format.ts/
 * book-early.ts: no fetch, no `server-only`, so it can run against fixture
 * data without a live Supabase instance. The route (app/api/feed/route.ts)
 * owns picking the CANDIDATE set (which happenings/events are even in the
 * running for the slot, incl. the "free or cheap events only, starting
 * within 7 days" gate) — this module only scores whatever candidate it's
 * handed.
 *
 * `happeningHeroScore` stays exported from format.ts (nothing else in this
 * codebase references it, but it costs nothing to leave — matches the task
 * brief's "keep it exported if used elsewhere, otherwise replace" latitude
 * by not deleting a working, documented function no one asked to remove).
 */
import { CITY } from "@/lib/city";
import { localDayDate, daysUntilLastChance } from "@/lib/happenings/occurrence";
import { bucketForDayDate, isStale, moneyLabel, savingBadgeLabel } from "@/lib/happenings/format";
import { isGenuineDeal, whoGroupForEligibility, type DealWhoGroup } from "@/lib/happenings/groups";
import { priceSignalForEvent } from "@/lib/cards/price";
import { eventDayLabel } from "@/lib/events/format";
import type { Happening, HappeningEligibility, Occurrence } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";

/** Value's own sub-score never contributes more than this — a big saving on
 *  a mediocre-otherwise item shouldn't outrank a merely-good, well-rounded
 *  one on value alone. */
export const HERO_VALUE_CAP = 35;

/** Restricted-audience eligibility values the hero penalizes — the slot is
 *  for everyone, so an offer only a narrow group can actually redeem
 *  (`anyone`/`member`/`cardholder` are NOT in this set: `member`/
 *  `cardholder` describes HOW you redeem, not who's excluded, and `anyone`
 *  is the unrestricted default) is still eligible for the slot, just marked
 *  down rather than disqualified. */
const NARROW_ELIGIBILITY = new Set<HappeningEligibility>(["student", "under_26", "over_60", "local_resident"]);

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

export interface RecommendationResult {
  score: number;
  /** Short "why this" copy built from whichever scored factors mattered
   *  most, e.g. "Free · last chance tomorrow" — max ~40 chars. Null when no
   *  factor was distinctive enough to explain the pick. */
  reason: string | null;
}

interface ReasonFactor {
  label: string;
  /** How much this factor should weigh in choosing which 1-2 make the cut
   *  for `reason` — NOT the same number as the score delta it came from in
   *  every case (a couple of labels are re-weighted so the more legible
   *  explanation wins a near-tie — see the call sites below). */
  weight: number;
}

/** Picks the top 1-2 factors by weight and joins them " · ", falling back to
 *  just the single best one (truncated) if even that pair doesn't fit in
 *  ~40 chars. Deterministic tie-break: stable sort keeps the caller's own
 *  push order for equal weights. */
function buildReason(factors: ReasonFactor[]): string | null {
  if (factors.length === 0) return null;
  const sorted = [...factors].sort((a, b) => b.weight - a.weight);
  const top = sorted.slice(0, 2).map((f) => f.label);
  const combined = top.join(" · ");
  if (combined.length <= 40) return combined;
  const single = sorted[0].label;
  return single.length <= 40 ? single : `${single.slice(0, 39)}…`;
}

/**
 * Scores a dated happening occurrence for the hero slot. Higher wins.
 * Callers are expected to have already excluded `recurrence: "always"` rows
 * (no "last chance" of their own — they belong in Free Any Time) and
 * computed `occurrence` via lib/happenings/occurrence.ts, same contract as
 * the old `happeningHeroScore`.
 */
export function happeningRecommendationScore(
  h: Happening,
  occurrence: Occurrence,
  now: Date = new Date(),
  timeZone: string = CITY.timezone,
  who: readonly DealWhoGroup[] = []
): RecommendationResult {
  const factors: ReasonFactor[] = [];
  let score = 0;

  // --- Value (cap HERO_VALUE_CAP) ------------------------------------
  let value = 0;
  if (h.is_free) {
    value += 30;
    factors.push({ label: "Free", weight: 30 });
  } else if (isGenuineDeal(h)) {
    value += 20;
    factors.push({ label: savingBadgeLabel(h) ?? "Genuine deal", weight: 20 });
  }
  if (h.saving_amount != null) {
    const add = Math.min(h.saving_amount, 15);
    value += add;
    // Only worth naming on its own when nothing above already explains the
    // saving (a genuine-deal badge/Free already IS the saving, in words).
    if (add > 0 && !h.is_free && !isGenuineDeal(h)) {
      factors.push({ label: `Save ${moneyLabel(h.saving_amount, h.currency)}`, weight: 10 + add });
    }
  }
  score += Math.min(value, HERO_VALUE_CAP);

  // --- Actionability ---------------------------------------------------
  const daysLeft = daysUntilLastChance(occurrence, now, timeZone);
  const bucket = bucketForDayDate(occurrence.dayDate, now, timeZone);
  const today = localDayDate(now, timeZone);
  if (bucket === "today_tomorrow") score += 12;

  if (daysLeft <= 0) {
    score += 20;
    factors.push({ label: "last chance today", weight: 24 });
  } else if (daysLeft <= 2) {
    score += 20;
    factors.push({ label: occurrence.dayDate === localDayDate(new Date(now.getTime() + 86_400_000), timeZone) ? "last chance tomorrow" : "last chance", weight: 24 });
  } else if (daysLeft <= 7) {
    score += 10;
    factors.push({ label: "ends this week", weight: 11 });
  } else if (bucket === "today_tomorrow") {
    factors.push({ label: occurrence.dayDate === today ? "today" : "tomorrow", weight: 14 });
  } else if (bucket === "this_weekend") {
    factors.push({ label: "this weekend", weight: 8 });
  }

  // --- Scarcity ----------------------------------------------------------
  if (h.sellout_risk === "high") {
    score += 10;
    factors.push({ label: "sells out fast", weight: 16 });
  } else if (h.sellout_risk === "medium") {
    score += 5;
  }

  // --- Curation ------------------------------------------------------
  score += clamp((h.priority ?? 50) - 50, -15, 15);

  // --- Presentation --------------------------------------------------
  if (h.image_url) score += 8;
  else score -= 20;

  // --- Trust -----------------------------------------------------------
  if (isStale(h.verified_at, now, timeZone)) score -= 25;

  // --- Audience --------------------------------------------------------
  // Marked down for everyone else, boosted for a visitor whose deals
  // profile says they qualify.
  if (NARROW_ELIGIBILITY.has(h.eligibility)) {
    const group = whoGroupForEligibility(h.eligibility);
    if (group && who.includes(group)) {
      score += 10;
      factors.push({ label: "You qualify", weight: 22 });
    } else {
      score -= 10;
    }
  }

  return { score, reason: buildReason(factors) };
}

/**
 * Scores a provider event (Skiddle/Ticketmaster) for the hero slot.
 * Candidates are expected to already be free-or-cheap and starting within
 * the hero's short lookahead (see the route's own candidate gate) — this
 * only scores what it's given, same contract as the happening scorer.
 *
 * A one-off event has no "last chance" window of its own (unlike a
 * happening's occurrence, which can run for days) — actionability here is
 * just "is it today/tomorrow/this weekend", not the last-chance tiers.
 * There's likewise no `sellout_risk`, curator `priority`, or `eligibility`
 * on `EventItem` — those factors simply don't apply and are skipped, never
 * scored as a penalty for missing data.
 */
export function eventRecommendationScore(
  e: EventItem,
  now: Date = new Date(),
  timeZone: string = CITY.timezone
): RecommendationResult {
  const factors: ReasonFactor[] = [];
  let score = 0;

  // --- Value (cap HERO_VALUE_CAP) ------------------------------------
  let value = 0;
  if (e.is_free) {
    value += 30;
    factors.push({ label: "Free", weight: 30 });
  } else if (e.price_from != null) {
    if (e.price_from <= 5) {
      value += 15;
      factors.push({ label: `${moneyLabel(e.price_from, e.currency)} tickets`, weight: 20 });
    } else if (priceSignalForEvent(e) === "cheap") {
      value += 8;
    }
  }
  score += Math.min(value, HERO_VALUE_CAP);

  // --- Actionability ---------------------------------------------------
  const dayDate = localDayDate(new Date(e.starts_at), timeZone);
  const bucket = bucketForDayDate(dayDate, now, timeZone);
  if (bucket === "today_tomorrow") {
    score += 12;
    // "today"/"tonight" (5pm cutoff) rather than always "tonight" — a 12:30
    // lunch event isn't "tonight" just because it's today.
    factors.push({ label: (eventDayLabel(e.starts_at, now, timeZone) ?? "today").toLowerCase(), weight: 14 });
  } else if (bucket === "this_weekend") {
    factors.push({ label: "this weekend", weight: 8 });
  }

  // --- Scarcity / Curation / Audience: no data on EventItem, skipped. ---

  // --- Presentation --------------------------------------------------
  if (e.image_url) score += 8;
  else score -= 20;

  // --- Trust: an unpriced, non-free provider row is unverified value —
  // shouldn't come up in practice (the route only admits free/cheap event
  // candidates), kept for robustness if that gate ever loosens. -------
  if (!e.is_free && e.price_from == null) score -= 10;

  return { score, reason: buildReason(factors) };
}
