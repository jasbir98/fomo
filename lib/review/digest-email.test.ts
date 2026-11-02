// Run with `npx tsx --test lib/review/digest-email.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDigestEmail } from "./digest-email";
import { verifyReviewToken, signReviewToken } from "./token";
import type { StagedDeal } from "./digest";

const SECRET = "test-secret-0123456789-abcdef";
const NOW = Date.UTC(2026, 10, 2, 9, 0, 0);
const sign = (id: string, action: "approve" | "reject") => signReviewToken({ id, action, secret: SECRET, now: NOW });

const deal = (over: Partial<StagedDeal> = {}): StagedDeal => ({
  id: "3f2a8c1e-5b7d-4e90-a1c2-0d9e8f7a6b5c",
  title: "£4 cask pints",
  venue_name: "Nobles",
  saving_label: "£4 pints",
  quality_score: 68,
  quality_reasons: ["cheap price for a pint", "local venue", "stated weekdays only"],
  source_url: "https://nobles.test/offers",
  ...over,
});

const base = { waitingTotal: 14, expiredCount: 2, baseUrl: "https://askfomo.com/", sign };

test("one card per deal with title, venue, saving, score, reasons, source and both links", () => {
  const e = renderDigestEmail({ ...base, items: [deal(), deal({ id: "11111111-2222-4333-8444-555555555555", title: "Second" })] });
  assert.match(e.subject, /2 today, 14 waiting/);
  for (const part of ["£4 cask pints", "Nobles", "£4 pints", "Score 68", "cheap price for a pint", "https://nobles.test/offers", "Approve", "Reject"]) {
    assert.ok(e.html.includes(part), `html missing ${part}`);
  }
  assert.ok(e.text.includes("Score: 68") && e.text.includes("Approve: https://askfomo.com/review/"));
  assert.equal((e.html.match(/>Approve</g) ?? []).length, 2);
});

test("header says how many are waiting in total and how many expired today", () => {
  const e = renderDigestEmail({ ...base, items: [deal()] });
  assert.match(e.text, /^14 deals are waiting for review\./);
  assert.match(e.text, /2 expired today/);
  assert.match(renderDigestEmail({ ...base, expiredCount: 0, items: [deal()] }).text, /0 expired today/);
});

test("the links carry valid, distinct approve and reject tokens for that deal", () => {
  const e = renderDigestEmail({ ...base, items: [deal()] });
  const links = [...e.text.matchAll(/(Approve|Reject): (https:\/\/askfomo\.com\/review\/(\S+))/g)];
  assert.equal(links.length, 2);
  const [approve, reject] = links.map((m) => verifyReviewToken(m[3], { secret: SECRET, now: NOW }));
  assert.ok(approve.ok && reject.ok);
  assert.equal(approve.ok && approve.action, "approve");
  assert.equal(reject.ok && reject.action, "reject");
  assert.equal(approve.ok && approve.id, deal().id);
});

test("html is escaped", () => {
  const e = renderDigestEmail({ ...base, items: [deal({ title: `<script>alert("x")</script> & co`, quality_reasons: ["<b>bold</b>"] })] });
  assert.ok(!e.html.includes("<script>"));
  assert.ok(!e.html.includes("<b>bold</b>"));
  assert.ok(e.html.includes("&lt;script&gt;"));
});

test("a javascript: source is not rendered as a link", () => {
  const e = renderDigestEmail({ ...base, items: [deal({ source_url: "javascript:alert(1)", booking_url: null })] });
  assert.ok(!e.html.includes("javascript:"));
  assert.ok(!e.text.includes("javascript:"));
});

test("shows a stored evidence quote and the unconfirmed flag for social sources; neither otherwise", () => {
  const plain = renderDigestEmail({ ...base, items: [deal()] });
  assert.ok(!plain.html.includes("Unconfirmed"));
  assert.ok(!plain.html.includes("&ldquo;"));
  const social = renderDigestEmail({
    ...base,
    items: [deal({ source_url: "https://www.instagram.com/p/x/", evidence_quote: "Half price burgers on Tuesdays" })],
  });
  assert.ok(social.html.includes("Unconfirmed"));
  assert.ok(social.text.includes("UNCONFIRMED"));
  assert.ok(social.html.includes("Half price burgers on Tuesdays"));
});

test("brand case: Fomo in text, lowercase wordmark, never FOMO", () => {
  const e = renderDigestEmail({ ...base, items: [deal()] });
  assert.ok(!/FOMO/.test(e.html + e.text + e.subject));
  assert.ok(e.html.includes(">fomo<"));
});

test("says when only some of the waiting deals are shown", () => {
  assert.match(renderDigestEmail({ ...base, items: [deal()] }).text, /Showing the best 1\./);
  assert.ok(!renderDigestEmail({ ...base, waitingTotal: 1, items: [deal()] }).text.includes("Showing the best"));
});
