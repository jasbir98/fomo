/**
 * Resend webhook signature verification (server-only, no dependency — Node
 * `crypto` only). Resend signs its webhooks the Svix way:
 * https://docs.svix.com/receiving/verifying-payloads/how-manual
 *
 *   signed_content = "<svix-id>.<svix-timestamp>.<raw request body>"
 *   secret_bytes   = base64_decode(secret with its "whsec_" prefix stripped)
 *   expected_sig   = base64(HMAC-SHA256(secret_bytes, signed_content))
 *
 * `svix-signature` can carry more than one space-separated "v1,<base64>"
 * candidate (Svix sends multiple during a secret rotation) — a match on
 * ANY of them is a valid signature. Every byte comparison goes through
 * `timingSafeEqual` so a near-miss can't leak how close it was.
 *
 * Pure function, no I/O — this is what makes it directly unit-testable
 * with plain `node --test` or a standalone script (see the "Test the
 * signature code" note in the task this was built for), and it's the
 * single source of truth app/api/resend/webhook/route.ts calls.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyResendWebhookResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_secret" | "missing_headers" | "bad_secret" | "bad_timestamp" | "stale_timestamp" | "bad_signature";
    };

export interface VerifyResendWebhookParams {
  /** `svix-id` request header. */
  id: string | null;
  /** `svix-timestamp` request header — Unix seconds as a string. */
  timestamp: string | null;
  /** `svix-signature` request header — one or more space-separated "v1,<base64>" values. */
  signature: string | null;
  /** The exact, unparsed request body bytes (as a string) — signing is over the raw body, not a re-serialized JSON.parse/stringify round-trip. */
  rawBody: string;
  /** `RESEND_WEBHOOK_SECRET`, "whsec_..." — undefined/empty is reported as `missing_secret`, not thrown. */
  secret: string | undefined;
  /** How old (or how far in the future) a timestamp may be before it's rejected as a possible replay. Defaults to 300 (5 minutes), matching Svix's own default tolerance. */
  maxAgeSeconds?: number;
}

const DEFAULT_MAX_AGE_SECONDS = 5 * 60;
const WHSEC_PREFIX = "whsec_";

function decodeSecret(secret: string): Buffer | null {
  if (!secret.startsWith(WHSEC_PREFIX)) return null;
  const b64 = secret.slice(WHSEC_PREFIX.length);
  if (!b64) return null;
  try {
    const decoded = Buffer.from(b64, "base64");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

export function verifyResendWebhookSignature(params: VerifyResendWebhookParams): VerifyResendWebhookResult {
  const { id, timestamp, signature, rawBody, secret, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS } = params;

  if (!secret) return { ok: false, reason: "missing_secret" };
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const secretBytes = decodeSecret(secret);
  if (!secretBytes) return { ok: false, reason: "bad_secret" };

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: "bad_timestamp" };
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: "stale_timestamp" };

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(signedContent, "utf8").digest();

  const candidates = signature.split(" ").map((s) => s.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const commaIdx = candidate.indexOf(",");
    if (commaIdx === -1) continue;
    const version = candidate.slice(0, commaIdx);
    const sigB64 = candidate.slice(commaIdx + 1);
    if (version !== "v1" || !sigB64) continue;

    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(sigB64, "base64");
    } catch {
      continue;
    }
    // timingSafeEqual throws on length mismatch rather than returning
    // false — check first so a wrong-length candidate can't throw past
    // the loop (and so the length check itself doesn't leak anything
    // useful: it's public info that lengths differ, not a signature bit).
    if (sigBuf.length !== expected.length) continue;
    if (timingSafeEqual(sigBuf, expected)) return { ok: true };
  }

  return { ok: false, reason: "bad_signature" };
}
