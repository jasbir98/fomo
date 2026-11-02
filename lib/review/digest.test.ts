// Run with `npx tsx --test lib/review/digest.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIGEST_COLUMNS,
  MAX_DIGEST_ITEMS,
  evidenceQuote,
  isOver,
  isStale,
  isUnconfirmedSource,
  isWaiting,
  planDigest,
  safeHttpUrl,
  topReasons,
  type StagedDeal,
} from "./digest";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW + days * DAY).toISOString();

let n = 0;
const deal = (over: Partial<StagedDeal> = {}): StagedDeal => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  title: `Deal ${n}`,
  quality_route: "digest",
  quality_score: 50,
  approved: false,
  extraction_status: "validated",
  happening_id: null,
  reviewed_at: null,
  digest_sent_at: null,
  created_at: ago(2),
  ...over,
});

test("isWaiting: only digest-routed, undecided, unpromoted rows", () => {
  assert.equal(isWaiting(deal()), true);
  assert.equal(isWaiting(deal({ approved: null, extraction_status: null })), true);
  assert.equal(isWaiting(deal({ quality_route: "publish" })), false);
  assert.equal(isWaiting(deal({ quality_route: "drop" })), false);
  assert.equal(isWaiting(deal({ quality_route: null })), false);
  assert.equal(isWaiting(deal({ approved: true })), false);
  assert.equal(isWaiting(deal({ extraction_status: "promoted" })), false);
  assert.equal(isWaiting(deal({ extraction_status: "approved" })), false);
  assert.equal(isWaiting(deal({ extraction_status: "rejected" })), false);
  assert.equal(isWaiting(deal({ happening_id: "11111111-1111-4111-8111-111111111111" })), false);
  assert.equal(isWaiting(deal({ reviewed_at: ago(1) })), false);
});

test("best score first, at most 10", () => {
  const rows = Array.from({ length: 15 }, (_, i) => deal({ quality_score: 40 + i }));
  const { items, waitingTotal } = planDigest(rows, NOW);
  assert.equal(items.length, MAX_DIGEST_ITEMS);
  assert.deepEqual(items.map((r) => r.quality_score), [54, 53, 52, 51, 50, 49, 48, 47, 46, 45]);
  assert.equal(waitingTotal, 15);
});

test("a null score sorts last; ties go to the older row", () => {
  const nul = deal({ quality_score: null });
  const young = deal({ quality_score: 60, created_at: ago(1) });
  const old = deal({ quality_score: 60, created_at: ago(6) });
  assert.deepEqual(planDigest([nul, young, old], NOW).items, [old, young, nul]);
});

test("rows staged more than 14 days ago expire; exactly 14 days does not", () => {
  const stale = deal({ created_at: ago(14.5) });
  const edge = deal({ created_at: ago(14) });
  const fresh = deal({ created_at: ago(3) });
  const plan = planDigest([stale, edge, fresh], NOW);
  assert.deepEqual(plan.expire, [stale]);
  assert.ok(!plan.items.includes(stale));
  assert.equal(plan.items.length, 2);
  assert.equal(plan.waitingTotal, 2);
  assert.equal(isStale(edge, NOW), false);
  assert.equal(isStale(stale, NOW), true);
});

test("a row with no created_at never expires", () => {
  assert.equal(isStale(deal({ created_at: null }), NOW), false);
  assert.equal(isStale(deal({ created_at: "not a date" }), NOW), false);
});

test("--max-age-days widens or narrows the window", () => {
  const r = deal({ created_at: ago(20) });
  assert.equal(planDigest([r], NOW).expire.length, 1);
  assert.equal(planDigest([r], NOW, { maxAgeDays: 30 }).expire.length, 0);
});

test("rows that are already decided or expired are not touched again (no double expiry)", () => {
  const done = deal({ created_at: ago(30), reviewed_at: ago(1), reviewed_action: "expired", extraction_status: "rejected" });
  const plan = planDigest([done], NOW);
  assert.equal(plan.expire.length, 0);
  assert.equal(plan.items.length, 0);
});

test("a row already sent stays out until more than 3 days have passed", () => {
  const sent2 = deal({ digest_sent_at: ago(2) });
  const sent3 = deal({ digest_sent_at: ago(3) });
  const sent4 = deal({ digest_sent_at: ago(3.1) });
  const never = deal();
  const { items, waitingTotal } = planDigest([sent2, sent3, sent4, never], NOW);
  assert.deepEqual(items.map((r) => r.id).sort(), [sent4.id, never.id].sort());
  assert.equal(waitingTotal, 4); // all still waiting, even the ones not in this email
});

test("a decided row that was sent before never comes back", () => {
  const approved = deal({ digest_sent_at: ago(10), reviewed_at: ago(5), reviewed_action: "approve", approved: true, extraction_status: "approved" });
  assert.equal(planDigest([approved], NOW).items.length, 0);
});

test("a deal whose own dates have passed is not emailed, but still counts as waiting", () => {
  const over = deal({ ends_at: ago(1) });
  const seasonOver = deal({ season_valid_until: ago(2).slice(0, 10) });
  const open = deal({ ends_at: ahead(5), season_valid_until: ahead(30).slice(0, 10) });
  const plan = planDigest([over, seasonOver, open], NOW);
  assert.deepEqual(plan.items, [open]);
  assert.equal(plan.waitingTotal, 3);
  assert.equal(isOver(over, NOW), true);
  assert.equal(isOver(deal({ season_valid_until: new Date(NOW).toISOString().slice(0, 10) }), NOW), false); // valid through today
});

test("zero waiting rows gives an empty plan", () => {
  assert.deepEqual(planDigest([], NOW), { expire: [], items: [], waitingTotal: 0 });
  const plan = planDigest([deal({ quality_route: "publish" })], NOW);
  assert.equal(plan.items.length, 0);
});

test("topReasons takes the first few strings", () => {
  assert.deepEqual(topReasons(deal({ quality_reasons: ["a", " b ", "", "c", "d"] }), 3), ["a", "b", "c"]);
  assert.deepEqual(topReasons(deal({ quality_reasons: null })), []);
  assert.deepEqual(topReasons(deal({ quality_reasons: { not: "an array" } })), []);
});

test("evidenceQuote reads evidence_quote only; an old row with none just has no quote", () => {
  assert.equal(evidenceQuote(deal()), null);
  assert.equal(evidenceQuote(deal({ evidence_quote: null })), null);
  assert.equal(evidenceQuote(deal({ evidence_quote: "   " })), null);
  assert.equal(evidenceQuote(deal({ evidence_quote: " Any pint £4 until 6pm " })), "Any pint £4 until 6pm");
  assert.equal(evidenceQuote(deal({ evidence_quote: "x".repeat(900) }))?.length, 400);
  // field_sources is no longer consulted.
  assert.equal(evidenceQuote({ ...deal(), field_sources: { deal_quote: "ignored" } } as StagedDeal), null);
});

test("DIGEST_COLUMNS names evidence_quote, slug and batch_id (so a missing column fails the query)", () => {
  for (const c of ["evidence_quote", "slug", "batch_id", "digest_sent_at", "reviewed_at", "quality_route"]) assert.ok(DIGEST_COLUMNS.split(",").includes(c), c);
  assert.ok(!DIGEST_COLUMNS.includes("*"));
});

// --- one row per slug ---------------------------------------------------------------------------

test("past batches of one slug collapse to the newest batch before the top 10", () => {
  const old1 = deal({ slug: "pints", batch_id: "edi-2026-10-19", created_at: ago(13), quality_score: 90 });
  const old2 = deal({ slug: "pints", batch_id: "edi-2026-10-26", created_at: ago(6), quality_score: 80 });
  const newest = deal({ slug: "pints", batch_id: "edi-daily-2026-11-02", created_at: ago(0.1), quality_score: 55 });
  const other = deal({ slug: "brunch", created_at: ago(1), quality_score: 60 });
  const plan = planDigest([old1, old2, newest, other], NOW);
  assert.deepEqual(plan.items.map((r) => r.id), [other.id, newest.id]); // the newest copy, with ITS score
  assert.equal(plan.waitingTotal, 2); // distinct deals, not rows
  assert.equal(plan.expire.length, 0);
});

test("collapsing happens before the cap: 12 rows of 4 slugs give 4 items, not 10 rows of repeats", () => {
  const rows = ["a", "b", "c", "d"].flatMap((slug, i) =>
    [1, 2, 3].map((age) => deal({ slug, created_at: ago(age), quality_score: 90 - i }))
  );
  const plan = planDigest(rows, NOW);
  assert.equal(plan.items.length, 4);
  assert.equal(new Set(plan.items.map((r) => r.slug)).size, 4);
});

test("same created_at: the later batch_id wins", () => {
  const a = deal({ slug: "s", batch_id: "edi-2026-10-26", created_at: ago(2) });
  const b = deal({ slug: "s", batch_id: "edi-2026-11-02", created_at: ago(2) });
  assert.deepEqual(planDigest([a, b], NOW).items, [b]);
});

test("rows without a slug are never collapsed together", () => {
  const plan = planDigest([deal({ slug: null }), deal({ slug: null }), deal({})], NOW);
  assert.equal(plan.items.length, 3);
});

test("a slug already live in happenings is skipped, and does not count as waiting", () => {
  const live = deal({ slug: "already-live" });
  const fresh = deal({ slug: "new-one" });
  const plan = planDigest([live, fresh], NOW, { liveSlugs: new Set(["already-live"]) });
  assert.deepEqual(plan.items, [fresh]);
  assert.equal(plan.waitingTotal, 1);
});

test("a slug with a row reviewed in ANY batch is skipped, even when this row was never reviewed", () => {
  const dupe = deal({ slug: "decided-elsewhere", batch_id: "edi-2026-11-02", created_at: ago(1) });
  const fresh = deal({ slug: "other" });
  const plan = planDigest([dupe, fresh], NOW, { decidedSlugs: new Set(["decided-elsewhere"]) });
  assert.deepEqual(plan.items, [fresh]);
  assert.equal(plan.waitingTotal, 1);
});

test("a copy sent yesterday keeps a newer unsent copy of the same slug out for the 3 days", () => {
  const old = deal({ slug: "s", created_at: ago(8), digest_sent_at: ago(1) });
  const newer = deal({ slug: "s", created_at: ago(1), digest_sent_at: null });
  assert.deepEqual(planDigest([old, newer], NOW).items, []);
  const older = deal({ slug: "s", created_at: ago(8), digest_sent_at: ago(4) });
  assert.deepEqual(planDigest([older, newer], NOW).items, [newer]);
});

test("a stale duplicate still expires even though a fresher copy of the slug is emailed", () => {
  const stale = deal({ slug: "s", created_at: ago(20) });
  const fresh = deal({ slug: "s", created_at: ago(1) });
  const plan = planDigest([stale, fresh], NOW);
  assert.deepEqual(plan.expire, [stale]);
  assert.deepEqual(plan.items, [fresh]);
});

test("isUnconfirmedSource flags social and newsletter sources only", () => {
  assert.equal(isUnconfirmedSource(deal({ source_url: "https://www.instagram.com/p/abc/" })), true);
  assert.equal(isUnconfirmedSource(deal({ source_url: "https://facebook.com/venue" })), true);
  assert.equal(isUnconfirmedSource(deal({ source_name: "Newsletter: The Skinny" })), true);
  assert.equal(isUnconfirmedSource(deal({ source_name: "via Edinburgh Student Weekly newsletter" })), true);
  assert.equal(isUnconfirmedSource(deal({ source_url: "https://www.itison.com/edinburgh", source_name: "itison" })), false);
  assert.equal(isUnconfirmedSource(deal({ source_url: "https://notinstagram.com/x" })), false);
  assert.equal(isUnconfirmedSource(deal({ source_url: "not a url" })), false);
  assert.equal(isUnconfirmedSource(deal()), false);
});

test("safeHttpUrl only passes http(s)", () => {
  assert.equal(safeHttpUrl("https://x.test/a?b=1"), "https://x.test/a?b=1");
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,hi"), null);
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl("nope"), null);
});
