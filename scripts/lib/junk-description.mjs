/**
 * junk-description.mjs — detects source placeholder descriptions
 * ("summary of the event", "TBC", ...) so ingest treats them as empty.
 *
 * KEEP IN SYNC with cleanEventDescription() in lib/events/description.ts —
 * the read path in the app uses that TS copy (this script is plain .mjs run
 * by node and cannot import it). Any pattern added to one belongs in both.
 */

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

const JUNK_PATTERNS = [
  /^summary of (the )?event$/,
  /^more info(rmation)? (to follow|soon|tbc|tba|coming soon|to be announced)$/,
  /^lorem ipsum\b/,
  /^(event )?(description|details) (tbc|tba|tbd|to follow|coming soon|to be announced)$/,
  // A raw ISO timestamp anywhere means machine-generated filler, e.g.
  // Songkick's "Von Dodds at Leith Depot at 2026-10-05t19:30:00+0100"
  // (matched lowercased, hence the `t`). The fallback sentence says it better.
  /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/,
];

export const MIN_DESCRIPTION_LETTERS = 15;

function foldForCompare(s) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True if `raw` is empty, a known placeholder, has too few letters, or just repeats `name`. */
export function isJunkDescription(raw, name) {
  if (typeof raw !== "string") return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;

  const lowered = trimmed.toLowerCase().replace(/[\s.!:\-–—]+$/g, "").replace(/\s+/g, " ");
  if (JUNK_EXACT.has(lowered)) return true;
  if (JUNK_PATTERNS.some((re) => re.test(lowered))) return true;

  const letters = (trimmed.match(/\p{L}/gu) ?? []).length;
  if (letters < MIN_DESCRIPTION_LETTERS) return true;

  if (name) {
    const n = foldForCompare(name);
    if (n && foldForCompare(trimmed) === n) return true;
  }
  return false;
}
