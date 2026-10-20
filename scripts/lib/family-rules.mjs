/**
 * Pure family_fit rules for the one-off backfill (scripts/tag-family.mjs).
 * No network, no DB. Events use classifyFamilyFit from the daily-import
 * normalizer directly; this module holds the place and happening rules.
 *
 *   'kids'     aimed at children
 *   'all_ages' good with kids but for anyone (free museums, parks, gardens)
 *   null       not for kids / unknown — rules never return a "no" they can't
 *              justify, they just leave the row untagged.
 */

import { classifyFamilyFit } from "../sources/core/normalize.mjs";

// Places: categories where a family can plausibly turn up with young children.
export const PLACE_ALL_AGES_RE =
  /museum|gallery|park|garden|beach|zoo|wildlife|farm|library|leisure centre|leisure center|swim|country park|castle|nature reserve|visitor centre|visitor center|science/i;

// Never tagged, whatever else matches (checked on category AND name): licensed
// premises, hotels, burial grounds, places of worship, and care/clinical
// settings where "children's" or "park" in a name is not a family outing.
export const PLACE_EXCLUDE_RE =
  /\b(?:pubs?|bars?|nightclubs?|night clubs?|distiller(?:y|ies)|breweries|brewery|hotels?|cemeter(?:y|ies)|churchyards?|kirkyards?|church(?:es)?|cathedrals?|chapels?|crematorium|casinos?|hospitals?|hospices?|clinics?|dental|nurser(?:y|ies)|schools?|colleges?|universit(?:y|ies)|car parks?|parking|caravan parks?|business parks?|retail parks?|golf|studios?)\b/i;

// Public galleries a family would visit (the rest of the "gallery" category is
// artist studios and commercial galleries).
export const PUBLIC_GALLERY_RE = /\bnational\b|scottish national|city art centre|fruitmarket|talbot rice|dovecot|stills|collective|modern (?:one|two)|portrait|royal scottish academy|queen's gallery|king's gallery/i;

// Places that are explicitly for children, by name.
export const PLACE_KIDS_NAME_RE = /soft ?play|play ?park|playground|children['’]?s|\bkids?\b|\bkids['’]/i;

/** { value: 'kids'|'all_ages'|null, reason: string|null } for a place. */
export function placeFamilyFit({ name, category } = {}) {
  const n = String(name ?? "");
  const c = String(category ?? "");
  if (PLACE_EXCLUDE_RE.test(c) || PLACE_EXCLUDE_RE.test(n)) return { value: null, reason: null };
  if (PLACE_KIDS_NAME_RE.test(n)) return { value: "kids", reason: `name: ${n.match(PLACE_KIDS_NAME_RE)[0]}` };
  // "gallery" also covers artist studios and commercial galleries: only the
  // public galleries count.
  if (/gallery/i.test(c) && !PUBLIC_GALLERY_RE.test(n)) return { value: null, reason: null };
  if (PLACE_ALL_AGES_RE.test(c)) return { value: "all_ages", reason: `category: ${c}` };
  return { value: null, reason: null };
}

// A concession for a specific adult group (students, residents, over-60s, Young
// Scot cardholders) is not "for kids" even when the venue's category is family.
// Such rows are left undecided for the keyword/AI pass.
const HAPPENING_ADULT_GROUP_RE = /\bstudents?\b|\bresidents?\b|\bconcessions?\b|\bover[- ]?(?:60|65)s?\b|\bseniors?\b|\bpensioners?\b|\byoung scot\b|\bnec\b/i;

/** Structured happening rule: category or eligibility is already 'family'. */
export function happeningRuleFit({ category, eligibility, title, summary } = {}) {
  if (category !== "family" && eligibility !== "family") return { value: null, reason: null };
  if (HAPPENING_ADULT_GROUP_RE.test(`${title ?? ""} ${summary ?? ""}`)) return { value: null, reason: null };
  return { value: "kids", reason: category === "family" ? "rule: category=family" : "rule: eligibility=family" };
}

/** Keyword pass on title + summary via the same classifier the daily import uses. */
export function happeningKeywordFit({ title, summary, category, venue_name } = {}) {
  // category 'family' was already handled (or deliberately skipped) by happeningRuleFit; don't let it decide here.
  const value = classifyFamilyFit({ name: title, description: summary, category: category === "family" ? null : category, venueName: venue_name });
  return value ? { value, reason: "keyword" } : { value: null, reason: null };
}

/** All rule-based checks in order; first decision wins. */
export function happeningRulesFit(row) {
  const rule = happeningRuleFit(row);
  if (rule.value) return rule;
  return happeningKeywordFit(row);
}
