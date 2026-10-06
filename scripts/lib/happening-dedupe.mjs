/**
 * happening-dedupe.mjs — pure duplicate detection for live `happenings`, used
 * by scripts/dedupe-happenings.mjs. The same offer lands twice when two
 * research batches phrase it differently ("Traverse Theatre £1 Tickets" /
 * "Traverse £1 Tickets for Under-25s"), and the Deals feed then shows it twice.
 *
 * Two rows are duplicates only when ALL of these hold:
 *   - same `kind`
 *   - same `eligibility` (or either is null)
 *   - same price: a shared £ figure across `saving_amount`, the `saving_label`
 *     and the title, or both free. Rows with no price on either side never
 *     match — "20% off" vs "20% off" at two chains proves nothing.
 *   - same venue identity: equal normalised `venue_name`, or (when either row
 *     has no venue_name, or the names are prefix-related) the same brand —
 *     the title's leading words up to the first offer word ("Scottish Opera"
 *     in "Scottish Opera Under 26 Tickets"). Two rows with clearly different
 *     venue_names are never duplicates, whatever the titles say.
 *
 * Capital Theatres "25 & Under £10" vs "Under 26 Advance £15" differ on price,
 * so they are correctly left alone.
 *
 * No I/O, no `@/` alias — runs under plain `node --test`.
 */

import { nameKey, nameTokens } from "./place-match.mjs";

// First title word that ends the venue/brand part of a deal title.
const OFFER_WORDS = new Set([
  "tickets", "ticket", "under", "young", "free", "student", "students", "off", "discount", "discounted",
  "member", "members", "membership", "half", "price", "entry", "admission", "concession", "concessions",
  "advance", "special", "offer", "deal", "day", "pass", "for", "from", "with", "save", "get", "2for1",
  // Audience prefixes ("EH Residents 20% off at …", "Locals …"): the venue
  // comes after them, so they are never a brand.
  "eh", "resident", "residents", "local", "locals",
]);

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/** Leading words of a title before the first offer word / number / £, as a name key; "" when none. */
export function brandKey(title) {
  if (typeof title !== "string") return "";
  const words = title.trim().split(/\s+/);
  const brand = [];
  for (const word of words) {
    const bare = word.toLowerCase().replace(/[^a-z0-9£%]/g, "");
    if (!bare || /^[£\d]/.test(bare) || bare.endsWith("%") || OFFER_WORDS.has(bare)) break;
    brand.push(word);
  }
  return nameKey(brand.join(" "));
}

function poundFigures(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(/£\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

/** Every £ figure a row states, plus its saving_amount; [0] for a free row. A
 *  percentage deal's saving_amount is the percent ("20% off" -> 20), not a
 *  price, so it is skipped: otherwise "25% off food" and a "£25 brunch" at the
 *  same venue would read as the same offer. */
export function priceFigures(row) {
  const figures = new Set();
  if (row.is_free) figures.add(0);
  const percentLabel = typeof row.saving_label === "string" && row.saving_label.includes("%") && !row.saving_label.includes("£");
  if (!percentLabel && row.saving_amount != null && row.saving_amount !== "" && Number.isFinite(Number(row.saving_amount))) {
    figures.add(Number(row.saving_amount));
  }
  for (const n of poundFigures(row.saving_label)) figures.add(n);
  for (const n of poundFigures(row.title)) figures.add(n);
  return figures;
}

function samePrice(a, b) {
  const pa = priceFigures(a);
  const pb = priceFigures(b);
  for (const n of pa) if (pb.has(n)) return true;
  return false;
}

function sameEligibility(a, b) {
  return !a.eligibility || !b.eligibility || a.eligibility === b.eligibility;
}

function isTokenPrefix(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length > 0 && shorter.every((t, i) => longer[i] === t);
}

function sameVenueIdentity(a, b) {
  const va = nameKey(a.venue_name);
  const vb = nameKey(b.venue_name);
  const ba = brandKey(a.title);
  const bb = brandKey(b.title);

  if (va && vb) {
    if (va === vb) return true;
    // "Traverse" vs "Traverse Theatre": prefix-related names are one venue.
    return isTokenPrefix(nameTokens(va), nameTokens(vb));
  }
  // At least one row has no venue_name: fall back to the title's brand.
  if (!ba || !bb) return false;
  if (ba === bb) return true;
  return isTokenPrefix(nameTokens(ba), nameTokens(bb));
}

/** True when two live rows describe the same offer at the same venue. */
export function areDuplicates(a, b) {
  if (!a || !b || a.id === b.id) return false;
  if (a.kind !== b.kind) return false;
  if (!sameEligibility(a, b)) return false;
  if (!samePrice(a, b)) return false;
  return sameVenueIdentity(a, b);
}

function time(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Compare two rows for "which one to keep": negative when `a` is the better
 * row. Order: has an image or place link > higher confidence > newer
 * verified_at > longer summary > slug (so the result is deterministic).
 * Returns { order, reason } where reason names the deciding criterion.
 */
export function compareKeep(a, b) {
  const linked = (r) => (r.image_url || r.place_id ? 1 : 0);
  if (linked(a) !== linked(b)) return { order: linked(b) - linked(a), reason: "has an image / place link" };

  const ca = CONFIDENCE_RANK[a.confidence] ?? 0;
  const cb = CONFIDENCE_RANK[b.confidence] ?? 0;
  if (ca !== cb) return { order: cb - ca, reason: "higher confidence" };

  if (time(a.verified_at) !== time(b.verified_at)) return { order: time(b.verified_at) - time(a.verified_at), reason: "newer verified_at" };

  const sa = (a.summary ?? "").length;
  const sb = (b.summary ?? "").length;
  if (sa !== sb) return { order: sb - sa, reason: "longer summary" };

  return { order: String(a.slug ?? "").localeCompare(String(b.slug ?? "")), reason: "slug order (no other difference)" };
}

/**
 * Group duplicate rows (transitively) and pick a survivor per group.
 * Returns [{ keep, drops: [{ row, reason }] }] for groups of 2+.
 */
export function findDuplicateGroups(rows) {
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (areDuplicates(rows[i], rows[j])) parent[find(j)] = find(i);
    }
  }

  const clusters = new Map();
  rows.forEach((row, i) => {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), row]);
  });

  const groups = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => compareKeep(a, b).order);
    const keep = sorted[0];
    groups.push({
      keep,
      drops: sorted.slice(1).map((row) => ({ row, reason: compareKeep(keep, row).reason })),
    });
  }
  return groups;
}
