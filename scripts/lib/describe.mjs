/**
 * describe.mjs — shared event-description cleaning + fallback helpers.
 *
 * Used by scripts/daily-sources.mjs both at adapter-mapping time (every
 * source's raw description candidate is run through cleanDescription before
 * it lands in the upsert row) and by the description-backfill phase (same
 * cleaner applied to whatever JSON-LD/og:description/meta-description text
 * a fetched event page yields).
 *
 * No dependency on the rest of daily-sources.mjs — kept import-free (no
 * `@/` alias, no supabase-js) so it can be shared by a future
 * scripts/backfill-descriptions.mjs without dragging in the ingest script's
 * adapters.
 */

import { isJunkDescription } from "./junk-description.mjs";

// Max length of a cleaned description, matching the "1-2 lines" brief.
export const MAX_DESCRIPTION_LENGTH = 220;
// Below this, a candidate is "too short to be worth keeping" rather than
// "empty" — matches the measurement threshold used to size this work.
export const MIN_USEFUL_LENGTH = 15;

// --- HTML entity decoding ----------------------------------------------------

// Small, dependency-free decoder covering the entities that actually show up
// in event copy (named + numeric). Not a full HTML5 entity table — this is
// event blurbs, not arbitrary web content.
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  copy: "©",
  reg: "®",
  trade: "™",
  amp_: "&",
};

export function decodeHtmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

// --- stripping ----------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/\S+/gi;
// Common emoji ranges + variation selectors/ZWJ — strip rather than try to
// preserve, event descriptions read fine without them and some sources pad
// listings with emoji spam ("🎉🎉🎉 BUY NOW 🎉🎉🎉").
const EMOJI_RE =
  /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️‍]/gu;

function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ");
}

function stripUrls(s) {
  return s.replace(URL_RE, " ");
}

function stripEmoji(s) {
  return s.replace(EMOJI_RE, "");
}

function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

// --- boilerplate rejection ------------------------------------------------

// Whole-candidate rejections: if the ENTIRE cleaned string matches one of
// these, there's nothing worth keeping (not just a sentence within a longer
// blurb — see SENTENCE_BOILERPLATE_RE below for that case).
const WHOLE_BOILERPLATE_RE = [
  /^(buy|get|find)\s+tickets?\b.*$/i,
  /^tickets?\s+(on sale|available)\b.*$/i,
  /^doors\s+open\.?$/i,
  /^this\s+event\s+is\b.*$/i,
  /^(sold\s*out|cancelled|postponed)\.?$/i,
  // Ticketmaster promoter.description is a bare company-registration string
  // like "KMJ ENTERTAINMENT LTD / NTL / GBR" — three slash-separated
  // segments, last one a short uppercase country/region code.
  /^[^/]+\/\s*[a-z0-9. ]+\/\s*[a-z]{2,4}$/i,
];

// Sentence-level rejections: dropped from a multi-sentence candidate (e.g.
// Ticketmaster's `info`/`pleaseNote`, which mixes real doors/start times
// with age-policy and ticket-limit legal text) without discarding the whole
// thing.
const SENTENCE_BOILERPLATE_RE = [
  /^(buy|get|find)\s+tickets?\b/i,
  /^tickets?\s+(on sale|available)\b/i,
  /^doors\s+open$/i,
  /over\s+\d+s?\s+only\b/i,
  /^\d+\+/, // bare age gate, e.g. "14+", possibly followed by a parenthetical
  /\bmust\s+be\s+accompanied\b/i, // covers "under 16s must be..." and "14-17 year olds must be..." alike
  /\bid\s+to\s+purchase\b/i,
  /\b(photo\s*)?id\s+(is\s+)?required\b/i,
  /\bvalid\s+id\b/i,
  /\bage\s+restrictions?\b/i,
  /max(imum)?\s+of\s+\d+\s+tickets?\b/i,
  /\byour\s+ticket\s+is\s+a\s+personal.*licen[cs]e\b/i,
  /\bticket(s)?\s+in\s+excess\s+of\s+\d+\b/i,
  /\bthis\s+event\s+is\s+(sold\s*out|cancelled|postponed)\b/i,
  /\bwe\s+use\s+cookies\b/i,
  /\bcookie\s+policy\b/i,
  /^no\s+refunds?\b/i,
  /^strictly\s+no\b/i,
  /^ticket\s+restrictions?\b/i,
  /^\d+\.\s*$/, // bare numbered-list markers left over once their own sentence's boilerplate is dropped
];

function isWholeBoilerplate(s) {
  return WHOLE_BOILERPLATE_RE.some((re) => re.test(s.trim()));
}

// Split into rough "sentences" on sentence-ending punctuation, and also on
// newlines (Ticketmaster's info/pleaseNote fields are not always properly
// punctuated between clauses like "Doors 18:30 Start 19:30 Curfew 23:00
// Ticket Restrictions 1. ...").
// Section headers Ticketmaster's `info`/`pleaseNote` fields run straight
// into the useful text with no sentence break ("Doors 18:30 Start 19:30
// Curfew 23:00 Ticket Restrictions 1. Your ticket is a personal..."), so
// sentence-level filtering alone leaves the header behind. Cut the whole
// string at the first occurrence of one of these — everything from there on
// is legal/logistics boilerplate, never event-descriptive content.
const BOILERPLATE_SECTION_HEADERS_RE =
  /\b(ticket restrictions?|age restrictions?|security\s*--|bag policy|please note:|terms and conditions|by purchasing a ticket)\b/i;

function truncateAtBoilerplateHeader(s) {
  const m = s.match(BOILERPLATE_SECTION_HEADERS_RE);
  if (!m) return s;
  return s.slice(0, m.index);
}

function splitSentences(s) {
  return s
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Drops sentences matching known legal/promo boilerplate from a multi-
 * sentence candidate, keeping the rest in order. Returns null if nothing
 * survives.
 */
function dropBoilerplateSentences(s) {
  const kept = splitSentences(s).filter(
    (sentence) => !SENTENCE_BOILERPLATE_RE.some((re) => re.test(sentence))
  );
  if (kept.length === 0) return null;
  return kept.join(" ");
}

// --- "just repeats the title/venue" rejection -----------------------------

function normalizeForComparison(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True if `candidate` adds nothing beyond restating the event's own name/venue. */
function isJustTitleOrVenue(candidate, title, venueName) {
  const c = normalizeForComparison(candidate);
  if (!c) return true;
  const t = title ? normalizeForComparison(title) : "";
  const v = venueName ? normalizeForComparison(venueName) : "";
  if (t && c === t) return true;
  if (t && v && c === `${t} ${v}`) return true;
  if (t && v && c === `${t} at ${v}`) return true;
  return false;
}

// --- trimming ---------------------------------------------------------------

/** Trim to MAX_DESCRIPTION_LENGTH, cutting on a sentence boundary when one falls in range, else a word boundary + "…". */
function trimToLength(s, maxLength = MAX_DESCRIPTION_LENGTH) {
  if (s.length <= maxLength) return s;

  const sentences = splitSentences(s);
  let acc = "";
  for (const sentence of sentences) {
    const next = acc ? `${acc} ${sentence}` : sentence;
    if (next.length > maxLength) break;
    acc = next;
  }
  if (acc.length >= MIN_USEFUL_LENGTH) return acc;

  // No sentence boundary fit (e.g. one long run-on sentence) — cut on a word
  // boundary instead.
  const truncated = s.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > MIN_USEFUL_LENGTH ? truncated.slice(0, lastSpace) : truncated;
  return `${cut.trim()}…`;
}

/**
 * Clean a raw description candidate from any source (JSON-LD `description`,
 * Skiddle `description`, Ticketmaster `info`/`pleaseNote`/`description`/
 * `promoter.description`, RSS `<description>`, a scraped page's
 * og:description/meta description, ...) into upsert-ready text, or null if
 * nothing usable survives.
 *
 * `title`/`venueName` are used only to reject a candidate that just repeats
 * the event's own name/venue with nothing added.
 */
export function cleanDescription(raw, { title, venueName } = {}) {
  if (typeof raw !== "string") return null;

  let s = raw;
  s = decodeHtmlEntities(s);
  s = stripTags(s);
  s = stripUrls(s);
  s = stripEmoji(s);
  s = collapseWhitespace(s);
  if (!s) return null;

  s = collapseWhitespace(truncateAtBoilerplateHeader(s));
  if (!s) return null;

  if (isWholeBoilerplate(s)) return null;

  const withoutBoilerplateSentences = dropBoilerplateSentences(s);
  if (!withoutBoilerplateSentences) return null;
  s = collapseWhitespace(withoutBoilerplateSentences);

  if (s.length < MIN_USEFUL_LENGTH) return null;
  // Source placeholders ("summary of the event", "TBC", ...) count as empty
  // so the row falls through to the backfill-from-own-page step.
  if (isJunkDescription(s, title)) return null;
  if (isJustTitleOrVenue(s, title, venueName)) return null;

  return trimToLength(s);
}

// --- last-resort factual fallback -------------------------------------------

// Human-readable label for each lib/events/categories.ts EventCategory slug
// (music | nightlife | festival | arts | comedy | sports | food | family |
// other) — used only to phrase the fallback sentence, never to invent a
// category (the row's own `category`, already assigned by the adapter's own
// mapping + classifyCategory keyword fallback, is what's passed in).
const CATEGORY_LABEL = {
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

const LONDON_TIME_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * Build a factual one-liner from fields already held on the row — used only
 * when every real description candidate (source-provided, then the fetched-
 * page fallback) came back empty. Never invents facts: only assembles a
 * category label, venue, time and price that are already present on the
 * row, omitting whichever of those are missing. Returns null only if there
 * is truly nothing to say (no venue AND no price AND no known time — i.e.
 * category alone), which then still returns the bare category label rather
 * than null, since "Live music" beats an empty description.
 */
export function fallbackDescription(row) {
  const label = CATEGORY_LABEL[row.category] ?? CATEGORY_LABEL.other;
  const parts = [label];

  if (row.venue_name) parts[0] = `${label} at ${row.venue_name}`;

  const extras = [];
  const startsAt = row.starts_at ? new Date(row.starts_at) : null;
  const looksLikeRealTime = startsAt && !isMidnightUtcSentinel(row.starts_at);
  if (looksLikeRealTime) {
    extras.push(`starts ${LONDON_TIME_FMT.format(startsAt)}`);
  }
  if (row.is_free === true) {
    extras.push("free");
  } else if (typeof row.price_from === "number" && row.price_from > 0) {
    const currency = row.currency === "GBP" || !row.currency ? "£" : `${row.currency} `;
    extras.push(`from ${currency}${row.price_from}`);
  }

  return extras.length > 0 ? `${parts[0]} · ${extras.join(" · ")}` : parts[0];
}

// A `starts_at` that lands exactly on UTC midnight is (see daily-sources.mjs
// isoFromJsonLd) how a date-only source value ("2026-10-09" with no time
// component) gets stored — real UK events essentially never start at the
// literal top of the UTC hour with zero minutes/seconds, so this is a safe
// heuristic for "we don't actually know the time" without a schema change.
export function isMidnightUtcSentinel(isoString) {
  if (typeof isoString !== "string") return false;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

// --- page-fallback extraction (og:description / meta description) ---------

/** Pulls `<meta property="og:description" content="...">` (or `name=` variant), else `<meta name="description" content="...">`. */
export function extractMetaDescription(html) {
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:description["'][^>]*>/i);
  if (ogMatch && ogMatch[1]) return ogMatch[1];

  const metaMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  if (metaMatch && metaMatch[1]) return metaMatch[1];

  return null;
}
