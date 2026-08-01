import "server-only";
import type { OpeningHoursPeriod, Place } from "@/lib/types";
import { getArrivalTip } from "@/lib/db/arrivalTips";
import { getAlternatives, buildDisruptionAlert } from "@/lib/disruption";
import type { Candidate, RankContext } from "@/lib/now/types";

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

export function walkMinutes(km: number): number {
  return Math.round((km / 4.8) * 60); // ~4.8km/h walking pace
}

export function placeDistanceKm(coords: { lat: number; lng: number } | null, place: Place): number | null {
  if (!coords || place.lat == null || place.lng == null) return null;
  return distanceKm(coords, { lat: place.lat, lng: place.lng });
}

export function placeImage(place: Place): Candidate["image"] {
  return { url: place.image_url, quality: place.image_url ? place.image_quality ?? "thin" : "none" };
}

export function placeCoords(place: { lat: number | null; lng: number | null }): Candidate["coords"] {
  return place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null;
}

export function fmtMin(min: number): string {
  return `${Math.round(min)} min`;
}

/** `opening_hours` is `[{ day: 0-6, open: "HH:MM", close: "HH:MM" }]`; `close` can be past midnight relative to `open` on the same entry (an overnight span). */
function minutesUntilClose(place: Place, at: Date): number | null {
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
// weather_swap — reuses lib/disruption.ts, the existing weather-swap engine.
// Fires on today's scheduled items flagged weather_alert once the forecast
// actually confirms disruptive weather (weather_alert is a manual/display
// hint set elsewhere; this generator is the one place that cross-checks it
// against the real forecast before acting on it).
// ---------------------------------------------------------------------------
async function weatherSwap(ctx: RankContext): Promise<Candidate[]> {
  if (!ctx.weather?.isDisruptive || !ctx.trip.destination) return [];
  const flagged = ctx.todaysItems.find((i) => i.weather_alert && i.starts_at && new Date(i.starts_at) >= ctx.at);
  if (!flagged) return [];

  const alert = buildDisruptionAlert(ctx.weather, flagged.title);
  const { alternatives } = await getAlternatives(ctx.trip.destination);
  const pick = alternatives[0];
  if (!pick) return [];

  return [
    {
      generator: "weather_swap",
      baseScore: 100,
      score: 100,
      subject: { type: "itinerary_item", id: flagged.id },
      pill: "Weather",
      why: `Because your ${flagged.time_label ?? "next"} plan is outdoors`,
      headline: `${alert.headline.split(" (")[0]}. Swap "${flagged.title}" for ${pick.title}.`,
      detail: pick.why,
      primaryAction: { label: "Swap them", kind: "swap" },
      image: { url: pick.image_url, quality: pick.image_url ? "thin" : "none" },
      urgency: "high",
      validFrom: ctx.at.toISOString(),
      validUntil: flagged.starts_at ?? ctx.at.toISOString(),
      distanceKm: null,
      subjectName: flagged.title ?? "Your plan",
      coords: null,
      railTitle: "Weather",
      railMeta: "affects today",
    },
  ];
}

// ---------------------------------------------------------------------------
// current_activity — you're mid-anchor right now.
// ---------------------------------------------------------------------------
function currentActivity(ctx: RankContext): Candidate[] {
  const item = ctx.currentItem;
  if (!item) return [];
  const place = ctx.candidatePlaces.find((p) => p.id === item.place_id);
  const endsAt = item.starts_at
    ? new Date(new Date(item.starts_at).getTime() + (item.duration_minutes ?? 90) * 60_000)
    : ctx.at;

  return [
    {
      generator: "current_activity",
      baseScore: 95,
      score: 95,
      subject: { type: item.place_id ? "place" : "itinerary_item", id: item.place_id ?? item.id },
      pill: `Now · until ${endsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      why: `You're here until ${endsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
      headline: item.title ?? "Right now",
      detail: place?.detail_line ?? item.location ?? "Enjoy — I'll have the next thing ready when you're done.",
      primaryAction: { label: "Ask Roameo", kind: "tell" },
      image: place ? placeImage(place) : { url: null, quality: "none" },
      urgency: "low",
      validFrom: ctx.at.toISOString(),
      validUntil: endsAt.toISOString(),
      distanceKm: 0,
      subjectName: item.title ?? "Right now",
      coords: place ? placeCoords(place) : null,
      railTitle: "For after",
      railMeta: "when you're moving again",
    },
  ];
}

// ---------------------------------------------------------------------------
// leave_by — next anchor is close enough that you should be heading there.
// ---------------------------------------------------------------------------
function leaveBy(ctx: RankContext): Candidate[] {
  if (ctx.currentItem || !ctx.nextAnchor?.starts_at) return [];
  const minutesToStart = (new Date(ctx.nextAnchor.starts_at).getTime() - ctx.at.getTime()) / 60_000;
  if (minutesToStart > 20 || minutesToStart < -5) return [];

  const place = ctx.candidatePlaces.find((p) => p.id === ctx.nextAnchor!.place_id);
  const dist = place ? placeDistanceKm(ctx.coords, place) : null;

  return [
    {
      generator: "leave_by",
      baseScore: 90,
      score: 90,
      subject: { type: "itinerary_item", id: ctx.nextAnchor.id },
      pill: "Leave now",
      why: minutesToStart <= 0 ? "It's time" : `Starts in ${fmtMin(minutesToStart)}`,
      headline: `Head to ${ctx.nextAnchor.title ?? "your next stop"}`,
      detail: dist != null ? `${fmtMin(walkMinutes(dist))} walk from here.` : ctx.nextAnchor.location ?? "",
      primaryAction: { label: "Directions", kind: "directions" },
      image: place ? placeImage(place) : { url: null, quality: "none" },
      urgency: "high",
      validFrom: ctx.at.toISOString(),
      validUntil: ctx.nextAnchor.starts_at,
      distanceKm: dist,
      subjectName: ctx.nextAnchor.title ?? "Your next stop",
      coords: place ? placeCoords(place) : null,
      railTitle: "Coming up",
      railMeta: "on your plan",
    },
  ];
}

// ---------------------------------------------------------------------------
// closing_soon — a curated place near you shuts within 90 minutes.
// ---------------------------------------------------------------------------
function closingSoon(ctx: RankContext, exclude: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const place of ctx.candidatePlaces) {
    if (exclude.has(`place:${place.id}`)) continue;
    const minsLeft = minutesUntilClose(place, ctx.at);
    if (minsLeft == null || minsLeft <= 0 || minsLeft > 90) continue;
    const dist = placeDistanceKm(ctx.coords, place);
    if (dist != null && dist > 3) continue;

    const closeAt = new Date(ctx.at.getTime() + minsLeft * 60_000);
    out.push({
      generator: "closing_soon",
      baseScore: 80,
      score: 80,
      subject: { type: "place", id: place.id },
      pill: "Closing soon",
      why: `Because the doors shut at ${closeAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
      headline: `${place.name}, now or not today`,
      detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist))} walk.` : ""),
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
  return out.sort((a, b) => a.score - b.score).slice(0, 3);
}

// ---------------------------------------------------------------------------
// arrival — cold-start / day-1 advice from the hand-authored arrival_tips set.
// ---------------------------------------------------------------------------
const COUNTRY_HINTS: [RegExp, string][] = [
  [/japan|tokyo|kyoto|osaka|hakone|kanazawa|nara/i, "JP"],
  [/scotland|edinburgh|glasgow|highlands|aberdeen|inverness/i, "GB"],
];

function guessCountry(ctx: RankContext): string | null {
  const fromPlace = ctx.candidatePlaces.find((p) => p.country)?.country;
  if (fromPlace) return fromPlace;
  const dest = ctx.trip.destination ?? "";
  for (const [re, code] of COUNTRY_HINTS) if (re.test(dest)) return code;
  return null;
}

async function arrival(ctx: RankContext): Promise<Candidate[]> {
  if (ctx.tripPhase !== "arrival") return [];
  const country = guessCountry(ctx);
  if (!country) return [];

  const startOfDay = ctx.trip.start_date ? new Date(`${ctx.trip.start_date}T00:00:00Z`) : ctx.at;
  const hoursSince = Math.max(0, (ctx.at.getTime() - startOfDay.getTime()) / 3_600_000);
  const tip = await getArrivalTip(country, cityGuess(ctx.trip.destination), hoursSince).catch(() => null);
  if (!tip) return [];

  return [
    {
      generator: "arrival",
      baseScore: 78,
      score: 78,
      subject: { type: "itinerary_item", id: `arrival:${tip.id}` },
      pill: "Right now",
      why: "Because you just landed",
      headline: tip.headline,
      detail: tip.detail,
      primaryAction: { label: ctx.coords ? "Ask Roameo" : "Turn on location", kind: ctx.coords ? "tell" : "location" },
      image: { url: null, quality: "none" },
      urgency: "medium",
      validFrom: ctx.at.toISOString(),
      validUntil: new Date(ctx.at.getTime() + 6 * 3_600_000).toISOString(),
      distanceKm: null,
      subjectName: tip.headline,
      coords: null,
      railTitle: "Guessing from your hotel until location's on",
      railMeta: "day 1",
    },
  ];
}

function cityGuess(destination: string | null): string | null {
  return destination?.split(",")[0]?.trim() || null;
}

// ---------------------------------------------------------------------------
// event_tonight — a cached event starting within 6 hours.
// ---------------------------------------------------------------------------
/**
 * Ticketing feeds carry placeholder venue rows ("Virtual Event Edinburgh",
 * "TBC", "Secret Location") that read as noise in a one-line detail. Drop
 * them rather than surfacing them verbatim — §13's specificity rule means a
 * vague venue is worse than no venue.
 */
const PLACEHOLDER_VENUE = /^(virtual event|online|tbc|tba|secret location|various)\b/i;

function venueLabel(name: string | null): string | null {
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
export function eventHeadline(name: string, destination: string | null): string {
  const city = destination?.split(",")[0]?.trim().toLowerCase() ?? "";
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

function eventTonight(ctx: RankContext): Candidate[] {
  const sixHoursOut = ctx.at.getTime() + 6 * 3_600_000;
  const candidates = ctx.candidateEvents.filter((e) => {
    const start = new Date(e.starts_at).getTime();
    return start >= ctx.at.getTime() && start <= sixHoursOut;
  });
  return candidates
    .map((e): Candidate => {
      const dist =
        ctx.coords && e.lat != null && e.lng != null ? distanceKm(ctx.coords, { lat: e.lat, lng: e.lng }) : null;
      const start = new Date(e.starts_at);
      const startLabel = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      const title = eventHeadline(e.name, ctx.trip.destination);
      return {
        generator: "event_tonight",
        baseScore: 70,
        score: 70,
        subject: { type: "event", id: e.id },
        pill: "Tonight",
        why: `Because doors are at ${startLabel}`,
        headline: title,
        detail:
          [venueLabel(e.venue_name), dist != null ? `${fmtMin(walkMinutes(dist))} walk` : null]
            .filter(Boolean)
            .join(" · ") || `On tonight at ${startLabel}.`,
        primaryAction: { label: "Add to today", kind: "add" },
        image: { url: e.image_url, quality: e.image_url ? "thin" : "none" },
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
    .sort((a, b) => a.score - b.score)
    .slice(0, 2);
}

// ---------------------------------------------------------------------------
// gap_filler — an open window over 90 minutes needs filling. Exported as
// `candidatesForGap` too — lib/now/dayplan.ts (Plan's gap blocks, §5.3)
// calls the same logic for every gap in a day, not just ctx.gaps[0].
// ---------------------------------------------------------------------------
export function candidatesForGap(
  places: Place[],
  gap: { startsAt: Date; endsAt: Date; minutes: number },
  isRaining: boolean,
  exclude: Set<string>,
  coords: { lat: number; lng: number } | null,
  limit = 3
): Candidate[] {
  const pool = places
    .filter((p) => !exclude.has(`place:${p.id}`))
    .filter((p) => (isRaining ? isIndoorish(p) : true))
    .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0));

  // Round the total first, then split into h/m — rounding each part
  // separately can carry a 59.6min remainder up to "60m" (e.g. "18h 60m").
  const totalMinutes = Math.round(gap.minutes);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const durationLabel = hours > 0 ? `${hours}h ${mins > 0 ? `${mins}m ` : ""}free` : `${mins}m free`;

  return pool.slice(0, limit).map((place): Candidate => {
    const dist = placeDistanceKm(coords, place);
    return {
      generator: "gap_filler",
      baseScore: 65,
      score: 65,
      subject: { type: "place", id: place.id },
      pill: "A few hours",
      why: `${durationLabel}${isRaining ? " · rain" : ""}`,
      headline: place.name ?? "Something nearby",
      detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist))} walk.` : ""),
      primaryAction: { label: "Add to today", kind: "add" },
      image: placeImage(place),
      urgency: "low",
      validFrom: gap.startsAt.toISOString(),
      validUntil: gap.endsAt.toISOString(),
      distanceKm: dist,
      subjectName: place.name ?? "Something nearby",
      coords: placeCoords(place),
      railTitle: isRaining ? "Indoors near me" : "A few hours",
      railMeta: durationLabel,
    };
  });
}

function gapFiller(ctx: RankContext, exclude: Set<string>): Candidate[] {
  if (ctx.gaps.length === 0) return [];
  const isRaining = ctx.weather?.condition === "rainy" || ctx.weather?.condition === "windy";
  return candidatesForGap(ctx.candidatePlaces, ctx.gaps[0], isRaining, exclude, ctx.coords);
}

const INDOOR_HINTS = ["museum", "gallery", "aquarium", "shopping", "mall", "arcade", "cafe", "indoor", "tea house"];
export function isIndoorish(place: Place): boolean {
  const hay = `${place.category ?? ""} ${place.name ?? ""}`.toLowerCase();
  return INDOOR_HINTS.some((h) => hay.includes(h));
}

// ---------------------------------------------------------------------------
// experience_leadtime — a bookable tour that needs booking today to run
// tomorrow. No provider exposes real per-listing lead-time data to us, so
// this uses the same heuristic the product brief calls out as a v1
// approximation: afternoon/evening + tomorrow otherwise unplanned.
// ---------------------------------------------------------------------------
function experienceLeadtime(ctx: RankContext): Candidate[] {
  if (ctx.at.getHours() < 15 || ctx.candidateExperiences.length === 0) return [];
  const pick = [...ctx.candidateExperiences].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
  if (!pick) return [];

  return [
    {
      generator: "experience_leadtime",
      baseScore: 60,
      score: 60,
      subject: { type: "experience", id: pick.id },
      pill: "Book tonight",
      why: "Needs booking today to run tomorrow",
      headline: pick.title,
      detail: [pick.duration_label, pick.price_from ? `from ${pick.currency ?? ""}${pick.price_from}` : null]
        .filter(Boolean)
        .join(" · "),
      primaryAction: { label: "Book", kind: "book" },
      image: { url: pick.image_url, quality: pick.image_url ? "thin" : "none" },
      urgency: "medium",
      validFrom: ctx.at.toISOString(),
      validUntil: new Date(ctx.at.getTime() + 8 * 3_600_000).toISOString(),
      distanceKm: null,
      subjectName: pick.title,
      coords: placeCoords(pick),
      railTitle: "Book something",
      railMeta: "for tomorrow",
    },
  ];
}

// ---------------------------------------------------------------------------
// local_pick — the floor. v1's reel-mention-ranked "Best of the City"
// (plan-v1-home-pivot.md §0) — always produces something when the curated
// pool is non-empty, so the stack is never truly empty in covered cities.
// ---------------------------------------------------------------------------
function localPick(ctx: RankContext, exclude: Set<string>): Candidate[] {
  const pool = [...ctx.candidatePlaces]
    .filter((p) => !exclude.has(`place:${p.id}`))
    .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0) || (b.rating ?? 0) - (a.rating ?? 0));

  return pool.slice(0, 4).map((place): Candidate => {
    const dist = placeDistanceKm(ctx.coords, place);
    const mentioned = (place.mention_count ?? 0) > 0;
    return {
      generator: "local_pick",
      baseScore: 40,
      score: 40,
      subject: { type: "place", id: place.id },
      pill: "Worth knowing",
      why: mentioned ? "Keeps coming up in what people post here" : "A solid local pick",
      headline: place.name ?? "Nearby",
      detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist))} walk.` : place.category ?? ""),
      primaryAction: { label: "Add to today", kind: "add" },
      image: placeImage(place),
      urgency: "low",
      validFrom: ctx.at.toISOString(),
      validUntil: new Date(ctx.at.getTime() + 12 * 3_600_000).toISOString(),
      distanceKm: dist,
      subjectName: place.name ?? "Nearby",
      coords: placeCoords(place),
      railTitle: "Near you now",
      railMeta: dist != null ? `${fmtMin(walkMinutes(dist))} away` : "nearby",
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
// ordinary Save tap from Home/Plan/Map/the reel action row (card_type "reel")
// doesn't also count as a reel echo — only a genuine reel like does. Reads
// straight off ctx.recentSignals (already loaded by lib/now/context.ts's
// listRecentSignals, 72h window) and ctx.candidatePlaces — no new query.
// ---------------------------------------------------------------------------
const REEL_LIKE_CARD_TYPE = "reel_like";
const REEL_ECHO_MAX_WALK_MIN = 30;

function reelEcho(ctx: RankContext, exclude: Set<string>): Candidate[] {
  const likedPlaceIds = new Set(
    ctx.recentSignals
      .filter((s) => s.card_type === REEL_LIKE_CARD_TYPE && s.subject_type === "place" && s.action === "saved")
      .map((s) => s.subject_id)
  );
  if (likedPlaceIds.size === 0) return [];

  const out: Candidate[] = [];
  for (const place of ctx.candidatePlaces) {
    if (exclude.has(`place:${place.id}`)) continue;
    if (!likedPlaceIds.has(place.id)) continue;
    const dist = placeDistanceKm(ctx.coords, place);
    if (dist == null) continue;
    const minutes = walkMinutes(dist);
    if (minutes > REEL_ECHO_MAX_WALK_MIN) continue;

    out.push({
      generator: "reel_echo",
      baseScore: 38,
      score: 38,
      subject: { type: "place", id: place.id },
      pill: "From your reels",
      why: "You liked this in a reel — it's close by",
      headline: place.name ?? "Nearby",
      detail: place.detail_line ?? `${fmtMin(minutes)} walk.`,
      primaryAction: { label: "Add to today", kind: "add" },
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
  return out.sort((a, b) => a.score - b.score).slice(0, 3);
}

/**
 * Runs every generator and returns the raw candidate pool (unscored,
 * un-deduped beyond each generator's own exclusion pass) — lib/now/rank.ts
 * owns scoring, filtering, and diversity-constrained selection.
 */
export async function generateCandidates(ctx: RankContext): Promise<Candidate[]> {
  const early: Candidate[] = [
    ...(await weatherSwap(ctx)),
    ...currentActivity(ctx),
    ...leaveBy(ctx),
    ...(await arrival(ctx)),
  ];
  const exclude = usedIds(early);

  const rest: Candidate[] = [
    ...closingSoon(ctx, exclude),
    ...eventTonight(ctx),
    ...gapFiller(ctx, exclude),
    ...experienceLeadtime(ctx),
    ...reelEcho(ctx, exclude),
    ...localPick(ctx, exclude),
  ];

  return [...early, ...rest];
}
