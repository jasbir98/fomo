/**
 * Signed review links for the daily deal digest (scripts/deal-digest.ts ->
 * app/review/[token]).
 *
 * A token says "whoever holds this may approve (or reject) staging row <id>
 * until <expiry>". It carries no deal data and no account: the digest email
 * goes to one address (REVIEW_DIGEST_TO) and the link itself is the credential.
 *
 *   token   = base64url(payload) "." base64url(HMAC-SHA256(secret, payload))
 *   payload = "fomo-review-v1." <staging id> "." <approve|reject> "." <expiry, unix seconds>
 *
 * Pure apart from reading REVIEW_SIGNING_SECRET when no secret is passed in.
 * Deliberately NOT `server-only`: the digest script signs tokens under plain
 * Node. The secret never reaches a client bundle, since nothing client-side
 * imports this file.
 *
 * Fails closed: a missing or short secret makes signing throw and verifying
 * refuse everything, so a misconfigured deploy cannot approve anything.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const REVIEW_ACTIONS = ["approve", "reject"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** Links stop working 7 days after the digest signs them. */
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A secret shorter than this is treated as not set. `openssl rand -base64 32` gives 44. */
export const MIN_SECRET_LENGTH = 16;

const VERSION = "fomo-review-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type VerifyResult =
  | { ok: true; id: string; action: ReviewAction; expiresAt: number }
  | { ok: false; reason: "no-secret" | "malformed" | "bad-signature" | "expired" };

export function isReviewAction(value: unknown): value is ReviewAction {
  return value === "approve" || value === "reject";
}

function usableSecret(secret: string | undefined): string | null {
  const s = secret ?? process.env.REVIEW_SIGNING_SECRET ?? "";
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

const b64 = (buf: Buffer) => buf.toString("base64url");

export type SignInput = {
  /** happenings_staging.id (uuid). */
  id: string;
  action: ReviewAction;
  /** Defaults to REVIEW_SIGNING_SECRET. */
  secret?: string;
  /** Epoch milliseconds; defaults to now. */
  now?: number;
  ttlSeconds?: number;
};

export function signReviewToken({ id, action, secret, now = Date.now(), ttlSeconds = TOKEN_TTL_SECONDS }: SignInput): string {
  const key = usableSecret(secret);
  if (!key) throw new Error(`REVIEW_SIGNING_SECRET is not set (or shorter than ${MIN_SECRET_LENGTH} characters)`);
  if (!UUID_RE.test(id)) throw new Error("review token id must be a uuid");
  if (!isReviewAction(action)) throw new Error("review token action must be approve or reject");
  const expiresAt = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${VERSION}.${id.toLowerCase()}.${action}.${expiresAt}`;
  return `${b64(Buffer.from(payload, "utf8"))}.${b64(mac(key, payload))}`;
}

export function verifyReviewToken(token: unknown, opts: { secret?: string; now?: number } = {}): VerifyResult {
  const key = usableSecret(opts.secret);
  if (!key) return { ok: false, reason: "no-secret" };
  if (typeof token !== "string" || token.length === 0 || token.length > 400) return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };

  const payload = Buffer.from(parts[0], "base64url").toString("utf8");
  const given = Buffer.from(parts[1], "base64url");
  const expected = mac(key, payload);
  // timingSafeEqual throws on unequal lengths, so compare lengths first (a length is not secret).
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-signature" };

  // Signature holds, so the payload is ours; still parse it strictly.
  const fields = payload.split(".");
  if (fields.length !== 4 || fields[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, id, action, exp] = fields;
  if (!UUID_RE.test(id) || !isReviewAction(action) || !/^\d{1,12}$/.test(exp)) return { ok: false, reason: "malformed" };

  const expiresAt = Number(exp);
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  if (nowSeconds >= expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, id, action, expiresAt };
}
