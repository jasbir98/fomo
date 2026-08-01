// Roameo event category normalization — shared by every provider mapper in
// lib/events/ and by the /api/events route's `category` query filter.
// Mirrors normalizeCategory's shape in lib/places/google.ts.
import "server-only";

export type EventCategory =
  | "music"
  | "nightlife"
  | "festival"
  | "arts"
  | "comedy"
  | "sports"
  | "food"
  | "family"
  | "other";

const CATEGORY_SLUGS: EventCategory[] = [
  "music",
  "nightlife",
  "festival",
  "arts",
  "comedy",
  "sports",
  "food",
  "family",
  "other",
];

/** Narrow an arbitrary query slug to a known EventCategory (or undefined). */
export function normalizeCategory(
  raw: string | null | undefined
): EventCategory | undefined {
  if (!raw) return undefined;
  const slug = raw.toLowerCase().trim();
  return (CATEGORY_SLUGS as string[]).includes(slug)
    ? (slug as EventCategory)
    : undefined;
}

// Skiddle's `eventcode` → Roameo category.
const SKIDDLE_EVENTCODE_MAP: Record<string, EventCategory> = {
  CLUB: "nightlife",
  LIVE: "music",
  FEST: "festival",
  THEATRE: "arts",
  ARTS: "arts",
  EXHIB: "arts",
  COMEDY: "comedy",
  DATE: "food",
  KIDS: "family",
  SPORT: "sports",
};

/** Map a Skiddle `eventcode` (e.g. "LIVE") to a Roameo category slug. */
export function categoryFromSkiddleCode(
  raw: string | null | undefined
): EventCategory {
  if (!raw) return "other";
  return SKIDDLE_EVENTCODE_MAP[raw.toUpperCase().trim()] ?? "other";
}

// Ticketmaster's `classifications[].segment.name` → Roameo category.
const TICKETMASTER_SEGMENT_MAP: Record<string, EventCategory> = {
  Music: "music",
  Sports: "sports",
  "Arts & Theatre": "arts",
  Film: "arts",
  Miscellaneous: "other",
};

/** Map a Ticketmaster classification segment name to a Roameo category slug. */
export function categoryFromTicketmasterSegment(
  raw: string | null | undefined
): EventCategory {
  if (!raw) return "other";
  return TICKETMASTER_SEGMENT_MAP[raw.trim()] ?? "other";
}
