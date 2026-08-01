import "server-only";
import { getTrip } from "@/lib/db/trips";
import { getForecastForDestination } from "@/lib/weather";
import { loadCandidatePlaces } from "@/lib/now/context";
import { placeDistanceKm, placeImage, walkMinutes, fmtMin } from "@/lib/now/generators";
import { offsetSuffix } from "@/lib/now/dayplan";
import type { Place } from "@/lib/types";
import type { Coordinates } from "@/lib/geo";
import type { CardImage } from "@/lib/now/types";

/**
 * "Draft my day" (plan-v1.1-overhaul.md W4 #4) — Plan's empty-day state.
 * Deliberately a smaller shape than a full `Candidate` (lib/now/types.ts):
 * these are *proposed itinerary items* for a specific day, not ranked "do
 * this now" cards, so there's no urgency/validFrom/validUntil/pill — just
 * enough to render a preview and let `POST /plan/item` (createItem, reused
 * as-is) turn one into a real row if the traveller accepts it.
 */
export interface DraftItemSuggestion {
  /** Stable per-request id (`slot.category:place.id`) — lets the client track accept/ignore per card without a server round trip. */
  id: string;
  subject: { type: "place"; id: string };
  title: string;
  category: string;
  timeLabel: string;
  /** ISO, anchored to the destination's local time via the same day-bounds offset lib/now/dayplan.ts uses — never the server's own timezone. */
  startsAt: string;
  location: string | null;
  image: CardImage;
  why: string;
}

export interface DraftDayResponse {
  suggestions: DraftItemSuggestion[];
  degraded: "no-trip" | "no-coverage" | null;
}

const FOOD_HINTS = ["restaurant", "cafe", "food", "dining", "izakaya", "yakitori", "sushi", "noodle", "bistro"];
function isFoodish(place: Place): boolean {
  const hay = `${place.category ?? ""} ${place.name ?? ""}`.toLowerCase();
  return FOOD_HINTS.some((h) => hay.includes(h));
}

// Three slots across the day — morning activity, lunch, evening activity —
// enough to feel like a real day without pretending to be a full itinerary.
// itinerary_items.category values match CATEGORY_META (app/(shell)/plan/page.tsx).
const SLOTS: { hour: number; minute: number; category: string; why: string }[] = [
  { hour: 10, minute: 0, category: "activity", why: "A good place to start the morning" },
  { hour: 13, minute: 0, category: "dining", why: "Lunch, close to the rest of the day" },
  { hour: 18, minute: 30, category: "activity", why: "Worth doing before the day winds down" },
];

function placeLocation(place: Place): string | null {
  return place.address || [place.city, place.prefecture].filter(Boolean).join(", ") || null;
}

/**
 * Generates ~3 suggested itinerary items for a day with nothing planned yet,
 * drawn from the same curated-first candidate pool the ranker uses
 * (lib/now/context.ts's loadCandidatePlaces) — one per SLOTS entry, highest
 * mention/rating first, never repeating a place across slots. Never throws;
 * degrades to an empty suggestion list with a reason.
 */
export async function buildDraftDay(input: {
  deviceId: string;
  tripId: string;
  day: string; // YYYY-MM-DD
  coords: Coordinates | null;
}): Promise<DraftDayResponse> {
  const { deviceId, tripId, day, coords } = input;
  const trip = await getTrip(deviceId, tripId);
  if (!trip) return { suggestions: [], degraded: "no-trip" };

  const [candidatePlaces, forecast] = await Promise.all([
    loadCandidatePlaces(trip.destination, coords),
    trip.destination
      ? getForecastForDestination(trip.destination).catch(() => ({ center: null, days: [], utcOffsetSeconds: null, degraded: "error" }))
      : Promise.resolve({ center: null, days: [], utcOffsetSeconds: null, degraded: "no-destination" }),
  ]);

  if (candidatePlaces.length === 0) return { suggestions: [], degraded: "no-coverage" };

  const suffix = forecast.utcOffsetSeconds != null ? offsetSuffix(forecast.utcOffsetSeconds) : "Z";
  const sorted = [...candidatePlaces].sort(
    (a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0) || (b.rating ?? 0) - (a.rating ?? 0)
  );

  const used = new Set<string>();
  const suggestions: DraftItemSuggestion[] = [];
  for (const slot of SLOTS) {
    const pool = (slot.category === "dining" ? sorted.filter(isFoodish) : sorted).filter((p) => !used.has(p.id));
    const pick = pool[0] ?? sorted.find((p) => !used.has(p.id));
    if (!pick) continue;
    used.add(pick.id);

    const hh = String(slot.hour).padStart(2, "0");
    const mm = String(slot.minute).padStart(2, "0");
    const startsAt = new Date(`${day}T${hh}:${mm}:00${suffix}`);
    const dist = placeDistanceKm(coords, pick);

    suggestions.push({
      id: `${slot.category}:${pick.id}`,
      subject: { type: "place", id: pick.id },
      title: pick.name ?? "Suggested stop",
      category: slot.category,
      timeLabel: startsAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      startsAt: startsAt.toISOString(),
      location: placeLocation(pick),
      image: placeImage(pick),
      why: dist != null ? `${slot.why} · ${fmtMin(walkMinutes(dist))} walk` : slot.why,
    });
  }

  return { suggestions, degraded: suggestions.length === 0 ? "no-coverage" : null };
}
