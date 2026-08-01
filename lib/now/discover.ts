import "server-only";
import { getTrip } from "@/lib/db/trips";
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
import type { EventItem, Experience, Place } from "@/lib/types";
import type { Coordinates } from "@/lib/geo";
import type { Candidate, DiscoverIntentSlug, DiscoverResponse } from "@/lib/now/types";

const NOW_STAMP = () => new Date().toISOString();
const HOURS = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

function placeToCandidate(place: Place, coords: Coordinates | null): Candidate {
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
        ? `${fmtMin(walkMinutes(dist))} walk`
        : "Worth a look",
    headline: place.name ?? "Nearby",
    detail: place.detail_line ?? (dist != null ? `${fmtMin(walkMinutes(dist))} walk.` : place.category ?? ""),
    primaryAction: { label: "Add to today", kind: "add" },
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

function eventToCandidate(event: EventItem, coords: Coordinates | null): Candidate {
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
    detail: [event.venue_name, dist != null ? `${fmtMin(walkMinutes(dist))} walk` : null].filter(Boolean).join(" · "),
    primaryAction: { label: "Add to today", kind: "add" },
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

export interface BuildDiscoverInput {
  deviceId: string;
  tripId: string;
  intent: DiscoverIntentSlug;
  coords: Coordinates | null;
}

/** Chip-opened picture grid (plan-v1-home-pivot.md §6). Never a blank search — arrives pre-filtered and pre-answered. */
export async function buildDiscoverResponse(input: BuildDiscoverInput): Promise<DiscoverResponse> {
  const { deviceId, tripId, intent, coords } = input;
  const trip = await getTrip(deviceId, tripId);
  if (!trip) return { title: "", meta: "", items: [], degraded: "no-trip" };

  const candidatePlaces = await loadCandidatePlaces(trip.destination, coords);
  let title = "";
  let items: Candidate[] = [];

  if (intent === "tonight") {
    title = "What's on tonight";
    const midnight = new Date();
    midnight.setHours(26, 0, 0, 0); // 2am "tomorrow"
    const events = trip.destination
      ? await getEventsForDestination({ destination: trip.destination, to: midnight.toISOString(), limit: 20 })
          .then((r) => r.events)
          .catch((err) => {
            console.error("[now/discover] events lookup failed", err);
            return [];
          })
      : [];
    items = events.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()).map((e) => eventToCandidate(e, coords));
    if (items.length < 4) {
      const usedIds = new Set(items.map((c) => c.subject.id));
      const filler = candidatePlaces
        .filter((p) => isNightlifeish(p) && !usedIds.has(p.id))
        .sort(byMentionThenRating)
        .slice(0, 6 - items.length)
        .map((p) => placeToCandidate(p, coords));
      items = [...items, ...filler];
    }
  } else if (intent === "book") {
    title = "Book something";
    const experiences = trip.destination
      ? await getExperiencesForDestination({ destination: trip.destination })
          .then((r) => r.experiences)
          .catch((err) => {
            console.error("[now/discover] experiences lookup failed", err);
            return [];
          })
      : [];
    items = [...experiences].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).map(experienceToCandidate);
  } else if (intent === "eat") {
    title = "Eat near me";
    items = candidatePlaces
      .filter(isFoodish)
      .sort((a, b) => byMentionThenRating(a, b) || (placeDistanceKm(coords, a) ?? 99) - (placeDistanceKm(coords, b) ?? 99))
      .slice(0, 20)
      .map((p) => placeToCandidate(p, coords));
  } else {
    // gap | indoors
    title = intent === "indoors" ? "Indoors near me" : "A few hours";
    items = candidatePlaces
      .filter((p) => (intent === "indoors" ? isIndoorish(p) : true))
      .sort(byMentionThenRating)
      .slice(0, 20)
      .map((p) => placeToCandidate(p, coords));
  }

  const meta = coords ? `${items.length} things, walkable` : `${items.length} things`;
  return { title, meta, items, degraded: items.length === 0 ? "empty" : null };
}
