/**
 * Fomo Happenings — the daily deal review's classification (pure).
 *
 * scripts/review-deals.ts reads every live deal and hands the rows to
 * `reviewDeals`; this module decides what happens to each one and does no I/O,
 * so the rules are unit-tested (deal-review.test.ts) and the script is only
 * fetch, print and write.
 *
 * Three outcomes per deal, applied in this order:
 *
 *   retire   it has ended (the offer is gone for good) -> status 'retired'
 *   dormant  nothing has confirmed it for STALE_DORMANT_DAYS -> status 'dormant'
 *   keep     everything else
 *
 * Rows that are kept can also carry FLAGS (not a genuine deal, outside
 * Edinburgh, a likely duplicate, a national chain's shallow discount). A flag never changes a row: it is a line in
 * the report for a person to look at. The only writes are retire and dormant,
 * both soft (a status change, never a DELETE), and both bounded by MAX_CHANGES
 * (`exceedsCap`) so a bug in the rules can't empty the catalogue.
 *
 * NOT `server-only`, same as the rest of lib/happenings: it is pure, and the
 * tests import it directly.
 */

import { CITY } from "@/lib/city";
import { isStale, savingBadgeLabel } from "./format";
import { isGenuineDeal } from "./groups";
import { HIGH_CONFIDENCE_JACCARD, normalizeText, titleSimilarity } from "./merge-events";
import { happeningHasEnded, localDayDate, normalizeRecurrence } from "./occurrence";
import { dealDepth, isNationalChain } from "./deal-score";
import type { Happening } from "./types";

/**
 * A live deal this old without a fresh `verified_at` has failed re-verification
 * for weeks. The daily recheck (scraper/recheck_live.py) re-confirms any row
 * not checked in 7 days that its source page still states, so staying
 * unconfirmed this long means the page is blocked, changed or gone. The app
 * already drops the "Checked" line at 14 days (STALE_AFTER_DAYS); this is the
 * point where the row stops being shown at all, until someone looks.
 */
export const STALE_DORMANT_DAYS = 30;

/**
 * The most rows one run may retire or make dormant. If a run would exceed it,
 * nothing is written and the job fails loudly instead: a day with 15+ genuine
 * expiries is far less likely than a bug (a bad date parse, an outage that left
 * every `verified_at` old).
 */
export const MAX_CHANGES = 15;

/** "New today" means created within this many hours of the run. */
export const NEW_WINDOW_HOURS = 24;

/**
 * Rough box around Edinburgh used only to FLAG a deal whose pin lands
 * elsewhere (a bad geocode, or a Glasgow venue scraped by mistake). Tighter
 * than CITY.bbox, which is padded for geocoding and the map. Rows without
 * coordinates are skipped: no coordinates is a data gap, not a wrong place.
 */
export const EDINBURGH_BBOX = { minLat: 55.85, maxLat: 56.0, minLng: -3.45, maxLng: -3.05 } as const;

/** The fields the review reads. A subset of Happening, so tests stay short. */
export type ReviewableDeal = Pick<
  Happening,
  | "id"
  | "title"
  | "venue_name"
  | "source_url"
  | "status"
  | "saving_label"
  | "saving_amount"
  | "currency"
  | "is_free"
  | "promo_code"
  | "eligibility"
  | "starts_at"
  | "ends_at"
  | "recurrence"
  | "verified_at"
  | "lat"
  | "lng"
  | "created_at"
> & { season_valid_until?: string | null };

export type DealFlag = "not_genuine" | "outside_edinburgh" | "duplicate" | "chain_shallow";

export interface DealVerdict {
  deal: ReviewableDeal;
  action: "retire" | "dormant" | "keep";
  /** Why it is retired or dormant; null for a kept row. */
  reason: string | null;
  /** Report-only notes on a kept row: flag plus a short why. */
  flags: { flag: DealFlag; detail: string }[];
  /** Created within NEW_WINDOW_HOURS of `now`. */
  isNew: boolean;
}

export interface DealReview {
  verdicts: DealVerdict[];
  retire: DealVerdict[];
  dormant: DealVerdict[];
  /** Kept rows with at least one flag. */
  flagged: DealVerdict[];
  /** Rows created in the last NEW_WINDOW_HOURS, whatever their verdict. */
  newToday: DealVerdict[];
  /** retire + dormant: what a non-dry run would write. */
  changeCount: number;
  /** True when a non-dry run must write nothing (see MAX_CHANGES). */
  overCap: boolean;
}

/** True when a run that would change `changeCount` rows is over the safety cap. */
export function exceedsCap(changeCount: number, max: number = MAX_CHANGES): boolean {
  return changeCount > max;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Why a deal has ended, or null if it hasn't.
 *
 * `happeningHasEnded` already covers a past `ends_at`, a weekly/annual
 * `recurrence.until`, a one-off whose day has gone, and a `dates` list that has
 * run out. It does NOT check `season_valid_until` (the app filters that at the
 * query layer instead), so that is the one extra check here.
 */
function endedReason(deal: ReviewableDeal, now: Date): { reason: string; action: "retire" | "dormant" } | null {
  const rec = normalizeRecurrence(deal.recurrence);

  // A row with no dates at all (a one-off with no starts_at) produces no
  // occurrences, which `happeningHasEnded` reads as "ended". It is undated, not
  // finished, and retiring it permanently on that basis would be wrong.
  const undated = rec.type === "once" && !deal.starts_at;

  if (!undated && happeningHasEnded(deal, now)) {
    return { reason: "ended: no dates left in its schedule", action: "retire" };
  }

  const today = localDayDate(now);
  if (deal.season_valid_until && deal.season_valid_until < today) {
    // An annual rule comes back next year (that is what `dormant` is for); any
    // other deal tied to a season that has finished is simply over.
    return rec.type === "annual"
      ? { reason: `season ended ${deal.season_valid_until}, recurs yearly`, action: "dormant" }
      : { reason: `season ended ${deal.season_valid_until}`, action: "retire" };
  }
  return null;
}

/** Why a deal is stale, or null if it has been confirmed recently enough. */
function staleReason(deal: ReviewableDeal, now: Date): string | null {
  if (parseMs(deal.verified_at) === null) return "never verified";
  if (isStale(deal.verified_at, now, CITY.timezone, STALE_DORMANT_DAYS)) {
    return `not verified for ${STALE_DORMANT_DAYS}+ days (last ${localDayDate(new Date(deal.verified_at))})`;
  }
  return null;
}

function outsideEdinburgh(deal: ReviewableDeal): boolean {
  if (typeof deal.lat !== "number" || typeof deal.lng !== "number") return false;
  return (
    deal.lat < EDINBURGH_BBOX.minLat ||
    deal.lat > EDINBURGH_BBOX.maxLat ||
    deal.lng < EDINBURGH_BBOX.minLng ||
    deal.lng > EDINBURGH_BBOX.maxLng
  );
}

/**
 * Pairs of kept deals that look like the same offer listed twice: the same
 * venue (normalised) AND either the same saving badge or a near-identical title.
 * Returns id -> the title of the first deal it matches, so each side of a pair
 * is flagged. Venue-less rows are skipped: with no venue, "same venue" means
 * nothing.
 */
function findDuplicates(deals: readonly ReviewableDeal[]): Map<string, string> {
  const byVenue = new Map<string, ReviewableDeal[]>();
  for (const d of deals) {
    const venue = d.venue_name ? normalizeText(d.venue_name) : "";
    if (!venue) continue;
    const group = byVenue.get(venue);
    if (group) group.push(d);
    else byVenue.set(venue, [d]);
  }

  const dupes = new Map<string, string>();
  for (const group of byVenue.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const badgeA = savingBadgeLabel(a);
        const sameBadge = badgeA !== null && badgeA === savingBadgeLabel(b);
        const sameTitle =
          normalizeText(a.title) === normalizeText(b.title) || titleSimilarity(a.title, b.title) >= HIGH_CONFIDENCE_JACCARD;
        if (!sameBadge && !sameTitle) continue;
        if (!dupes.has(a.id)) dupes.set(a.id, b.title);
        if (!dupes.has(b.id)) dupes.set(b.id, a.title);
      }
    }
  }
  return dupes;
}

/**
 * Classify every deal. Only `status: 'live'` rows are considered: a dormant or
 * retired row is someone's earlier decision and is never touched or reported.
 */
export function reviewDeals(deals: readonly ReviewableDeal[], now: Date): DealReview {
  const live = deals.filter((d) => d.status === "live");
  const newSince = now.getTime() - NEW_WINDOW_HOURS * 3_600_000;

  const verdicts: DealVerdict[] = live.map((deal) => {
    const created = parseMs(deal.created_at);
    const isNew = created !== null && created >= newSince && created <= now.getTime();
    const ended = endedReason(deal, now);
    if (ended) return { deal, action: ended.action, reason: ended.reason, flags: [], isNew };
    const stale = staleReason(deal, now);
    if (stale) return { deal, action: "dormant", reason: stale, flags: [], isNew };
    return { deal, action: "keep", reason: null, flags: [], isNew };
  });

  // Flags only matter for rows that stay visible, and duplicates are judged
  // among those alone (a duplicate of a row we're retiring is no longer one).
  const kept = verdicts.filter((v) => v.action === "keep");
  const dupes = findDuplicates(kept.map((v) => v.deal));
  for (const v of kept) {
    if (!isGenuineDeal(v.deal)) {
      v.flags.push({ flag: "not_genuine", detail: "no discount, code or restricted-audience saving" });
    }
    if (outsideEdinburgh(v.deal)) {
      v.flags.push({ flag: "outside_edinburgh", detail: `${v.deal.lat}, ${v.deal.lng}` });
    }
    const twin = dupes.get(v.deal.id);
    if (twin) v.flags.push({ flag: "duplicate", detail: `looks like "${twin}"` });
    // A chain's 10%-off is the "I already know this" deal: same in every
    // city, barely a saving. Ranking already sinks it; this asks whether to keep it.
    if (isNationalChain(v.deal) && dealDepth(v.deal) <= 10) {
      v.flags.push({ flag: "chain_shallow", detail: `national chain, ~${dealDepth(v.deal)}% off` });
    }
  }

  const retire = verdicts.filter((v) => v.action === "retire");
  const dormant = verdicts.filter((v) => v.action === "dormant");
  const changeCount = retire.length + dormant.length;
  return {
    verdicts,
    retire,
    dormant,
    flagged: kept.filter((v) => v.flags.length > 0),
    newToday: verdicts.filter((v) => v.isNew),
    changeCount,
    overCap: exceedsCap(changeCount),
  };
}
