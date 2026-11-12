/**
 * Candidate selection for `scripts/radar.ts suggest`. Pure: no DB, no AI.
 *
 * What makes a good "Under the radar" candidate: an independent Edinburgh
 * place that is not a headline attraction, with a high rating on a modest
 * number of reviews (loved, but not famous), a real photo, spread across
 * neighbourhoods and categories so the list is not ten Stockbridge cafes.
 *
 * Google ratings are stored for at most 30 days, so many rows have none. Those
 * are still listed (the owner knows the city) but marked `signal: "weak"`.
 */
import { CITY } from "@/lib/city";
import { distanceKm } from "@/lib/geo";
import { NEIGHBOURHOODS } from "@/lib/explore/neighbourhoods";
import { isNationalChain } from "@/lib/happenings/deal-score";
import type { Place } from "@/lib/types";

/** Beyond this from the city centre a place is not "in Edinburgh" for Fomo. */
export const MAX_KM_FROM_CENTRE = 12;
/** A place with this many Google reviews is well known by definition. */
export const TOURIST_REVIEW_COUNT = 2500;
/** Below this many reviews a high rating proves little. */
export const THIN_REVIEW_COUNT = 15;
/** Up to this many reviews counts as "modest". */
export const MODEST_REVIEW_COUNT = 500;

/** Headline attractions every visitor already knows. Name substrings, lowercase. */
const HEADLINE_ATTRACTIONS = [
  "edinburgh castle",
  "royal mile",
  "arthur's seat",
  "arthurs seat",
  "holyrood",
  "scott monument",
  "national museum of scotland",
  "camera obscura",
  "mary king",
  "dynamic earth",
  "calton hill",
  "royal yacht britannia",
  "edinburgh zoo",
  "st giles",
  "scotch whisky experience",
  "national gallery",
  "royal botanic garden",
  "princes street gardens",
  "greyfriars",
  "edinburgh dungeon",
  "museum of illusions",
  "harry potter",
  "elephant house",
];

const NOT_A_RECOMMENDATION = /\b(hotel|hostel|b&b|guest ?house|apartments?|lodge|inn|accommodation|airport|station|car park|parking|taxi)\b/i;

export type Signal = "strong" | "weak";

export interface RadarCandidate {
  place: Place;
  score: number;
  signal: Signal;
  neighbourhood: string;
  /** Short note for the table, e.g. "4.7 (86)" or "no rating". */
  ratingLabel: string;
  photo: "ok" | "thin" | "none";
}

export interface SelectOptions {
  limit: number;
  /** Place ids to leave out (for example ones already approved). */
  excludedIds?: ReadonlySet<string>;
}

export function isInEdinburgh(place: Pick<Place, "lat" | "lng" | "address" | "city">): boolean {
  if (place.lat != null && place.lng != null) {
    return distanceKm(CITY.center, { lat: place.lat, lng: place.lng }) <= MAX_KM_FROM_CENTRE;
  }
  return /edinburgh/i.test(`${place.city ?? ""} ${place.address ?? ""}`);
}

export function isHeadlineAttraction(place: Pick<Place, "name" | "google_rating_count">): boolean {
  const name = (place.name ?? "").toLowerCase().replace(/[‘’]/g, "'");
  if (HEADLINE_ATTRACTIONS.some((h) => name.includes(h))) return true;
  return (place.google_rating_count ?? 0) >= TOURIST_REVIEW_COUNT;
}

/** Why a place cannot be a candidate, or null when it can. */
export function disqualifier(place: Place): string | null {
  if (!place.name?.trim()) return "no name";
  if (place.source === "event-venue") return "event venue";
  if (place.business_status === "CLOSED_PERMANENTLY" || place.business_status === "CLOSED_TEMPORARILY") return "closed";
  if (place.radar_picked_at) return "already a pick";
  if (!isInEdinburgh(place)) return "not in Edinburgh";
  if (isNationalChain({ title: place.name, venue_name: null })) return "national chain";
  if (isHeadlineAttraction(place)) return "headline attraction";
  if (NOT_A_RECOMMENDATION.test(place.name) || NOT_A_RECOMMENDATION.test(place.category ?? "")) {
    return "not a place to recommend";
  }
  return null;
}

/** Nearest named neighbourhood within 2km of the place, else "Elsewhere" (or "Unknown" with no coordinates). */
export function neighbourhoodOf(place: Pick<Place, "lat" | "lng">): string {
  if (place.lat == null || place.lng == null) return "Unknown";
  const here = { lat: place.lat, lng: place.lng };
  let best: { label: string; km: number } | null = null;
  for (const n of NEIGHBOURHOODS) {
    const km = distanceKm(n.center, here);
    if (km <= 2 && (!best || km < best.km)) best = { label: n.label, km };
  }
  return best?.label ?? "Elsewhere";
}

function photoOf(place: Pick<Place, "image_url" | "image_quality">): "ok" | "thin" | "none" {
  if (place.image_quality === "ok") return "ok";
  if (place.image_quality === "thin") return "thin";
  if (place.image_quality === "none") return "none";
  return place.image_url ? "thin" : "none"; // a photo of unknown quality counts as thin
}

/** Score 0-100 plus the signal strength. Higher is a better candidate. */
export function scorePlace(place: Place): { score: number; signal: Signal; photo: "ok" | "thin" | "none" } {
  const rating = place.rating;
  const count = place.google_rating_count;
  let score = 0;

  if (rating != null) score += Math.max(0, Math.min(1, rating - 4)) * 40; // 4.0 -> 0, 5.0 -> 40

  if (count == null) score += 5;
  else if (count < THIN_REVIEW_COUNT) score += 10;
  else if (count <= 150) score += 30;
  else if (count <= MODEST_REVIEW_COUNT) score += 30 - ((count - 150) / (MODEST_REVIEW_COUNT - 150)) * 10; // 30 -> 20
  else score += Math.max(0, 20 - ((count - MODEST_REVIEW_COUNT) / (TOURIST_REVIEW_COUNT - MODEST_REVIEW_COUNT)) * 20);

  const photo = photoOf(place);
  score += photo === "ok" ? 20 : photo === "thin" ? 8 : 0;

  if (place.price_level == null || place.price_level <= 2) score += 5;
  if (place.description || place.detail_line) score += 5;

  const strong = rating != null && rating >= 4.4 && count != null && count >= THIN_REVIEW_COUNT;
  return { score: Math.round(score * 10) / 10, signal: strong ? "strong" : "weak", photo };
}

function ratingLabel(place: Pick<Place, "rating" | "google_rating_count">): string {
  if (place.rating == null) return "no rating";
  return place.google_rating_count != null ? `${place.rating} (${place.google_rating_count})` : `${place.rating} (count unknown)`;
}

/** Every place that can be a candidate, scored, best first (ties by id). No spreading yet. */
export function scoreCandidates(places: readonly Place[], excludedIds: ReadonlySet<string> = new Set()): RadarCandidate[] {
  const out: RadarCandidate[] = [];
  for (const place of places) {
    if (excludedIds.has(place.id) || disqualifier(place)) continue;
    const { score, signal, photo } = scorePlace(place);
    out.push({ place, score, signal, photo, neighbourhood: neighbourhoodOf(place), ratingLabel: ratingLabel(place) });
  }
  return out.sort((a, b) => b.score - a.score || a.place.id.localeCompare(b.place.id));
}

/** Score points lost per earlier pick already in the same neighbourhood or category. */
const SPREAD_PENALTY = 7;

/**
 * Greedy pick of `limit` candidates: best adjusted score first, where each
 * earlier pick in the same neighbourhood or category lowers a later one's, so
 * the list spreads across the city. Deterministic for a given input.
 */
export function selectCandidates(places: readonly Place[], { limit, excludedIds }: SelectOptions): RadarCandidate[] {
  const pool = scoreCandidates(places, excludedIds);
  const picked: RadarCandidate[] = [];
  const byHood = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const cat = (c: RadarCandidate) => (c.place.category ?? "other").toLowerCase();
  while (picked.length < limit && pool.length > 0) {
    let bestIdx = 0;
    let bestAdj = -Infinity;
    pool.forEach((c, i) => {
      const adj = c.score - SPREAD_PENALTY * ((byHood.get(c.neighbourhood) ?? 0) + (byCategory.get(cat(c)) ?? 0));
      if (adj > bestAdj) {
        bestAdj = adj;
        bestIdx = i;
      }
    });
    const [chosen] = pool.splice(bestIdx, 1);
    picked.push(chosen);
    byHood.set(chosen.neighbourhood, (byHood.get(chosen.neighbourhood) ?? 0) + 1);
    byCategory.set(cat(chosen), (byCategory.get(cat(chosen)) ?? 0) + 1);
  }
  return picked;
}

/** Plain-text numbered table for the terminal. */
export function formatCandidateTable(candidates: readonly RadarCandidate[]): string {
  if (candidates.length === 0) return "  (no candidates)";
  const rows = candidates.map((c, i) => [
    String(i + 1),
    (c.place.name ?? "").slice(0, 34),
    (c.place.category ?? "").slice(0, 18),
    c.neighbourhood,
    c.ratingLabel,
    `photo:${c.photo}`,
    String(Math.round(c.score)),
    c.signal === "weak" ? "WEAK signal" : "ok",
  ]);
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows.map((r) => "  " + r.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd()).join("\n");
}
