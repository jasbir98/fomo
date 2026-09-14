import "server-only";
import { getPreferences } from "@/lib/db/preferences";
import { getEventsForDestination } from "@/lib/events/getForDestination";
import { getExperiencesForDestination } from "@/lib/experiences/getForDestination";
import { loadCandidatePlaces } from "@/lib/now/context";
import {
  distanceKm,
  fmtMin,
  isIndoorish,
  placeCoords,
  placeDistanceKm,
  placeImage,
  walkMinutes,
} from "@/lib/now/generators";
import { resolvePersona, type Persona } from "@/lib/now/persona";
import { CITY } from "@/lib/city";
import type { EventItem, Experience, Place } from "@/lib/types";
import type { Coordinates } from "@/lib/geo";
import type { Candidate, DiscoverIntentSlug, DiscoverResponse } from "@/lib/now/types";
import type { Db } from "@/lib/supabase/types";

const NOW_STAMP = () => new Date().toISOString();
const HOURS = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

function placeToCandidate(place: Place, coords: Coordinates | null, persona: Persona): Candidate {
  const dist = placeDistanceKm(coords, place);
  const mentioned = (place.mention_count ?? 0) > 0;
  return {
    generator: "discover",
    baseScore: 0,
    score: 0,
    subject: { type: "place", id: place.id },
    pill: place.category ?? "Nearby",
    why: mentioned
      ? "Keeps coming up in what people post here"
      : dist != null
        ? `${fmtMin(walkMinutes(dist, persona))} walk`
        : "Worth a look",
    headline: place.name ?? "Nearby",
    detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist, persona))} walk.` : place.category ?? ""),
    primaryAction: { label: "Save", kind: "add" },
    image: placeImage(place),
    urgency: "low",
    validFrom: NOW_STAMP(),
    validUntil: HOURS(12),
    distanceKm: dist,
    subjectName: place.name ?? "Nearby",
    coords: placeCoords(place),
    railTitle: "",
    railMeta: "",
  };
}

function eventToCandidate(event: EventItem, coords: Coordinates | null, persona: Persona): Candidate {
  const dist = coords && event.lat != null && event.lng != null ? distanceKm(coords, { lat: event.lat, lng: event.lng }) : null;
  const start = new Date(event.starts_at);
  return {
    generator: "discover",
    baseScore: 0,
    score: 0,
    subject: { type: "event", id: event.id },
    pill: start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    why: event.is_free ? "Free" : event.price_from != null ? `From ${event.currency ?? ""}${event.price_from}` : "",
    headline: event.name,
    detail: [event.venue_name, dist != null ? `${fmtMin(walkMinutes(dist, persona))} walk` : null].filter(Boolean).join(" · "),
    primaryAction: { label: "Save", kind: "add" },
    image: { url: event.image_url, quality: event.image_url ? "thin" : "none" },
    urgency: "low",
    validFrom: NOW_STAMP(),
    validUntil: event.starts_at,
    distanceKm: dist,
    subjectName: event.name,
    coords: placeCoords(event),
    railTitle: "",
    railMeta: "",
  };
}

function experienceToCandidate(exp: Experience): Candidate {
  return {
    generator: "discover",
    baseScore: 0,
    score: 0,
    subject: { type: "experience", id: exp.id },
    pill: exp.duration_label ?? "Experience",
    why: exp.rating != null ? `${exp.rating.toFixed(1)}★${exp.review_count ? ` (${exp.review_count})` : ""}` : "",
    headline: exp.title,
    detail: exp.price_from != null ? `From ${exp.currency ?? ""}${exp.price_from}` : exp.description ?? "",
    primaryAction: { label: "Book", kind: "book" },
    image: { url: exp.image_url, quality: exp.image_url ? "thin" : "none" },
    urgency: "low",
    validFrom: NOW_STAMP(),
    validUntil: HOURS(48),
    distanceKm: null,
    subjectName: exp.title,
    coords: placeCoords(exp),
    railTitle: "",
    railMeta: "",
  };
}

const FOOD_HINTS = ["restaurant", "cafe", "food", "dining", "bar", "izakaya", "yakitori", "sushi", "noodle", "pub"];
function isFoodish(place: Place): boolean {
  const hay = `${place.category ?? ""} ${place.name ?? ""}`.toLowerCase();
  return FOOD_HINTS.some((h) => hay.includes(h));
}

const NIGHTLIFE_HINTS = ["bar", "nightlife", "pub", "izakaya", "club"];
function isNightlifeish(place: Place): boolean {
  const hay = `${place.category ?? ""} ${place.name ?? ""}`.toLowerCase();
  return NIGHTLIFE_HINTS.some((h) => hay.includes(h));
}

function byMentionThenRating(a: Place, b: Place): number {
  return (b.mention_count ?? 0) - (a.mention_count ?? 0) || (b.rating ?? 0) - (a.rating ?? 0);
}

/** Default page size for the discover surface — see lib/useInfiniteList.ts. */
const DEFAULT_DISCOVER_LIMIT = 40;

export interface BuildDiscoverInput {
  db: Db;
  intent: DiscoverIntentSlug;
  coords: Coordinates | null;
  limit?: number;
  offset?: number;
}

/** Chip-opened picture grid (plan-v1-home-pivot.md §6). Never a blank search — arrives pre-filtered and pre-answered. */
export async function buildDiscoverResponse(input: BuildDiscoverInput): Promise<DiscoverResponse> {
  const { db, intent, coords } = input;
  const limit = input.limit ?? DEFAULT_DISCOVER_LIMIT;
  const offset = input.offset ?? 0;

  const [candidatePlaces, prefs] = await Promise.all([
    loadCandidatePlaces(db, coords),
    getPreferences(db).catch(() => null),
  ]);
  const persona = resolvePersona(prefs);
  let title = "";
  let items: Candidate[] = [];

  if (intent === "tonight") {
    title = "What's on tonight";
    const midnight = new Date();
    midnight.setHours(26, 0, 0, 0); // 2am "tomorrow"
    // Ask for enough events to cover this page (the events pipeline doesn't
    // carry a true offset through to its providers — see
    // lib/events/getForDestination.ts — so, like /api/places' live-Google
    // branch, this over-fetches to `offset + limit` and windows the result
    // below).
    const events = await getEventsForDestination(db, {
      destination: CITY.name,
      to: midnight.toISOString(),
      limit: offset + limit,
    })
      .then((r) => r.events)
      .catch((err) => {
        console.error("[now/discover] events lookup failed", err);
        return [];
      });
    items = events
      .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
      .map((e) => eventToCandidate(e, coords, persona));
    if (items.length < 4) {
      const usedIds = new Set(items.map((c) => c.subject.id));
      const filler = candidatePlaces
        .filter((p) => isNightlifeish(p) && !usedIds.has(p.id))
        .sort(byMentionThenRating)
        .slice(0, Math.max(6, limit) - items.length)
        .map((p) => placeToCandidate(p, coords, persona));
      items = [...items, ...filler];
    }
    items = items.slice(offset, offset + limit);
  } else if (intent === "book") {
    title = "Book something";
    // getExperiencesForDestination already supports limit/offset natively
    // (it fans out to the provider APIs with those params) — pass them
    // straight through instead of over-fetching-and-slicing.
    const experiences = await getExperiencesForDestination(db, { destination: CITY.name, limit, offset })
      .then((r) => r.experiences)
      .catch((err) => {
        console.error("[now/discover] experiences lookup failed", err);
        return [];
      });
    items = [...experiences].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).map(experienceToCandidate);
  } else if (intent === "eat") {
    title = "Eat near me";
    items = candidatePlaces
      .filter(isFoodish)
      .sort((a, b) => byMentionThenRating(a, b) || (placeDistanceKm(coords, a) ?? 99) - (placeDistanceKm(coords, b) ?? 99))
      .slice(offset, offset + limit)
      .map((p) => placeToCandidate(p, coords, persona));
  } else if (intent === "nearby") {
    // See-all target for Home's generic "everything around me" browse,
    // distinct from "eat" (food-only).
    title = "Near you";
    items = candidatePlaces
      .sort(
        (a, b) =>
          (placeDistanceKm(coords, a) ?? Number.POSITIVE_INFINITY) -
            (placeDistanceKm(coords, b) ?? Number.POSITIVE_INFINITY) || byMentionThenRating(a, b)
      )
      .slice(offset, offset + limit)
      .map((p) => placeToCandidate(p, coords, persona));
  } else {
    // indoors
    title = "Indoors near me";
    items = candidatePlaces
      .filter(isIndoorish)
      .sort(byMentionThenRating)
      .slice(offset, offset + limit)
      .map((p) => placeToCandidate(p, coords, persona));
  }

  const meta = coords ? `${items.length} things, walkable` : `${items.length} things`;
  // Only the first page reports "empty" as a degrade — an empty later page
  // just means pagination reached the end.
  return { title, meta, items, degraded: items.length === 0 && offset === 0 ? "empty" : null };
}
