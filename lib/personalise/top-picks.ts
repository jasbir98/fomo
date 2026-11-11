/**
 * Home's "Top picks" (the What's on section's first cards): the day's best
 * cards for THIS visitor, so the five shown feel hand-picked rather than
 * "the next five in time order".
 *
 * The ranking is the For you tab's own (lib/personalise/for-you.ts), not a new
 * score: the Home hero's recommendation score as the base, plus the visitor's
 * taste (`personalBoost`) weighted by `MORE_BOOST_WEIGHT`. An offer the visitor
 * can't use (a known `who` that doesn't include the card's group) is skipped
 * unless there aren't enough others. At least `minPhotos` picks are
 * photo-led cards when that many exist, so the first screen is never a wall of
 * default tiles. Each pick carries a short `reason` ("You're into Comedy",
 * "Free · last chance tomorrow").
 *
 * Pure and not `server-only`: prefs and save history live in the browser.
 */
import { CITY } from "@/lib/city";
import { cardImageUrl, isPhotoImage } from "@/lib/happenings/hero";
import { NO_VENUE_KEY, normalizeVenueKey } from "@/lib/events/identity";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import type { AffinityMap } from "./affinity";
import { MORE_BOOST_WEIGHT, baseScore, coveredKeys, hasTaste, ineligible, personalReason } from "./for-you";
import { personalBoost, type BoostPrefs } from "./score";

export const TOP_PICKS_COUNT = 5;
export const TOP_PICKS_MIN_PHOTOS = 3;
/** At most this many picks from one venue / one source, so a night at one venue can't fill the section. */
export const TOP_PICKS_PER_VENUE = 1;
export const TOP_PICKS_PER_SOURCE = 2;

export interface TopPick {
  card: FeedCardData;
  /** Why this visitor sees it; null when nothing is worth saying. */
  reason: string | null;
}

export interface TopPicksResult {
  /** Best first (after the photo minimum is applied). */
  picks: TopPick[];
  /** Every other input card, in the original order. */
  rest: FeedCardData[];
}

export interface TopPicksInput {
  prefs: BoostPrefs;
  affinity?: AffinityMap;
  /** The visitor has answered "I'm a…" (or has groups), so an empty `prefs.who` means "none of these groups". Defaults to `prefs.who.length > 0`. */
  whoKnown?: boolean;
  now?: Date;
  timeZone?: string;
  count?: number;
  minPhotos?: number;
}

interface Scored {
  card: FeedCardData;
  index: number;
  score: number;
  reason: string | null;
  photo: boolean;
  skipped: boolean;
  /** Normalised venue, or null when the card names none. */
  venue: string | null;
  source: string | null;
}

/** The lead listing behind a card: a recurring card is its lead. */
function leadOf(card: FeedCardData): FeedCardData {
  return card.kind === "recurring" ? leadOf(card.lead) : card;
}

function venueOf(card: FeedCardData): string | null {
  const lead = leadOf(card);
  const name =
    lead.kind === "event" ? lead.event.venue_name : lead.kind === "series" ? lead.lead.venue_name : lead.kind === "happening" ? lead.happening.venue_name : null;
  const key = normalizeVenueKey(name);
  return key === NO_VENUE_KEY ? null : key;
}

function sourceOf(card: FeedCardData): string | null {
  const lead = leadOf(card);
  if (lead.kind === "event") return lead.event.provider ?? null;
  const h = lead.kind === "series" ? lead.lead : lead.kind === "happening" ? lead.happening : null;
  return h?.source_name ?? null;
}

/** Reason parts that only repeat the card's own date chip ("Today", "Tomorrow")
 *  and the section header ("Top picks · Today"). "last chance today" stays:
 *  the chip doesn't say it ends. */
const DAY_ONLY_PARTS = new Set(["today", "tonight", "tomorrow"]);

/** A part that restates the card instead of saying why it ranked: "An event at The Jazz Bar", "from £1". Better no reason line than this. */
function isFillerPart(part: string): boolean {
  const p = part.trim();
  return /^an? (?:[\w&]+ ){0,3}?(?:event|show|gig|night)s? at\b/i.test(p) || /^from £\s?[\d.]+$/i.test(p);
}

/** "Free · today" -> "Free"; "today" -> null. */
export function withoutDayOnlyParts(reason: string | null): string | null {
  if (!reason) return null;
  const parts = reason.split(" · ").filter((p) => !DAY_ONLY_PARTS.has(p.trim().toLowerCase()) && !isFillerPart(p));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function topPicks(
  cards: readonly FeedCardData[],
  { prefs, affinity = {}, whoKnown = prefs.who.length > 0, now = new Date(), timeZone = CITY.timezone, count = TOP_PICKS_COUNT, minPhotos = TOP_PICKS_MIN_PHOTOS }: TopPicksInput
): TopPicksResult {
  const personalised = hasTaste(prefs, affinity) || whoKnown;

  // Dedupe on the keys For you uses: a series and its member never both appear.
  const seen = new Set<string>();
  const scored: Scored[] = [];
  cards.forEach((card, index) => {
    const keys = coveredKeys(card);
    if (keys.some((k) => seen.has(k))) return;
    keys.forEach((k) => seen.add(k));
    const base = baseScore(card, prefs, now, timeZone);
    const boost = personalised ? personalBoost(card, prefs, affinity) : 0;
    scored.push({
      card,
      index,
      score: base.score + boost * MORE_BOOST_WEIGHT,
      reason: (personalised ? personalReason(card, prefs, affinity) : null) ?? withoutDayOnlyParts(base.reason),
      photo: isPhotoImage(cardImageUrl(card)),
      skipped: ineligible(card, prefs, whoKnown),
      venue: venueOf(card),
      source: sourceOf(card),
    });
  });

  const byScore = (a: Scored, b: Scored) => b.score - a.score || a.index - b.index;
  const eligible = scored.filter((s) => !s.skipped).sort(byScore);
  const skipped = scored.filter((s) => s.skipped).sort(byScore);
  // Top up from the skipped ones so the section never shrinks.
  const ranked = [...eligible, ...skipped];

  // At most one pick per venue and two per source, filled from the next best;
  // when the caps leave the section short, the best of the rest top it up.
  const withinCaps = (list: readonly Scored[], s: Scored) =>
    (s.venue == null || list.filter((c) => c.venue === s.venue).length < TOP_PICKS_PER_VENUE) &&
    (s.source == null || list.filter((c) => c.source === s.source).length < TOP_PICKS_PER_SOURCE);
  let chosen: Scored[] = [];
  for (const s of ranked) {
    if (chosen.length >= count) break;
    if (withinCaps(chosen, s)) chosen.push(s);
  }
  for (const s of ranked) {
    if (chosen.length >= count) break;
    if (!chosen.includes(s)) chosen.push(s);
  }
  chosen.sort(byScore);
  const minimum = Math.min(minPhotos, count);
  const havePhotos = () => chosen.filter((s) => s.photo).length;
  if (havePhotos() < minimum) {
    const chosenSet = new Set(chosen);
    const spare = ranked.filter((s) => s.photo && !chosenSet.has(s));
    // Swap the lowest-scoring non-photo picks for the best remaining photo cards.
    while (havePhotos() < minimum && spare.length > 0) {
      const incoming = spare.shift() as Scored;
      let drop = -1;
      for (let i = chosen.length - 1; i >= 0; i--) {
        if (!chosen[i].photo) {
          drop = i;
          break;
        }
      }
      if (drop === -1) break;
      const without = chosen.filter((_, i) => i !== drop);
      // A photo card that would double up a venue or source waits.
      if (!withinCaps(without, incoming)) continue;
      chosen = without.concat(incoming);
      chosen.sort(byScore);
    }
  }
  // Top-ups from the skipped ones go last, whatever they scored.
  chosen.sort((a, b) => Number(a.skipped) - Number(b.skipped) || byScore(a, b));

  const pickedIndexes = new Set(chosen.map((s) => s.index));
  return {
    picks: chosen.map(({ card, reason }) => ({ card, reason })),
    // Everything not picked, original order (nothing is dropped).
    rest: cards.filter((_, i) => !pickedIndexes.has(i)),
  };
}
