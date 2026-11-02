// Run with `npx tsx --test lib/review/token.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_SECRET_LENGTH, TOKEN_TTL_SECONDS, signReviewToken, verifyReviewToken } from "./token";

const SECRET = "test-secret-0123456789-abcdef";
const OTHER_SECRET = "another-secret-9876543210-zyxw";
const ID = "3f2a8c1e-5b7d-4e90-a1c2-0d9e8f7a6b5c";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);

const swapPayload = (token: string, edit: (payload: string) => string) => {
  const [p, sig] = token.split(".");
  const payload = Buffer.from(p, "base64url").toString("utf8");
  return `${Buffer.from(edit(payload), "utf8").toString("base64url")}.${sig}`;
};

test("a freshly signed token verifies and returns its id, action and expiry", () => {
  const token = signReviewToken({ id: ID, action: "approve", secret: SECRET, now: NOW });
  const v = verifyReviewToken(token, { secret: SECRET, now: NOW + 1000 });
  assert.deepEqual(v, { ok: true, id: ID, action: "approve", expiresAt: Math.floor(NOW / 1000) + TOKEN_TTL_SECONDS });
});

test("approve and reject tokens for one row are different and do not substitute for each other", () => {
  const a = signReviewToken({ id: ID, action: "approve", secret: SECRET, now: NOW });
  const r = signReviewToken({ id: ID, action: "reject", secret: SECRET, now: NOW });
  assert.notEqual(a, r);
  const va = verifyReviewToken(a, { secret: SECRET, now: NOW });
  const vr = verifyReviewToken(r, { secret: SECRET, now: NOW });
  assert.ok(va.ok && vr.ok);
  assert.equal(va.ok && va.action, "approve");
  assert.equal(vr.ok && vr.action, "reject");
});

test("a token is url-safe (base64url, one dot)", () => {
  const token = signReviewToken({ id: ID, action: "reject", secret: SECRET, now: NOW });
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("an edited id is refused", () => {
  const token = signReviewToken({ id: ID, action: "approve", secret: SECRET, now: NOW });
  const edited = swapPayload(token, (p) => p.replace(ID, OTHER_ID));
  assert.deepEqual(verifyReviewToken(edited, { secret: SECRET, now: NOW }), { ok: false, reason: "bad-signature" });
});

test("an edited action is refused (reject token cannot be turned into approve)", () => {
  const token = signReviewToken({ id: ID, action: "reject", secret: SECRET, now: NOW });
  const edited = swapPayload(token, (p) => p.replace(".reject.", ".approve."));
  assert.deepEqual(verifyReviewToken(edited, { secret: SECRET, now: NOW }), { ok: false, reason: "bad-signature" });
});

test("an edited expiry is refused (cannot extend a link)", () => {
  const token = signReviewToken({ id: ID, action: "approve", secret: SECRET, now: NOW });
  const edited = swapPayload(token, (p) => {
    const parts = p.split(".");
    parts[3] = String(Number(parts[3]) + 10 * 24 * 3600);
    return parts.join(".");
  });
  assert.deepEqual(verifyReviewToken(edited, { secret: SECRET, now: NOW }), { ok: false, reason: "bad-signature" });
});

test("a truncated or altered signature is refused", () => {
  const token = signReviewToken({ id: ID, action: "approve", secret: SECRET, now: NOW });
  const [p, sig] = token.split(".");
  assert.equal(verifyReviewToken(`${p}.${sig.slice(0, -2)}`, { secret: SECRET, now: NOW }).ok, false);
  assert.equal(verifyReviewToken(`${p}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, { secret: SECRET, now: NOW }).ok, false);
});

test("the wrong secret is refused", () => {
  const token = signReviewToken({ id: ID, action: "approve", secret: SECRET, now: NOW });
  assert.deepEqual(verifyReviewToken(token, { secret: OTHER_SECRET, now: NOW }), { ok: false, reason: "bad-signature" });
});

test("an expired token is refused, and the last second before expiry still works", () => {
  const token = signReviewToken({ id: ID, action: "approve", secret: SECRET, now: NOW });
  const expiry = NOW + TOKEN_TTL_SECONDS * 1000;
  assert.equal(verifyReviewToken(token, { secret: SECRET, now: expiry - 1000 }).ok, true);
  assert.deepEqual(verifyReviewToken(token, { secret: SECRET, now: expiry }), { ok: false, reason: "expired" });
  assert.deepEqual(verifyReviewToken(token, { secret: SECRET, now: expiry + 86400_000 }), { ok: false, reason: "expired" });
});

test("expiry is seven days", () => {
  assert.equal(TOKEN_TTL_SECONDS, 7 * 24 * 60 * 60);
});

test("garbage is refused as malformed", () => {
  for (const bad of ["", "garbage", "a.b.c", ".", "abc.", ".abc", undefined, null, 42, "x".repeat(500)]) {
    const v = verifyReviewToken(bad, { secret: SECRET, now: NOW });
    assert.equal(v.ok, false, String(bad));
  }
});

test("missing or short secret fails closed: signing throws, verifying refuses a once-valid token", () => {
  const saved = process.env.REVIEW_SIGNING_SECRET;
  try {
    delete process.env.REVIEW_SIGNING_SECRET;
    assert.throws(() => signReviewToken({ id: ID, action: "approve", now: NOW }), /REVIEW_SIGNING_SECRET/);
    assert.throws(() => signReviewToken({ id: ID, action: "approve", secret: "x".repeat(MIN_SECRET_LENGTH - 1), now: NOW }));
    const token = signReviewToken({ id: ID, action: "approve", secret: SECRET, now: NOW });
    assert.deepEqual(verifyReviewToken(token, { now: NOW }), { ok: false, reason: "no-secret" });
    assert.deepEqual(verifyReviewToken(token, { secret: "", now: NOW }), { ok: false, reason: "no-secret" });
    // Reads the env var when no secret is passed.
    process.env.REVIEW_SIGNING_SECRET = SECRET;
    assert.equal(verifyReviewToken(token, { now: NOW }).ok, true);
  } finally {
    if (saved === undefined) delete process.env.REVIEW_SIGNING_SECRET;
    else process.env.REVIEW_SIGNING_SECRET = saved;
  }
});

test("signing refuses an id that is not a uuid or an unknown action", () => {
  assert.throws(() => signReviewToken({ id: "1; drop table", action: "approve", secret: SECRET }));
  // @ts-expect-error deliberately invalid
  assert.throws(() => signReviewToken({ id: ID, action: "delete", secret: SECRET }));
});
