// Helpers for resolving which shared Place (if any) a scraped reel is about,
// and for generating a friendly "best time to go" suggestion for its category.
import type { Place, SocialPost } from "@/lib/types";

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** name / station / address fields of a place, normalized, skipping empties. */
function placeFields(place: Place): string[] {
  return [place.name, place.station, place.address]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .map(normalize);
}

/** First place whose name/station/address contains (or is contained by) needle. */
function findMatch(needle: string, places: Place[]): Place | null {
  if (!needle) return null;
  return (
    places.find((p) =>
      placeFields(p).some((field) => field.includes(needle) || needle.includes(field))
    ) ?? null
  );
}

/** Caption words worth trying as a fallback match — drop short/stopword-ish tokens. */
function captionWords(caption: string): string[] {
  return caption
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4);
}

/**
 * Resolve the shared Place a reel is about, in order of confidence:
 * (a) explicit reel.place_id match, (b) case-insensitive substring match of
 * reel.location (then a word from the caption) against place name/station/
 * address, (c) null if nothing matches.
 */
export function resolvePlaceForReel(reel: SocialPost, places: Place[]): Place | null {
  if (reel.place_id) {
    return places.find((p) => p.id === reel.place_id) ?? null;
  }

  if (reel.location) {
    const match = findMatch(normalize(reel.location), places);
    if (match) return match;
  }

  if (reel.caption) {
    for (const word of captionWords(reel.caption)) {
      const match = findMatch(normalize(word), places);
      if (match) return match;
    }
  }

  return null;
}

/** Friendly static "best time to go" suggestion keyed off a place's category. */
export function bestTimeForCategory(category: string | null): string {
  const lower = (category ?? "").toLowerCase();
  const rules: Array<[string[], string]> = [
    [
      ["food", "dining", "restaurant"],
      "Lunch 11:30am–1pm or dinner after 6pm — go early to skip lines",
    ],
    [["cafe", "coffee"], "Mid-morning, before the 11am rush"],
    [["photo", "view", "viewpoint", "scenic"], "Golden hour — about an hour before sunset"],
    [["bar", "night", "club"], "After 8pm when it gets lively"],
    [["temple", "shrine", "museum", "gallery"], "Right at opening — quietest before 10am"],
    [["park", "nature", "garden"], "Early morning or late afternoon light"],
    [["shopping", "market"], "Weekday mornings to avoid crowds"],
  ];

  for (const [keywords, suggestion] of rules) {
    if (keywords.some((k) => lower.includes(k))) return suggestion;
  }
  return "Weekday mornings tend to be quietest";
}
