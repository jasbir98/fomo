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
 * "why this" pill. A run-length factor keeps a months-long listing from
 * tying with something that's on tonight only: long runs are marked down,
 * genuine one-offs get a small bump.
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
import { localDayDate, daysUntilLastChance, normalizeRecurrence } from "@/lib/happenings/occurrence";
import { isNationalChain } from "@/lib/happenings/deal-score";
import { bucketForDayDate, isStale, moneyLabel, savingBadgeLabel } from "@/lib/happenings/format";
import { isGenuineDeal, whoGroupForEligibility, type DealWhoGroup } from "@/lib/happenings/groups";
import { priceSignalForEvent } from "@/lib/cards/price";
import { eventDayLabel, formatEventTime } from "@/lib/events/format";
import type { Happening, HappeningEligibility, Occurrence } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import { familyFitForEvent, familyFitForHappening } from "@/lib/happenings/family";
import { leadMisfitPenalty, nicheAudiencePenalty } from "@/lib/happenings/audience";
import { statedPrices, isCheapPrice } from "@/lib/happenings/cheap-price";

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
const NARROW_ELIGIBILITY = new Set<HappeningEligibility>(["student", "under_26", "over_60", "local_resident", "family"]);

/** Filename words that mean the "photo" is really a document or graphic —
 *  a timetable, fixture list, poster, menu, logo or screenshot. Matched on
 *  the URL's last path segment only, so a host or folder name can't trip
 *  it. Seen live: Edinburgh Leisure's coaching offer led Home with
 *  `EL-Coaching-Venues-Timetable.jpg`, a spreadsheet. */
const DOCUMENT_IMAGE_NAME =
  /timetable|schedule|fixtures?[-_.]|poster|flyer|leaflet|brochure|menu|price-?list|logo|banner|screen-?shot|untitled-design|infographic|\.(pdf|svg)$/i;

/** Bonus for being free (or under £10) AND on today, tomorrow or this
 *  weekend — the cheap-and-now pick the Home hero is for. */
const CHEAP_AND_SOON_BONUS = 10;

/** Event tickets below this count as "under £10" for the cheap-and-soon bonus. */
const CHEAP_EVENT_MAX = 10;

/** A run of this many days or more counts as long-running — an exhibition or
 *  a season-length aggregator listing, not a night out. */
const LONG_RUN_DAYS = 14;

/** Penalty for a long run that isn't about to end: it's always there, so
 *  there's no reason to lead with it today. A run ending within 2 days is
 *  exempt (it's genuinely a last chance). */
const LONG_RUN_PENALTY = 15;

/** Bonus for a genuine one-off (single day, not a recurring slot) that's
 *  today, tomorrow or this weekend — rare, so worth surfacing. */
const ONE_OFF_BONUS = 8;

/** A happening that's a national chain's offer is marked down so the Fomo Pick
 *  is never a chain discount when a local option exists. */
const CHAIN_HERO_PENALTY = 10;
/** Whole days from `from` to `to` ("YYYY-MM-DD" local days). UTC arithmetic,
 *  so DST can't skew it. */
function dayDiff(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * True when `url` is a real photo: set, not one of the bundled category
 * defaults (`/defaults/...`), and not named like a document (see
 * `DOCUMENT_IMAGE_NAME`). The hero and the cards that lead What's on only
 * show photo-led items while any exist.
 */
export function isPhotoImage(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("/defaults/")) return false;
  const path = url.split(/[?#]/)[0];
  let name = path.slice(path.lastIndexOf("/") + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // Malformed escape — test the raw name.
  }
  return !DOCUMENT_IMAGE_NAME.test(name);
}

/**
 * Whether a happening may take the Home hero slot. Family content is mixed in
 * for everyone, but the hero is the first thing a visitor sees, so an item aimed
 * at children (`family_fit: 'kids'`, incl. the category / eligibility 'family'
 * fallbacks in family.ts) never takes it. `all_ages` stays eligible. A hard
 * filter on the candidate set, not a score tweak.
 */
export function heroEligibleHappening(h: Parameters<typeof familyFitForHappening>[0]): boolean {
  return familyFitForHappening(h) !== "kids";
}

/** Event counterpart of `heroEligibleHappening`. */
export function heroEligibleEvent(e: Parameters<typeof familyFitForEvent>[0]): boolean {
  return familyFitForEvent(e) !== "kids";
}

/**
 * Whether a happening is a "steal" for the hero: free, or a stated price under
 * `CHEAP_EVENT_MAX` (£10, the same line the cheap-and-soon bonus uses), or a
 * fixed price that beats a price-benchmarks.json line. Curated free-access
 * rows and activities count (free or nominal by construction); a deal, tour,
 * festival or event needs a stated price. The route prefers steals and only
 * falls back to the rest when none qualifies.
 */
export function isHeroStealHappening(h: Pick<Happening, "kind" | "is_free" | "title" | "saving_label" | "price_text">): boolean {
  if (h.is_free) return true;
  if (h.kind === "free_access" || h.kind === "activity") return true;
  if (isCheapPrice(h.title, h.saving_label)) return true;
  const prices = statedPrices(`${h.price_text ?? ""} ${h.saving_label ?? ""} ${h.title}`);
  return prices.length > 0 && Math.min(...prices) < CHEAP_EVENT_MAX;
}

/** Event counterpart of `isHeroStealHappening`: free, or tickets under £10. */
export function isHeroStealEvent(e: Pick<EventItem, "is_free" | "price_from">): boolean {
  return Boolean(e.is_free) || (e.price_from != null && e.price_from < CHEAP_EVENT_MAX);
}

/**
 * The hero candidates actually in the running, narrowed in this order, each
 * step only while something would be left:
 *  1. not an everyday item (a daily guided walk would lead the page every day;
 *     it lives in "Any day" instead);
 *  2. a steal (free or under £10);
 *  3. photo-led (a timetable, poster or default tile is never the pick while
 *     a photo exists, `isPhotoImage`).
 */
export function selectHeroPool<T extends { everyday: boolean; steal: boolean; photo: boolean }>(candidates: readonly T[]): T[] {
  const narrow = (list: T[], keep: (c: T) => boolean) => (list.some(keep) ? list.filter(keep) : list);
  return narrow(narrow(narrow([...candidates], (c) => !c.everyday), (c) => c.steal), (c) => c.photo);
}

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
 * the old `happeningHeroScore`. Run length comes from the occurrence's own
 * span, so a weekly slot is never "long-running"; only `once`/`dates`/`annual`
 * single days earn the one-off bonus.
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
  if (h.is_free && bucket !== "coming_up") score += CHEAP_AND_SOON_BONUS;

  // --- Run length: long runs are always there, one-offs aren't. ------
  const runDays = dayDiff(occurrence.dayDate, occurrence.lastDayDate);
  if (runDays >= LONG_RUN_DAYS && daysLeft > 2) score -= LONG_RUN_PENALTY;
  if (runDays <= 0 && bucket !== "coming_up") {
    const type = normalizeRecurrence(h.recurrence).type;
    if (type === "once" || type === "dates" || type === "annual") score += ONE_OFF_BONUS;
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

  // --- Presentation: a document image counts as no image. ------------
  if (isPhotoImage(h.image_url)) score += 8;
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
    } else if (h.eligibility === "student" || h.eligibility === "under_26") {
      // Fomo's own audience: no markdown, and the restriction is the reason.
      factors.push({ label: h.eligibility === "student" ? "Student price" : "Under-26 price", weight: 16 });
    } else {
      score -= 10;
    }
  } else {
    score -= nicheAudiencePenalty(h.title, h.summary, who);
  }

  // --- National chains: same everywhere, never the Edinburgh pick. ----
  if (isNationalChain(h)) score -= CHAIN_HERO_PENALTY;

  // --- Persona fit: hotel stays, hairdressers, corporate packages, tourist
  // attractions and adult-themed listings are marked down (audience.ts). ----
  score -= leadMisfitPenalty({ title: h.title, description: h.summary, venue_name: h.venue_name, saving_label: h.saving_label, is_free: h.is_free });

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
 *
 * Run length comes from `starts_at`..`ends_at` (null = single day): a long
 * run that isn't about to end is marked down, a single-day event that's soon
 * gets the one-off bonus.
 */
export function eventRecommendationScore(
  e: EventItem,
  now: Date = new Date(),
  timeZone: string = CITY.timezone,
  who: readonly DealWhoGroup[] = []
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
      if (e.price_from < CHEAP_EVENT_MAX) factors.push({ label: "Under £10", weight: 12 });
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
    // A start time says more than the day (the card's own chip has the day).
    const time = formatEventTime(e.starts_at, timeZone);
    factors.push({ label: time ? `starts ${time}` : (eventDayLabel(e.starts_at, now, timeZone) ?? "today").toLowerCase(), weight: 14 });
  } else if (bucket === "this_weekend") {
    factors.push({ label: "this weekend", weight: 8 });
  }
  const cheap = e.is_free || (e.price_from != null && e.price_from < CHEAP_EVENT_MAX);
  if (cheap && bucket !== "coming_up") score += CHEAP_AND_SOON_BONUS;

  // --- Run length: long runs are always there, one-offs aren't. ------
  const lastDay = e.ends_at ? localDayDate(new Date(e.ends_at), timeZone) : dayDate;
  const runDays = dayDiff(dayDate, lastDay);
  if (runDays >= LONG_RUN_DAYS && dayDiff(localDayDate(now, timeZone), lastDay) > 2) score -= LONG_RUN_PENALTY;
  if (runDays <= 0 && bucket !== "coming_up") score += ONE_OFF_BONUS;

  // --- Scarcity / Curation: no data on EventItem, skipped. -------------

  // --- Audience: read from the title (no eligibility column on events). --
  score -= nicheAudiencePenalty(e.name, e.description, who);
  // Persona fit (audience.ts): adult-themed listings and the like are marked down.
  score -= leadMisfitPenalty({ title: e.name, description: e.description, venue_name: e.venue_name, is_free: e.is_free });

  // --- Presentation --------------------------------------------------
  if (isPhotoImage(eventImageUrl(e))) score += 8;
  else score -= 20;

  // --- Trust: an unpriced, non-free provider row is unverified value —
  // shouldn't come up in practice (the route only admits free/cheap event
  // candidates), kept for robustness if that gate ever loosens. -------
  if (!e.is_free && e.price_from == null) score -= 10;

  return { score, reason: buildReason(factors) };
}

/** An event's own photo, else its venue's — the same image EventHero shows. */
export function eventImageUrl(e: EventItem): string | null {
  return e.image_url || e.place?.image_url || null;
}

/** The image a What's on card leads with (a recurring card shows its lead's). */
export function cardImageUrl(card: FeedCardData): string | null {
  if (card.kind === "recurring") return cardImageUrl(card.lead);
  if (card.kind === "event") return eventImageUrl(card.event);
  return (card.kind === "series" ? card.lead : card.happening).image_url;
}

/** The hero score of a What's on card — the same scorers the hero uses. */
export function cardRecommendationScore(
  card: FeedCardData,
  now: Date = new Date(),
  timeZone: string = CITY.timezone,
  who: readonly DealWhoGroup[] = []
): number {
  if (card.kind === "recurring") return cardRecommendationScore(card.lead, now, timeZone, who);
  if (card.kind === "event") return eventRecommendationScore(card.event, now, timeZone, who).score;
  const h = card.kind === "series" ? card.lead : card.happening;
  return happeningRecommendationScore(h, card.occurrence, now, timeZone, who).score;
}

/** How many cards under the hero `leadWithPhotos` picks. */
export const LEAD_CARD_COUNT = 3;

/**
 * Moves the `count` best-scoring photo-led cards to the front of a What's on
 * list, the rest keeping their order. Unchanged when no card has a photo, so
 * a thin day still shows its first cards, not none.
 */
export function leadWithPhotos(
  cards: readonly FeedCardData[],
  now: Date = new Date(),
  timeZone: string = CITY.timezone,
  who: readonly DealWhoGroup[] = [],
  count: number = LEAD_CARD_COUNT
): FeedCardData[] {
  const lead = cards
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => isPhotoImage(cardImageUrl(card)))
    .map((c) => ({ ...c, score: cardRecommendationScore(c.card, now, timeZone, who) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, count);
  if (lead.length === 0) return [...cards];
  const leadIndexes = new Set(lead.map((c) => c.index));
  return [...lead.map((c) => c.card), ...cards.filter((_, i) => !leadIndexes.has(i))];
}
