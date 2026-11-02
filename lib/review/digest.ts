/**
 * Which staged deals go in today's digest email, and which have waited too
 * long. Pure: scripts/deal-digest.ts reads the rows and writes the results,
 * this file only decides. Rules (docs: plan "Phase 2"):
 *
 *   waiting  quality_route = 'digest', not approved, not promoted, no
 *            happening_id, not reviewed (reviewed_at null), not rejected.
 *   expires  waiting and staged (created_at) more than 14 days ago: the script
 *            marks it reviewed-expired so a pile-up can't form.
 *   sent     best score first, at most 10. A row already sent comes back only
 *            if still unreviewed and last sent more than 3 days ago.
 *   skipped  a deal whose own dates have passed is never emailed (it is left
 *            to expire like any other).
 *   one per slug  past batches stage the same deal again under the same slug. The
 *            plan keeps the newest row (created_at, then batch_id) per slug, and skips
 *            a slug that is already live in `happenings` or that has any row already
 *            decided (reviewed, approved or promoted), so a deal is never asked about
 *            twice and an old duplicate cannot reach a digest.
 */

export const MAX_DIGEST_ITEMS = 10;
export const RESEND_AFTER_DAYS = 3;
export const EXPIRE_AFTER_DAYS = 14;

/** What the digest reads from happenings_staging (the script selects `*`; only these are used). */
export type StagedDeal = {
  id: string;
  slug?: string | null;
  batch_id?: string | null;
  title: string;
  summary?: string | null;
  time_note?: string | null;
  venue_name?: string | null;
  saving_label?: string | null;
  price_text?: string | null;
  source_name?: string | null;
  source_url?: string | null;
  booking_url?: string | null;
  /** The verbatim page quote behind the deal (happenings_staging.evidence_quote). Null on rows staged before it existed. */
  evidence_quote?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  season_valid_until?: string | null;
  created_at?: string | null;
  extraction_status?: string | null;
  approved?: boolean | null;
  happening_id?: string | null;
  quality_score?: number | null;
  quality_reasons?: unknown;
  quality_route?: string | null;
  digest_sent_at?: string | null;
  reviewed_at?: string | null;
  reviewed_action?: string | null;
  rejected_reason?: string | null;
};

/**
 * The columns the digest selects. Named, not `*`, so a column that has not been
 * added to the database yet fails the query clearly instead of reading as absent.
 */
export const DIGEST_COLUMNS = [
  "id", "slug", "batch_id", "title", "summary", "time_note", "venue_name", "saving_label", "price_text",
  "source_name", "source_url", "booking_url", "evidence_quote", "starts_at", "ends_at", "season_valid_until",
  "created_at", "extraction_status", "approved", "happening_id", "quality_score", "quality_reasons",
  "quality_route", "digest_sent_at", "reviewed_at", "reviewed_action", "rejected_reason",
].join(",");

const DAY_MS = 24 * 60 * 60 * 1000;

/** The status written onto an expired row. 'rejected' is already in the table's CHECK list, so no new value is needed. */
export const EXPIRED_STATUS = "rejected";
export const EXPIRED_ACTION = "expired";
/** reviewed_action on an older duplicate closed because its slug was decided on another row. */
export const SUPERSEDED_ACTION = "superseded";
export const SUPERSEDED_REASON = "superseded: another row with the same slug was reviewed";

export function expiredReason(days: number = EXPIRE_AFTER_DAYS): string {
  return `expired: not reviewed within ${days} days`;
}

const timeOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** True while the row still needs a person's decision and may be emailed. */
export function isWaiting(row: StagedDeal): boolean {
  if (row.quality_route !== "digest") return false;
  if (row.approved === true) return false;
  if (row.happening_id) return false;
  if (row.reviewed_at) return false;
  const status = row.extraction_status ?? "";
  return status !== "promoted" && status !== "approved" && status !== "rejected";
}

/** Waiting and staged more than `maxAgeDays` ago. A row with no usable created_at never expires (fail safe). */
export function isStale(row: StagedDeal, now: number, maxAgeDays: number = EXPIRE_AFTER_DAYS): boolean {
  const created = timeOf(row.created_at);
  return created !== null && now - created > maxAgeDays * DAY_MS;
}

/** The deal's own dates are over: ends_at in the past, or season_valid_until before today (UTC date). */
export function isOver(row: StagedDeal, now: number): boolean {
  const ends = timeOf(row.ends_at);
  if (ends !== null && ends < now) return true;
  const season = row.season_valid_until ? Date.parse(`${row.season_valid_until.slice(0, 10)}T23:59:59Z`) : NaN;
  return !Number.isNaN(season) && season < now;
}

/** Never sent, or last sent more than `RESEND_AFTER_DAYS` ago. */
export function isDueForSend(row: StagedDeal, now: number): boolean {
  return sentLongAgo(timeOf(row.digest_sent_at), now);
}

const sentLongAgo = (sent: number | null, now: number) => sent === null || now - sent > RESEND_AFTER_DAYS * DAY_MS;

const scoreOf = (row: StagedDeal) => (typeof row.quality_score === "number" ? row.quality_score : -1);

/** Newest batch first: created_at, then batch_id, then id (so the choice is stable). */
function newestFirst(a: StagedDeal, b: StagedDeal): number {
  return (
    (timeOf(b.created_at) ?? 0) - (timeOf(a.created_at) ?? 0) ||
    (b.batch_id ?? "").localeCompare(a.batch_id ?? "") ||
    b.id.localeCompare(a.id)
  );
}

export type DigestPlan = {
  /** Rows to mark expired (the script only writes them under --send). */
  expire: StagedDeal[];
  /** Rows to put in the email, best score first. */
  items: StagedDeal[];
  /** Distinct deals still waiting after expiry and de-duplication, whether or not they fit in this email. */
  waitingTotal: number;
};

export function planDigest(
  rows: StagedDeal[],
  now: number,
  opts: {
    maxItems?: number;
    maxAgeDays?: number;
    /** Slugs of live rows in `happenings`: never asked about again. */
    liveSlugs?: ReadonlySet<string>;
    /** Slugs with any row (any batch) already reviewed, approved or promoted. */
    decidedSlugs?: ReadonlySet<string>;
  } = {}
): DigestPlan {
  const maxItems = opts.maxItems ?? MAX_DIGEST_ITEMS;
  const maxAgeDays = opts.maxAgeDays ?? EXPIRE_AFTER_DAYS;

  const waiting = rows.filter(isWaiting);
  const expire = waiting.filter((r) => isStale(r, now, maxAgeDays));
  const expireIds = new Set(expire.map((r) => r.id));

  // Not expired, and not a slug that is already live or already decided on another row.
  const candidates = waiting
    .filter((r) => !expireIds.has(r.id))
    .filter((r) => !r.slug || !(opts.liveSlugs?.has(r.slug) || opts.decidedSlugs?.has(r.slug)))
    .sort(newestFirst);

  // One row per slug: the newest. `lastSent` is the latest send across all of a slug's rows, so a
  // fresh batch's copy of a deal emailed yesterday does not come straight back.
  const newest = new Map<string, StagedDeal>();
  const lastSent = new Map<string, number>();
  for (const r of candidates) {
    const key = r.slug ? `slug:${r.slug}` : `id:${r.id}`;
    if (!newest.has(key)) newest.set(key, r);
    const sent = timeOf(r.digest_sent_at);
    if (sent !== null) lastSent.set(key, Math.max(lastSent.get(key) ?? 0, sent));
  }

  const unique = [...newest.entries()];
  const items = unique
    .filter(([key, r]) => !isOver(r, now) && sentLongAgo(lastSent.get(key) ?? null, now))
    .map(([, r]) => r)
    // Best score first; on a tie the older row first (nearer its expiry), then id so the order is stable.
    .sort((a, b) => scoreOf(b) - scoreOf(a) || (timeOf(a.created_at) ?? 0) - (timeOf(b.created_at) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, maxItems);

  return { expire, items, waitingTotal: unique.length };
}

// --- what the email says about one deal -----------------------------------------------------

/** Up to `n` of the stored reasons, as plain strings. quality_reasons is a jsonb array of short strings. */
export function topReasons(row: StagedDeal, n = 3): string[] {
  const reasons = row.quality_reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((r) => (typeof r === "string" ? r : r && typeof r === "object" && typeof (r as { text?: unknown }).text === "string" ? (r as { text: string }).text : ""))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, n);
}

/**
 * The verbatim page quote behind the deal: happenings_staging.evidence_quote,
 * null on rows staged before that column existed (the card then simply has no
 * quote line).
 */
export function evidenceQuote(row: StagedDeal): string | null {
  const q = typeof row.evidence_quote === "string" ? row.evidence_quote.trim() : "";
  return q ? q.slice(0, 400) : null;
}

const SOCIAL_HOST = /(^|\.)(instagram\.com|facebook\.com|fb\.com|fb\.me|tiktok\.com|threads\.net|threads\.com|twitter\.com|x\.com|t\.co)$/i;
const SOCIAL_OR_NEWSLETTER_NAME = /\b(instagram|facebook|tiktok|newsletter)\b|^via /i;

/**
 * True where the deal came from social media or a newsletter, which the
 * venue's own page has not confirmed. No such rows exist yet (phase 3/4 of the plan).
 */
export function isUnconfirmedSource(row: StagedDeal): boolean {
  if (row.source_name && SOCIAL_OR_NEWSLETTER_NAME.test(row.source_name)) return true;
  if (!row.source_url) return false;
  try {
    return SOCIAL_HOST.test(new URL(row.source_url).hostname);
  } catch {
    return false;
  }
}

/** http(s) URLs only: anything else (javascript:, data:) is never rendered as a link. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
