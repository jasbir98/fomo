#!/usr/bin/env -S npx tsx
/**
 * scripts/deal-digest.ts — the daily deal digest: up to 10 waiting deals,
 * best score first, in one phone-friendly email with one-tap Approve / Reject
 * (app/review/[token]). Runs in the daily deals workflow after the daily run.
 *
 *   npx tsx --env-file=.env.local scripts/deal-digest.ts            # dry run: reads, prints, writes nothing
 *   npx tsx --env-file=.env.local scripts/deal-digest.ts --send     # expire, email, mark sent
 *
 * Options: --base-url <origin>      links point here (default the site, lib/seo/site.ts)
 *          --max-age-days <n>       expire after n days unreviewed (default 14)
 *
 * FIRST RUN. There is a backlog of waiting rows from the 19 and 26 Oct runs (and any older). With the
 * default 14 days, the first `--send` would expire every digest-routed row staged before about
 * 19 Oct in one go, including good ones nobody has seen. Do the first `--send` with
 * `--max-age-days 30`, and go back to the default after that. A dry run (no --send) lists exactly
 * what would expire, so read it first.
 *
 * Only rows whose source page was checked (scraper/page_check.py leaves "page check: ok" in
 * quality_reasons) are emailed; the dry run says how many were held back. At most 3 per category.
 *
 * What it does (rules in lib/review/digest.ts, all unit-tested):
 *   1. Reads happenings_staging rows routed 'digest' that nobody has decided.
 *   2. EXPIRES (--send only) rows staged more than 14 days ago: extraction_status
 *      'rejected', reviewed_action 'expired', with a reason, so a pile-up can't form.
 *   3. Picks the best 10 by quality_score, one row per slug (past batches stage the same deal
 *      again: the newest batch's row wins). A slug already live in `happenings`, or with any
 *      row already reviewed, approved or promoted, is skipped. A row already emailed comes back
 *      only if still unreviewed and last sent more than 3 days ago (counting every copy of the slug).
 *   4. Emails them through Resend to REVIEW_DIGEST_TO, and ONLY then sets digest_sent_at.
 *      A failed send writes nothing, so the same rows are tried again next run.
 *   5. Sends nothing when there are no items.
 *
 * ENV. Always: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * For --send: RESEND_API_KEY, REVIEW_DIGEST_TO (one address; never hard-coded),
 * REVIEW_SIGNING_SECRET (signs the links; the site needs the same value),
 * FOMO_FROM_EMAIL. A dry run needs none of them and prints placeholder links.
 *
 * Needs supabase/add_deal_quality.sql and supabase/add_deal_review.sql applied;
 * until then it stops with a message naming the missing column.
 *
 * DB ACCESS. Plain `fetch` against PostgREST with the service-role key, not
 * @supabase/supabase-js, for the reason given in scripts/finds.ts.
 */
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renderDigestEmail } from "@/lib/review/digest-email";
import {
  DIGEST_COLUMNS,
  EXPIRED_ACTION,
  EXPIRED_STATUS,
  EXPIRE_AFTER_DAYS,
  MAX_DIGEST_ITEMS,
  expiredReason,
  planDigest,
  type StagedDeal,
} from "@/lib/review/digest";
import { MIN_SECRET_LENGTH, signReviewToken } from "@/lib/review/token";
import { SITE_URL } from "@/lib/seo/site";

const { values: args } = parseArgs({
  options: {
    send: { type: "boolean", default: false },
    "base-url": { type: "string" },
    "max-age-days": { type: "string" },
  },
});
const SEND = args.send === true;
const BASE_URL = (args["base-url"] ?? SITE_URL).replace(/\/+$/, "");
const MAX_AGE_DAYS = args["max-age-days"] ? Number(args["max-age-days"]) : EXPIRE_AFTER_DAYS;

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const DIGEST_TO = (process.env.REVIEW_DIGEST_TO ?? "").trim();
const SIGNING_SECRET = process.env.REVIEW_SIGNING_SECRET ?? "";
// A bare address shows its local part as the sender name in inboxes (same rule as scripts/fomo-friday.mjs).
const RAW_FROM = (process.env.FOMO_FROM_EMAIL ?? "").trim();
const FROM = RAW_FROM && !RAW_FROM.includes("<") ? `Fomo <${RAW_FROM}>` : RAW_FROM;

function fail(message: string): never {
  console.error(`[deal-digest] ${message}`);
  process.exit(1);
}

if (!Number.isFinite(MAX_AGE_DAYS) || MAX_AGE_DAYS < 1) fail(`--max-age-days must be a number of days, got "${args["max-age-days"]}"`);
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  fail("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run with: npx tsx --env-file=.env.local scripts/deal-digest.ts");
}
if (SEND) {
  const missing: string[] = [];
  if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!DIGEST_TO) missing.push("REVIEW_DIGEST_TO");
  if (SIGNING_SECRET.length < MIN_SECRET_LENGTH) missing.push(`REVIEW_SIGNING_SECRET (at least ${MIN_SECRET_LENGTH} characters)`);
  if (!FROM) missing.push("FOMO_FROM_EMAIL");
  if (missing.length > 0) fail(`--send refused: missing env var(s): ${missing.join(", ")}. Nothing was changed.`);
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(DIGEST_TO)) fail("REVIEW_DIGEST_TO must be exactly one email address. Nothing was changed.");
}

// --- Supabase REST ---------------------------------------------------------

async function rest<T = unknown>(method: "GET" | "PATCH", path: string, body?: unknown, prefer?: string): Promise<T> {
  const headers: Record<string, string> = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  let res: Response;
  // sb_secret_ keys: the gateway mints a short-lived JWT per request and clock
  // skew occasionally rejects it (PGRST303). Transient: retry before failing.
  for (let attempt = 1; ; attempt++) {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status !== 401 || attempt === 4) break;
    if (!(await res.clone().text()).includes("PGRST303")) break;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : []) as T;
}

const WAITING_QUERY =
  `happenings_staging?select=${DIGEST_COLUMNS}` +
  "&quality_route=eq.digest&happening_id=is.null&reviewed_at=is.null" +
  "&or=(approved.is.null,approved.eq.false)" +
  "&or=(extraction_status.is.null,extraction_status.not.in.(promoted,approved,rejected))" +
  "&order=id.asc";

const fetchWaiting = () => fetchAll<StagedDeal>(WAITING_QUERY);

/** GET every row of a small projection, paged past PostgREST's 1000-row cap. `path` must carry a stable `order`. */
async function fetchAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rest<T[]>("GET", `${path}&limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/** Slugs of live rows in `happenings`: a deal already on Fomo is never asked about again. */
async function fetchLiveSlugs(): Promise<Set<string>> {
  const rows = await fetchAll<{ slug: string | null }>("happenings?select=slug&status=eq.live&order=slug.asc");
  return new Set(rows.map((r) => r.slug).filter((s): s is string => !!s));
}

/** Slugs with ANY staging row (any batch) already reviewed, approved or promoted. */
async function fetchDecidedSlugs(): Promise<Set<string>> {
  const rows = await fetchAll<{ slug: string | null }>(
    "happenings_staging?select=slug" +
      "&or=(reviewed_at.not.is.null,approved.eq.true,extraction_status.in.(promoted,approved),happening_id.not.is.null)" +
      "&order=id.asc"
  );
  return new Set(rows.map((r) => r.slug).filter((s): s is string => !!s));
}

function explainMissingColumn(err: unknown): string | null {
  const m = String(err instanceof Error ? err.message : err).match(/column (?:happenings_staging\.)?(\w+) does not exist/);
  if (!m) return null;
  const file = ["quality_score", "quality_reasons", "quality_route", "evidence_quote"].includes(m[1]) ? "supabase/add_deal_quality.sql" : "supabase/add_deal_review.sql";
  return `happenings_staging.${m[1]} does not exist yet. Run ${file} in the Supabase SQL editor (see the header of supabase/add_deal_review.sql for the order), then try again. Nothing was changed.`;
}

// --- writes ----------------------------------------------------------------

const idList = (rows: StagedDeal[]) => rows.map((r) => r.id).join(",");

/** Marks rows expired. Conditional on still being unreviewed, so a decision made a second ago wins. Returns how many were written. */
async function expireRows(rows: StagedDeal[], now: Date): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const done = await rest<{ id: string }[]>(
      "PATCH",
      `happenings_staging?id=in.(${idList(batch)})&reviewed_at=is.null&happening_id=is.null&select=id`,
      {
        extraction_status: EXPIRED_STATUS,
        rejected_reason: expiredReason(MAX_AGE_DAYS),
        reviewed_at: now.toISOString(),
        reviewed_action: EXPIRED_ACTION,
        updated_at: now.toISOString(),
      },
      "return=representation"
    );
    written += done.length;
  }
  return written;
}

async function markSent(rows: StagedDeal[], now: Date): Promise<void> {
  await rest("PATCH", `happenings_staging?id=in.(${idList(rows)})`, { digest_sent_at: now.toISOString() }, "return=minimal");
}

async function sendEmail(email: { subject: string; html: string; text: string }): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [DIGEST_TO], subject: email.subject, html: email.html, text: email.text }),
  });
  if (!res.ok) throw new Error(`Resend send -> ${res.status}: ${await res.text()}`);
}

// --- main ------------------------------------------------------------------

async function main() {
  const now = new Date();
  let waiting: StagedDeal[];
  let liveSlugs: Set<string>;
  let decidedSlugs: Set<string>;
  try {
    waiting = await fetchWaiting();
    liveSlugs = await fetchLiveSlugs();
    decidedSlugs = await fetchDecidedSlugs();
  } catch (err) {
    const hint = explainMissingColumn(err);
    if (hint) fail(hint);
    throw err;
  }

  const plan = planDigest(waiting, now.getTime(), { maxAgeDays: MAX_AGE_DAYS, liveSlugs, decidedSlugs });
  const mode = SEND ? "SEND" : "DRY RUN";
  console.log(
    `[deal-digest] ${mode}: ${waiting.length} waiting row(s) read; ${plan.expire.length} to expire (staged over ${MAX_AGE_DAYS} days ago); ` +
      `${plan.waitingTotal} distinct deal(s) still waiting; ${plan.items.length} for the email (max ${MAX_DIGEST_ITEMS}); ` +
      `${plan.unchecked} held back because their source page was not checked.`
  );
  for (const r of plan.expire) console.log(`  expire  ${r.id}  ${r.title}  (score ${r.quality_score ?? "n/a"}, staged ${r.created_at ?? "?"})`);
  for (const r of plan.items) console.log(`  email   ${r.id}  score ${r.quality_score ?? "n/a"}  ${r.title}${r.digest_sent_at ? "  (sent before)" : ""}`);

  // 1. Expire first, so the header count and the waiting total are the real ones.
  let expiredCount = plan.expire.length;
  if (SEND && plan.expire.length > 0) {
    expiredCount = await expireRows(plan.expire, now);
    console.log(`[deal-digest] expired ${expiredCount} row(s).`);
  }

  // 2. Nothing to send: stop (expiry above still stands).
  if (plan.items.length === 0) {
    console.log("[deal-digest] 0 items for the digest: no email.");
    summary(mode, plan.items.length, plan.waitingTotal, expiredCount, "no email (nothing to send)");
    return;
  }

  // A dry run never signs: the printed links would be live credentials in the terminal or the CI log.
  const sign = SEND
    ? (id: string, action: "approve" | "reject") => signReviewToken({ id, action, secret: SIGNING_SECRET, now: now.getTime() })
    : (_id: string, action: "approve" | "reject") => `dry-run-placeholder-${action}`;
  const email = renderDigestEmail({ items: plan.items, waitingTotal: plan.waitingTotal, expiredCount, maxAgeDays: MAX_AGE_DAYS, baseUrl: BASE_URL, sign });

  if (!SEND) {
    console.log(`\n[deal-digest] would send to the address in REVIEW_DIGEST_TO (${DIGEST_TO ? "set" : "NOT SET"}; --send needs it):\nSubject: ${email.subject}\n\n${email.text}\n`);
    console.log("[deal-digest] dry run: nothing was written and no email was sent. Re-run with --send.");
    summary(mode, plan.items.length, plan.waitingTotal, expiredCount, "dry run, nothing sent");
    return;
  }

  // 3. Send, then (only then) mark the rows as sent.
  await sendEmail(email);
  console.log(`[deal-digest] sent ${plan.items.length} deal(s) to the review address.`);
  try {
    await markSent(plan.items, now);
  } catch (err) {
    fail(`email SENT but digest_sent_at could not be saved (${err instanceof Error ? err.message : err}). The same deals may be emailed again on the next run.`);
  }
  summary(mode, plan.items.length, plan.waitingTotal, expiredCount, "sent");
}

function summary(mode: string, items: number, waitingTotal: number, expired: number, outcome: string) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `### Deal digest (${mode})\n\n${items} in the email, ${waitingTotal} waiting in total, ${expired} expired today. Result: ${outcome}.\n`);
}

main().catch((err) => {
  console.error("[deal-digest] FAILED:", err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
