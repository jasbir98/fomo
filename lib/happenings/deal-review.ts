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
 *   dormant  nothing has confirmed it for STALE_DORMANT_DAYS, or it is outside
 *            Edinburgh (see `locate`) -> status 'dormant' (hidden, reversible)
 *   keep     everything else
 *
 * Rows that are kept can also carry FLAGS (not a genuine deal, a likely
 * duplicate, a national chain's shallow discount). A flag never changes a row:
 * it is a line in the report for a person to look at. The only writes are
 * retire and dormant,
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
 * A UK postcode's outward code (the part before the space), e.g. "EH21" from
 * "EH21 7AB". A postcode is the most exact place an address states, so it is
 * the first signal `locate` tries. The inward half is required so a stray
 * "A1" in an address isn't read as a postcode.
 */
export const POSTCODE_OUTWARD_RE = /\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d[A-Z]{2}\b/i;

/**
 * EH districts that count as Edinburgh. EH1 to EH17 are the city and EH28 to
 * EH30 its western edge (Kirkliston, Ratho, South Queensferry), inside the City
 * of Edinburgh council area. EH91, EH95 and EH99 are non-geographic codes, so
 * they are not a place outside the city either. Everything else (EH18 to EH27,
 * EH31 and up) is another council's area: Musselburgh (EH21), Dalkeith (EH22)
 * and Penicuik (EH26) are in Midlothian and East Lothian.
 */
export const EDINBURGH_EH_DISTRICTS: ReadonlySet<number> = new Set([
  ...Array.from({ length: 17 }, (_, i) => i + 1),
  28,
  29,
  30,
  91,
  95,
  99,
]);

/**
 * Towns outside the city, matched as whole words in a deal's venue or title.
 * This catches a deal with no postcode, where the pin can't be trusted to say
 * where it is ("Lido Musselburgh", a Glasgow bar). Leith, Portobello, Cramond
 * and South Queensferry are deliberately absent: they are inside Edinburgh, and
 * a name like "The Lioness of Leith" must not make a deal outside.
 */
export const OUTSIDE_TOWNS = [
  "Musselburgh",
  "Dalkeith",
  "Bonnyrigg",
  "Loanhead",
  "Lasswade",
  "Penicuik",
  "Livingston",
  "Linlithgow",
  "Bathgate",
  "Broxburn",
  "Haddington",
  "North Berwick",
  "Dunbar",
  "Prestonpans",
  "Tranent",
  "Gorebridge",
  "Glasgow",
  "Stirling",
  "Dunfermline",
  "Kirkcaldy",
  "Peebles",
  "Innerleithen",
  "Inverness",
  "Fort William",
] as const;
const OUTSIDE_TOWN_RE = new RegExp(`\\b(${OUTSIDE_TOWNS.join("|")})\\b`, "i");

/**
 * Rough box around Edinburgh: the last signal `locate` tries, for a row with no
 * postcode and no town name in its text. A pin outside it (a bad geocode, or a
 * Glasgow venue scraped by mistake) makes the row dormant. Tighter than
 * CITY.bbox, which is padded for geocoding and the map.
 */
export const EDINBURGH_BBOX = { minLat: 55.85, maxLat: 56.0, minLng: -3.45, maxLng: -3.05 } as const;

/** The fields the review reads. A subset of Happening, so tests stay short. */
export type ReviewableDeal = Pick<
  Happening,
  | "id"
  | "title"
  | "venue_name"
  | "address"
  | "scope"
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

export type DealFlag = "not_genuine" | "duplicate" | "chain_shallow";

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

/** Whether an outward code such as "EH21" or "G1" is in Edinburgh. */
function isEdinburghOutward(outward: string): boolean {
  const m = /^EH(\d{1,2})[A-Z]?$/.exec(outward);
  return m !== null && EDINBURGH_EH_DISTRICTS.has(Number(m[1]));
}

/**
 * Where a deal is, decided by the first signal that answers: its address
 * postcode, then a town name in its venue or title, then its pin. Returns null
 * when none does. No data is a gap, not a wrong place, so the caller keeps the
 * deal.
 */
export function locate(deal: ReviewableDeal): { inside: boolean; why: string } | null {
  const pc = deal.address ? POSTCODE_OUTWARD_RE.exec(deal.address) : null;
  if (pc) {
    const outward = pc[1].toUpperCase();
    return { inside: isEdinburghOutward(outward), why: `${outward} postcode` };
  }

  for (const text of [deal.venue_name, deal.title]) {
    const town = text ? OUTSIDE_TOWN_RE.exec(text) : null;
    if (town) {
      const name = OUTSIDE_TOWNS.find((t) => t.toLowerCase() === town[1].toLowerCase()) ?? town[1];
      return { inside: false, why: name };
    }
  }

  if (typeof deal.lat === "number" && typeof deal.lng === "number") {
    const inside =
      deal.lat >= EDINBURGH_BBOX.minLat &&
      deal.lat <= EDINBURGH_BBOX.maxLat &&
      deal.lng >= EDINBURGH_BBOX.minLng &&
      deal.lng <= EDINBURGH_BBOX.maxLng;
    return { inside, why: `pin ${deal.lat}, ${deal.lng}` };
  }
  return null;
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
    // A UK-wide offer (scope "national", e.g. a railcard) is valid in Edinburgh
    // wherever its head office is, so where it is listed doesn't matter.
    const place = deal.scope === "national" ? null : locate(deal);
    if (place && !place.inside) {
      return { deal, action: "dormant", reason: `outside Edinburgh: ${place.why}`, flags: [], isNew };
    }
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
