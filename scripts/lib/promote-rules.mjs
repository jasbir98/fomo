/**
 * Pure rules for promote-happenings.mjs (unit-tested in promote-rules.test.mjs).
 *
 * Promoting a staging row onto an EXISTING slug must not clobber text that the
 * enrichment pass (scripts/apply-happening-enrichment.mjs) grounded in a page
 * quote: the staging value is the model's paraphrase, the stored one has
 * evidence. `enrich_sources` on the happenings row is { field: { url, quote } }.
 */

import { FIELDS } from "./extraction-gate.mjs";

/** Text fields the enrichment pass can ground (the extraction gate's FIELDS). */
export const ENRICHABLE_FIELDS = FIELDS;

/** True when `enrichSources[field]` carries evidence (a non-empty object or string). */
function hasEvidence(entry) {
  if (!entry) return false;
  if (typeof entry === "string") return entry.trim().length > 0;
  if (typeof entry === "object") return Object.values(entry).some((v) => typeof v === "string" && v.trim().length > 0);
  return false;
}

/**
 * Remove from `row` (the payload about to be upserted) every field the stored
 * row already holds with evidence, and an image the stored row already has.
 * Mutates and returns `row`. `existing` is null for a brand-new slug.
 *
 * Returns { row, kept } where `kept` lists the dropped field names, for logging.
 */
export function protectExistingFields(row, existing) {
  const kept = [];
  if (!existing) return { row, kept };
  const evidence = existing.enrich_sources && typeof existing.enrich_sources === "object" ? existing.enrich_sources : {};
  for (const field of ENRICHABLE_FIELDS) {
    if (field in row && hasEvidence(evidence[field])) {
      delete row[field];
      kept.push(field);
    }
  }
  // A stored image (curated or already fetched) is never replaced by the
  // staging row's thinner source image.
  if (row.image_url && typeof existing.image_url === "string" && existing.image_url.trim()) {
    delete row.image_url;
    kept.push("image_url");
  }
  return { row, kept };
}

/** Split a list into chunks of `size` (for `slug=in.(...)` lookups). */
export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** PostgREST `in.(...)` value list with each item double-quoted (slugs are kebab-case, but never trust that). */
export function inList(values) {
  return `(${values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`;
}
