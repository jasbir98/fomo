import "server-only";
import type { EventItem, OpeningHoursPeriod, Place } from "@/lib/types";
import { realEventImage } from "@/lib/events/skiddle";
import type { Candidate, FeedContext } from "@/lib/now/types";
import type { Persona } from "@/lib/now/persona";
import { reachKm, reachMinutes, walkMinutes } from "@/lib/now/reach";
import { priceFit, priceSignalForEvent, priceSignalForPlace } from "@/lib/now/price";
import { DWELL_MINUTES, INTEREST_TAG_META, interestsForPlace } from "@/lib/taxonomy";
import type { InterestTag } from "@/lib/taxonomy";

// Phase 6 (plan §D.4) — walkMinutes moved to lib/now/reach.ts (the one owner
// for persona-aware reach/pace); re-exported here so existing
// `import { walkMinutes } from "@/lib/now/generators"` call sites
// (lib/now/discover.ts) don't need their import path rewritten.
export { walkMinutes };

const EARTH_RADIUS_KM = 6371;

/** Local haversine — lib/geo.ts is a "use client" module; generators run server-side, so this stays self-contained rather than crossing that boundary for a 5-line function. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function placeDistanceKm(coords: { lat: number; lng: number } | null, place: Place): number | null {
  if (!coords || place.lat == null || place.lng == null) return null;
  return distanceKm(coords, { lat: place.lat, lng: place.lng });
}

export function placeImage(place: Place): Candidate["image"] {
  return { url: place.image_url, quality: place.image_url ? place.image_quality ?? "thin" : "none" };
}

// realEventImage strips Skiddle's generic "no photo" placeholder graphic —
// including rows cached before that filter existed, since a stale `events`
// row can still carry the raw placeholder URL until its 6h TTL expires. A
// surviving URL is a real provider photo, so it's hero-eligible ("ok"),
// same trust level as a validated place photo.
export function eventImage(url: string | null): Candidate["image"] {
  const real = realEventImage(url);
  return { url: real, quality: real ? "ok" : "none" };
}

export function placeCoords(place: { lat: number | null; lng: number | null }): Candidate["coords"] {
  return place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null;
}

export function fmtMin(min: number): string {
  return `${Math.round(min)} min`;
}

/** `opening_hours` is `[{ day: 0-6, open: "HH:MM", close: "HH:MM" }]`; `close` can be past midnight relative to `open` on the same entry (an overnight span). Exported for the `closing` discover intent (lib/now/discover.ts). */
export function minutesUntilClose(place: Place, at: Date): number | null {
  const periods = place.opening_hours as OpeningHoursPeriod[] | null;
  if (!periods || periods.length === 0) return null;
  const day = at.getDay();
  const nowMin = at.getHours() * 60 + at.getMinutes();

  for (const p of periods) {
    const [oh, om] = p.open.split(":").map(Number);
    const [ch, cm] = p.close.split(":").map(Number);
    const openMin = oh * 60 + om;
    const closeMin = ch * 60 + cm;
    const overnight = closeMin <= openMin;

    if (p.day === day) {
      if (!overnight && nowMin >= openMin && nowMin < closeMin) return closeMin - nowMin;
      if (overnight && nowMin >= openMin) return 24 * 60 - nowMin + closeMin;
    }
    // An overnight period starting yesterday still covers the early hours of today.
    if (overnight && p.day === (day + 6) % 7 && nowMin < closeMin) return closeMin - nowMin;
  }
  return null;
}

function usedIds(candidates: Candidate[]): Set<string> {
  return new Set(candidates.map((c) => `${c.subject.type}:${c.subject.id}`));
}

// ---------------------------------------------------------------------------
// closing_soon — a curated place near you shuts within 90 minutes.
// ---------------------------------------------------------------------------
export function closingSoon(ctx: FeedContext, exclude: Set<string>): Candidate[] {
  const commitRadius = reachKm(ctx.persona, "commit");
  const out: Candidate[] = [];
  for (const place of ctx.candidatePlaces) {
    if (exclude.has(`place:${place.id}`)) continue;
    const minsLeft = minutesUntilClose(place, ctx.at);
    if (minsLeft == null || minsLeft <= 0 || minsLeft > 90) continue;
    const dist = placeDistanceKm(ctx.coords, place);
    if (dist != null && dist > commitRadius) continue;

    const closeAt = new Date(ctx.at.getTime() + minsLeft * 60_000);
    out.push({
      generator: "closing_soon",
      baseScore: 80,
      score: 80,
      subject: { type: "place", id: place.id },
      pill: "Closing soon",
      why: `Because the doors shut at ${closeAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
      headline: `${place.name}, now or not today`,
      detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist, ctx.persona))} walk.` : ""),
      primaryAction: { label: "Take me there", kind: "directions" },
      image: placeImage(place),
      urgency: minsLeft <= 30 ? "high" : "medium",
      validFrom: ctx.at.toISOString(),
      validUntil: closeAt.toISOString(),
      distanceKm: dist,
      subjectName: place.name ?? "Nearby",
      coords: placeCoords(place),
      railTitle: "Closing soon",
      railMeta: "nearby",
    });
  }
  // Descending — highest score first — so slice(0, 3) keeps the top-scoring
  // candidates. Sorting ascending here kept the *lowest*-scoring ones.
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// ---------------------------------------------------------------------------
// event_tonight — a cached event starting within 6 hours. Cheap/free only
// (v0 §1: Fomo answers "what can I do right now that's free, cheap, or
// discounted" — a full-price ticket doesn't belong in this generator).
// ---------------------------------------------------------------------------
/**
 * Ticketing feeds carry placeholder venue rows ("Virtual Event Edinburgh",
 * "TBC", "Secret Location") that read as noise in a one-line detail. Drop
 * them rather than surfacing them verbatim — §13's specificity rule means a
 * vague venue is worse than no venue.
 */
const PLACEHOLDER_VENUE = /^(virtual event|online|tbc|tba|secret location|various)\b/i;

/** Exported so app/api/saved/route.ts can build the same detail line for a saved event outside a full FeedContext. */
export function venueLabel(name: string | null): string | null {
  if (!name || PLACEHOLDER_VENUE.test(name.trim())) return null;
  return name;
}

/**
 * Ticketing feeds title events as pipe-delimited SEO strings —
 * "Ryan Nicholls | Secret Location Rave | Edinburgh". Rendered verbatim that
 * blows the ≤8-word headline budget (§4.2) and reads like a listing, not a
 * recommendation. Strip the city segment (already implied — the user is
 * standing in it) and rejoin the rest with an em dash.
 */
export function eventHeadline(name: string, cityName: string): string {
  const city = cityName.toLowerCase();
  const parts = name
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !city || p.toLowerCase() !== city);
  if (parts.length === 0) return name.trim();
  return parts.join(" — ").replace(/\s*\(\s*([^)]+)\s*\)\s*$/, (m, inner: string) =>
    inner.trim().toLowerCase() === city ? "" : m
  );
}

/**
 * Local (pre-rank.ts) budget-weighted score for picking *which* two events
 * `eventTonight` surfaces — `Candidate.score` gets overwritten by
 * lib/now/rank.ts's `scoreCandidate` (which applies the same `priceFit`
 * again, via `ctx.persona.budget`) before final ranking, so this doesn't
 * double-count in the final order; it only decides which events make the
 * top-2 cut here, same as `local_pick`'s internal mention-count sort always
 * has. Free-first for a shoestring persona (plan §D.5).
 */
function eventLocalScore(persona: Persona, e: EventItem): number {
  return 70 * priceFit(persona.budget, priceSignalForEvent(e));
}

export function eventTonight(ctx: FeedContext): Candidate[] {
  // Phase 6 (plan §D.5) — an early-bird persona's "tonight" window narrows
  // from 6h to 3h; steady/night personas keep the original 6h flat window.
  const windowHours = ctx.persona.rhythm === "early" ? 3 : 6;
  const windowEnd = ctx.at.getTime() + windowHours * 3_600_000;
  const candidates = ctx.candidateEvents.filter((e) => {
    if (priceSignalForEvent(e) !== "cheap") return false;
    const start = new Date(e.starts_at).getTime();
    return start >= ctx.at.getTime() && start <= windowEnd;
  });
  return candidates
    .map((e): Candidate => {
      const dist =
        ctx.coords && e.lat != null && e.lng != null ? distanceKm(ctx.coords, { lat: e.lat, lng: e.lng }) : null;
      const start = new Date(e.starts_at);
      const startLabel = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const title = eventHeadline(e.name, ctx.city.name);
      const score = eventLocalScore(ctx.persona, e);
      return {
        generator: "event_tonight",
        baseScore: score,
        score,
        subject: { type: "event", id: e.id },
        pill: "Tonight",
        why: `Because doors are at ${startLabel}`,
        headline: title,
        detail:
          [venueLabel(e.venue_name), dist != null ? `${fmtMin(walkMinutes(dist, ctx.persona))} walk` : null]
            .filter(Boolean)
            .join(" · ") || `On tonight at ${startLabel}.`,
        primaryAction: { label: "Save", kind: "add" },
        image: eventImage(e.image_url),
        urgency: "medium",
        validFrom: ctx.at.toISOString(),
        validUntil: e.starts_at,
        distanceKm: dist,
        subjectName: title,
        coords: placeCoords(e),
        railTitle: "Tonight nearby",
        railMeta: `${candidates.length} on`,
      };
    })
    // Descending — highest score first — so slice(0, 2) keeps the top-scoring
    // candidates. Sorting ascending here kept the *lowest*-scoring ones.
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

const INDOOR_HINTS = ["museum", "gallery", "aquarium", "shopping", "mall", "arcade", "cafe", "indoor", "tea house"];
export function isIndoorish(place: Place): boolean {
  const hay = `${place.category ?? ""} ${place.name ?? ""}`.toLowerCase();
  return INDOOR_HINTS.some((h) => hay.includes(h));
}

/** Category dwell estimate (lib/taxonomy.ts's DWELL_MINUTES), or null when the category is unmapped/missing — never a default guess. */
function estimatedDwellMinutes(place: Place): number | null {
  if (!place.category) return null;
  return DWELL_MINUTES[place.category] ?? null;
}

// ---------------------------------------------------------------------------
// local_pick — the floor. v1's reel-mention-ranked "Best of the City"
// (plan-v1-home-pivot.md §0) — always produces something when the curated
// pool is non-empty, so the stack is never truly empty in covered cities.
// Cheap/free only (v0 §1) — same reasoning as event_tonight above.
// ---------------------------------------------------------------------------
/** Overlap between a place's mapped interest tags and the stated persona interests — capped at 2, same cap `rank.ts`'s `interestFit` uses, so one generator's sort bias doesn't run away further than the score multiplier that follows it. */
function interestOverlapCount(persona: Persona, tags: Set<InterestTag>): number {
  let n = 0;
  for (const tag of tags) if (persona.interests.has(tag)) n++;
  return Math.min(n, 2);
}

function localPick(ctx: FeedContext, exclude: Set<string>): Candidate[] {
  const pool = [...ctx.candidatePlaces]
    .filter((p) => !exclude.has(`place:${p.id}`))
    .filter((p) => priceSignalForPlace(p) === "cheap")
    .sort((a, b) => {
      const overlapA = interestOverlapCount(ctx.persona, interestsForPlace(a));
      const overlapB = interestOverlapCount(ctx.persona, interestsForPlace(b));
      const scoreA = (a.mention_count ?? 0) * (1 + 0.4 * overlapA);
      const scoreB = (b.mention_count ?? 0) * (1 + 0.4 * overlapB);
      return scoreB - scoreA || (b.rating ?? 0) - (a.rating ?? 0);
    });

  return pool.slice(0, 8).map((place): Candidate => {
    const dist = placeDistanceKm(ctx.coords, place);
    const mentioned = (place.mention_count ?? 0) > 0;
    const tags = interestsForPlace(place);
    const matchedTag = [...tags].find((t) => ctx.persona.interests.has(t));
    return {
      generator: "local_pick",
      baseScore: 40,
      score: 40,
      subject: { type: "place", id: place.id },
      pill: "Worth knowing",
      why: matchedTag
        ? `Because you said ${INTEREST_TAG_META[matchedTag].label.toLowerCase()}`
        : mentioned
          ? "Keeps coming up in what people post here"
          : "A solid local pick",
      headline: place.name ?? "Nearby",
      detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist, ctx.persona))} walk.` : place.category ?? ""),
      primaryAction: { label: "Save", kind: "add" },
      image: placeImage(place),
      urgency: "low",
      validFrom: ctx.at.toISOString(),
      validUntil: new Date(ctx.at.getTime() + 12 * 3_600_000).toISOString(),
      distanceKm: dist,
      subjectName: place.name ?? "Nearby",
      coords: placeCoords(place),
      railTitle: "Near you now",
      railMeta: dist != null ? `${fmtMin(walkMinutes(dist, ctx.persona))} away` : "nearby",
    };
  });
}

// ---------------------------------------------------------------------------
// reel_echo — a place you recently liked/saved via a Reel is within a
// 30-minute walk right now. The only reel-engagement channel this reads is
// the `card_signals` row ReelViewer's heart "like" gesture writes with
// card_type "reel_like" (see components/social/ReelViewer.tsx's commitSwipe)
// — subject_type "place" when the liked reel has a resolved place, "reel"
// otherwise (which this generator ignores, since it has nothing to route to).
// Deliberately scoped to that one card_type, not every "saved" signal, so an
// ordinary Save tap doesn't also count as a reel echo — only a genuine reel
// like does. Reads straight off ctx.signals (already loaded by
// lib/now/context.ts's listRecentSignals, 72h window) and ctx.candidatePlaces
// — no new query.
// ---------------------------------------------------------------------------
const REEL_LIKE_CARD_TYPE = "reel_like";

export function reelEcho(ctx: FeedContext, exclude: Set<string>): Candidate[] {
  const likedPlaceIds = new Set(
    ctx.signals
      .filter((s) => s.card_type === REEL_LIKE_CARD_TYPE && s.subject_type === "place" && s.action === "saved")
      .map((s) => s.subject_id)
  );
  if (likedPlaceIds.size === 0) return [];

  // Phase 6 (plan §D.4) — the old flat 30min literal is now the "browse"
  // reach tier, persona-scoped.
  const maxWalkMinutes = reachMinutes(ctx.persona, "browse");
  const out: Candidate[] = [];
  for (const place of ctx.candidatePlaces) {
    if (exclude.has(`place:${place.id}`)) continue;
    if (!likedPlaceIds.has(place.id)) continue;
    const dist = placeDistanceKm(ctx.coords, place);
    if (dist == null) continue;
    const minutes = walkMinutes(dist, ctx.persona);
    if (minutes > maxWalkMinutes) continue;

    out.push({
      generator: "reel_echo",
      baseScore: 38,
      score: 38,
      subject: { type: "place", id: place.id },
      pill: "From your reels",
      why: "You liked this in a reel — it's close by",
      headline: place.name ?? "Nearby",
      detail: place.detail_line ?? `${fmtMin(minutes)} walk.`,
      primaryAction: { label: "Save", kind: "add" },
      image: placeImage(place),
      urgency: "low",
      validFrom: ctx.at.toISOString(),
      validUntil: new Date(ctx.at.getTime() + 4 * 3_600_000).toISOString(),
      distanceKm: dist,
      subjectName: place.name ?? "Nearby",
      coords: placeCoords(place),
      railTitle: "From reels you liked",
      railMeta: `${fmtMin(minutes)} away`,
    });
  }
  // Descending — highest score first — so slice(0, 3) keeps the top-scoring
  // candidates. Sorting ascending here kept the *lowest*-scoring ones.
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// ---------------------------------------------------------------------------
// indoor_pick — a rainy-day pick, independent of any day plan.
// ---------------------------------------------------------------------------
export function indoorPick(ctx: FeedContext, exclude: Set<string>): Candidate[] {
  // Phase 6 (plan §D.5) — same interest-overlap bias as local_pick's sort,
  // ahead of the mention/rating tiebreak.
  const pool = ctx.candidatePlaces
    .filter((p) => !exclude.has(`place:${p.id}`) && isIndoorish(p))
    .sort((a, b) => {
      const overlapA = interestOverlapCount(ctx.persona, interestsForPlace(a));
      const overlapB = interestOverlapCount(ctx.persona, interestsForPlace(b));
      return overlapB - overlapA || (b.mention_count ?? 0) - (a.mention_count ?? 0) || (b.rating ?? 0) - (a.rating ?? 0);
    });

  return pool.slice(0, 10).map((place): Candidate => {
    const dist = placeDistanceKm(ctx.coords, place);
    return {
      generator: "indoor_pick",
      baseScore: 45,
      score: 45,
      subject: { type: "place", id: place.id },
      pill: "Indoors",
      why: "Because it's raining out",
      headline: place.name ?? "Nearby",
      detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist, ctx.persona))} walk.` : ""),
      primaryAction: { label: "Save", kind: "add" },
      image: placeImage(place),
      urgency: "low",
      validFrom: ctx.at.toISOString(),
      validUntil: new Date(ctx.at.getTime() + 4 * 3_600_000).toISOString(),
      distanceKm: dist,
      subjectName: place.name ?? "Nearby",
      coords: placeCoords(place),
      railTitle: "Somewhere dry",
      railMeta: "it's raining",
    };
  });
}

// ---------------------------------------------------------------------------
// saved_pick — reads ctx.savedItems (lib/db/saved.ts's saved_items, loaded
// in lib/now/context.ts). Best-effort: only resolves against subjects
// already in this request's candidate pools (places/events/experiences),
// matching reelEcho's precedent above of not issuing a fresh per-subject
// lookup query. A saved item whose subject isn't in today's pool simply
// won't surface here.
// ---------------------------------------------------------------------------
export function savedPick(ctx: FeedContext, exclude: Set<string>): Candidate[] {
  if (ctx.savedItems.length === 0) return [];
  const out: Candidate[] = [];

  for (const saved of ctx.savedItems) {
    const key = `${saved.subject_type}:${saved.subject_id}`;
    if (exclude.has(key)) continue;

    if (saved.subject_type === "place") {
      const place = ctx.candidatePlaces.find((p) => p.id === saved.subject_id);
      if (!place) continue;
      const dist = placeDistanceKm(ctx.coords, place);
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "place", id: place.id },
        pill: "Saved",
        why: "You saved this",
        headline: place.name ?? "Saved place",
        detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist, ctx.persona))} walk.` : ""),
        primaryAction: { label: "Save", kind: "add" },
        image: placeImage(place),
        urgency: "low",
        validFrom: ctx.at.toISOString(),
        validUntil: new Date(ctx.at.getTime() + 24 * 3_600_000).toISOString(),
        distanceKm: dist,
        subjectName: place.name ?? "Saved place",
        coords: placeCoords(place),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    } else if (saved.subject_type === "event") {
      const event = ctx.candidateEvents.find((e) => e.id === saved.subject_id);
      if (!event) continue;
      const title = eventHeadline(event.name, ctx.city.name);
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "event", id: event.id },
        pill: "Saved",
        why: "You saved this",
        headline: title,
        detail: venueLabel(event.venue_name) ?? "",
        primaryAction: { label: "Save", kind: "add" },
        image: eventImage(event.image_url),
        urgency: "low",
        validFrom: ctx.at.toISOString(),
        validUntil: event.starts_at,
        distanceKm: null,
        subjectName: title,
        coords: placeCoords(event),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    } else if (saved.subject_type === "experience") {
      const exp = ctx.candidateExperiences.find((e) => e.id === saved.subject_id);
      if (!exp) continue;
      out.push({
        generator: "saved_pick",
        baseScore: 50,
        score: 50,
        subject: { type: "experience", id: exp.id },
        pill: "Saved",
        why: "You saved this",
        headline: exp.title,
        detail: exp.price_from != null ? `From ${exp.currency ?? ""}${exp.price_from}` : exp.duration_label ?? "",
        primaryAction: { label: "Book", kind: "book" },
        image: { url: exp.image_url, quality: exp.image_url ? "thin" : "none" },
        urgency: "low",
        validFrom: ctx.at.toISOString(),
        validUntil: new Date(ctx.at.getTime() + 48 * 3_600_000).toISOString(),
        distanceKm: null,
        subjectName: exp.title,
        coords: placeCoords(exp),
        railTitle: "You saved these",
        railMeta: "from your saves",
      });
    }
    // subject_type "itinerary_item" / "reel" / "practicality": no lookup
    // pool here — skipped.
  }

  return out;
}

// ---------------------------------------------------------------------------
// family_pick — low dwell, short ("browse") reach, indoor preference when
// it's raining. Gated on `persona.hasYoungKids`, which is permanently false
// now that the trip-scoped `kid_ages` source is gone (see lib/now/persona.ts)
// — kept per the brief, but dormant until a person-scoped replacement exists.
// ---------------------------------------------------------------------------
/** "Low dwell" ceiling for the kids pool — anything DWELL_MINUTES doesn't already flag as long stays in; short attention spans, not a hard science. */
const FAMILY_MAX_DWELL_MINUTES = 45;

export function familyPick(ctx: FeedContext, exclude: Set<string>): Candidate[] {
  if (!ctx.persona.hasYoungKids) return [];
  const reach = reachKm(ctx.persona, "browse");
  const isRaining = ctx.weather?.condition === "rainy" || ctx.weather?.condition === "windy";

  const pool = ctx.candidatePlaces
    .filter((p) => !exclude.has(`place:${p.id}`))
    .filter((p) => {
      const dwell = estimatedDwellMinutes(p);
      return dwell == null || dwell <= FAMILY_MAX_DWELL_MINUTES;
    })
    .map((p) => ({ place: p, dist: placeDistanceKm(ctx.coords, p) }))
    .filter(({ dist }) => dist == null || dist <= reach)
    .sort((a, b) => {
      if (isRaining) {
        const indoorA = Number(isIndoorish(a.place));
        const indoorB = Number(isIndoorish(b.place));
        if (indoorA !== indoorB) return indoorB - indoorA;
      }
      return (b.place.mention_count ?? 0) - (a.place.mention_count ?? 0) || (b.place.rating ?? 0) - (a.place.rating ?? 0);
    });

  return pool.slice(0, 8).map(({ place, dist }): Candidate => ({
    generator: "family_pick",
    baseScore: 42,
    score: 42,
    subject: { type: "place", id: place.id },
    pill: "Easy with kids",
    why: "Short and close by — easy with a little one",
    headline: place.name ?? "Nearby",
    detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist, ctx.persona))} walk.` : place.category ?? ""),
    primaryAction: { label: "Save", kind: "add" },
    image: placeImage(place),
    urgency: "low",
    validFrom: ctx.at.toISOString(),
    validUntil: new Date(ctx.at.getTime() + 8 * 3_600_000).toISOString(),
    distanceKm: dist,
    subjectName: place.name ?? "Nearby",
    coords: placeCoords(place),
    railTitle: "Easy with the little ones",
    railMeta: dist != null ? `${fmtMin(walkMinutes(dist, ctx.persona))} away` : "nearby",
  }));
}

/**
 * Runs every generator and returns the raw candidate pool (unscored,
 * un-deduped beyond each generator's own exclusion pass) — lib/now/rank.ts
 * owns scoring, filtering, and diversity-constrained selection.
 */
export async function generateCandidates(ctx: FeedContext): Promise<Candidate[]> {
  const early: Candidate[] = [...closingSoon(ctx, new Set())];
  const exclude = usedIds(early);

  const rest: Candidate[] = [
    ...eventTonight(ctx),
    ...reelEcho(ctx, exclude),
    ...indoorPick(ctx, exclude),
    ...savedPick(ctx, exclude),
    ...familyPick(ctx, exclude),
    ...localPick(ctx, exclude),
  ];

  return [...early, ...rest];
}
