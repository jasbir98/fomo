// Client-safe cross-source event identity helpers — TS port of
// normalizeEventTitle / normalizeVenueKey / PROVIDER_PRIORITY in
// scripts/sources/core/dedupe.mjs. KEEP IN SYNC: that script is plain .mjs run by
// node directly and cannot import this file, so the two copies must be
// edited together.

function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * Normalize a title for cross-source identity matching: strips the trailing
 * venue/qualifier noise each source tacks on ("Don Broco @ Edinburgh Corn
 * Exchange" vs "Don Broco"), folds accents, collapses punctuation/whitespace.
 */
export function normalizeEventTitle(name: string | null | undefined, venueName?: string | null): string {
  let t = stripDiacritics(String(name ?? "")).toLowerCase().trim();

  t = t.replace(/\s*\/\/\s*.+$/, ""); // " // Edinburgh Queens Hall"
  t = t.replace(/\s*@\s*.+$/, ""); // " @ Queen's Hall"
  t = t.replace(/\s*\|\s*.+$/, ""); // " | ..."
  t = t.replace(/\s*\(edinburgh\)\s*$/, ""); // " (Edinburgh)"
  t = t.replace(/\s*[-–—]\s*edinburgh\s*$/, ""); // " - Edinburgh"

  if (venueName) {
    const v = stripDiacritics(String(venueName)).toLowerCase().trim();
    if (v) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp(`\\s+at\\s+(the\\s+)?${escaped}\\s*$`), ""); // " at (the) Queen's Hall"
      t = t.replace(new RegExp(`\\s*[-–—]\\s*${escaped}\\s*$`), ""); // " - Queen's Hall"
    }
  }
  // Generic " at the <venue>" trailing suffix when the row's own venue name
  // didn't catch it.
  t = t.replace(/\s+at\s+the\s+\S.*$/, "");

  return t
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const VENUE_STOPWORDS = new Set(["the", "edinburgh", "uk", "scotland"]);

/** Sentinel for "no venue info" — never treated as a match for anything. */
export const NO_VENUE_KEY = "?";

/** Coarse venue identity: "The Queen's Hall" and "Queen's Hall, Edinburgh" match. */
export function normalizeVenueKey(venueName: string | null | undefined): string {
  const folded = stripDiacritics(String(venueName ?? ""))
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!folded) return NO_VENUE_KEY;
  const key = folded
    .split(" ")
    .filter((w) => w && !VENUE_STOPWORDS.has(w))
    .join(" ");
  // A venue that is nothing but stopwords ("Edinburgh") carries no identity.
  return key || NO_VENUE_KEY;
}

/** Provider preference when two rows describe the same event. Same values as PROVIDER_PRIORITY in scripts/sources/core/dedupe.mjs. */
export const PROVIDER_PRIORITY: Record<string, number> = {
  ticketmaster: 3,
  skiddle: 3,
  songkick: 2,
  luma: 1,
  eventbrite: 1,
  sneakypetes: 1,
  allevents: 0,
};
