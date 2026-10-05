// Client-safe (no "server-only") — used by lib/db/events.ts (read path) and
// the /event/[id] client page.
//
// Junk-description detection + a factual fallback sentence for events whose
// source gave us nothing usable.
//
// KEEP IN SYNC with scripts/lib/junk-description.mjs — the ingest script has
// its own copy of the patterns below (it is plain .mjs run by node directly,
// so it cannot import this TS file). If you add a placeholder here, add it
// there too.
import type { EventItem } from "@/lib/types";
import { formatEventDate, formatEventPrice, formatEventTime } from "@/lib/events/format";

/** Whole-string placeholders (matched after lowercasing + trimming trailing punctuation). */
const JUNK_EXACT = new Set([
  "description",
  "event description",
  "event details",
  "details",
  "tbc",
  "tba",
  "tbd",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "coming soon",
  "no description",
  "no description available",
  "no description provided",
]);

const JUNK_PATTERNS: RegExp[] = [
  /^summary of (the )?event$/,
  /^more info(rmation)? (to follow|soon|tbc|tba|coming soon|to be announced)$/,
  /^lorem ipsum\b/,
  /^(event )?(description|details) (tbc|tba|tbd|to follow|coming soon|to be announced)$/,
  // A raw ISO timestamp anywhere means machine-generated filler, e.g.
  // Songkick's "Von Dodds at Leith Depot at 2026-10-05t19:30:00+0100"
  // (matched lowercased, hence the `t`). The fallback sentence says it better.
  /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/,
];

/** Min letters for a description to count as real copy. */
export const MIN_DESCRIPTION_LETTERS = 15;

function foldForCompare(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Returns `raw` (trimmed) unless it is a known source placeholder, or carries
 * too little real text, or merely repeats the event's own name — in which
 * case null. Deliberately conservative: a real short blurb such as "Free
 * entry, all welcome." passes.
 */
export function cleanEventDescription(raw: string | null | undefined, name?: string | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase().replace(/[\s.!:\-–—]+$/g, "").replace(/\s+/g, " ");
  if (JUNK_EXACT.has(lowered)) return null;
  if (JUNK_PATTERNS.some((re) => re.test(lowered))) return null;

  const letters = (trimmed.match(/\p{L}/gu) ?? []).length;
  if (letters < MIN_DESCRIPTION_LETTERS) return null;

  if (name) {
    const n = foldForCompare(name);
    if (n && foldForCompare(trimmed) === n) return null;
  }
  return trimmed;
}

// Label per lib/events/categories.ts EventCategory slug (that module is
// server-only, so the labels live here). Mirrors scripts/lib/describe.mjs.
const CATEGORY_LABEL: Record<string, string> = {
  music: "Live music",
  nightlife: "A night out",
  festival: "A festival event",
  arts: "An arts event",
  comedy: "Comedy",
  sports: "Sport",
  food: "A food & drink event",
  family: "A family event",
  other: "An event",
};

const PROVIDER_LABEL: Record<string, string> = {
  ticketmaster: "Ticketmaster",
  skiddle: "Skiddle",
  songkick: "Songkick",
  luma: "Luma",
  eventbrite: "Eventbrite",
  allevents: "AllEvents",
};

/**
 * Plain factual sentence built only from fields already on the row, for when
 * there is no usable description. Never invents anything — each clause is
 * omitted when its field is missing.
 * e.g. "Live music at Usher Hall on Fri 3 Oct at 19:30. Tickets from £22 via Ticketmaster."
 */
export function buildEventFallbackDescription(
  event: Pick<
    EventItem,
    "category" | "venue_name" | "city" | "starts_at" | "is_free" | "price_from" | "currency" | "provider" | "ticket_url"
  >
): string {
  const label = CATEGORY_LABEL[event.category ?? "other"] ?? CATEGORY_LABEL.other;
  let sentence = event.venue_name ? `${label} at ${event.venue_name}` : label;

  const date = formatEventDate(event.starts_at);
  if (date) {
    // "Fri 3 Oct" reads as "on Fri 3 Oct"; "Tonight"/"Today"/"Tomorrow" stand alone.
    sentence += /^[A-Za-z]{3} \d/.test(date) ? ` on ${date}` : ` ${date.toLowerCase()}`;
    const time = formatEventTime(event.starts_at);
    if (time) sentence += ` at ${time}`;
  }
  sentence += ".";

  const provider = PROVIDER_LABEL[event.provider];
  const via = provider && event.ticket_url ? ` via ${provider}` : "";
  if (event.is_free) {
    sentence += ` Free${via ? ` entry${via}` : ""}.`;
  } else if (event.price_from != null) {
    const price = formatEventPrice(event as Pick<EventItem, "is_free" | "price_from" | "currency">);
    sentence += ` Tickets ${price.charAt(0).toLowerCase()}${price.slice(1)}${via}.`;
  } else if (via) {
    sentence += ` Tickets${via}.`;
  }
  return sentence;
}
