// Run: npx tsx --test lib/happenings/deal-review.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { exceedsCap, MAX_CHANGES, reviewDeals, type ReviewableDeal } from "./deal-review";

// Wed 14 Oct 2026, midday London.
const now = new Date("2026-10-14T11:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

// A fresh, genuine, open-ended Edinburgh deal; each test overrides what it needs.
function deal(id: string, over: Partial<ReviewableDeal> = {}): ReviewableDeal {
  return {
    id,
    title: `Deal ${id}`,
    venue_name: `Venue ${id}`,
    source_url: `https://example.com/${id}`,
    status: "live",
    saving_label: "20% off with a student card",
    saving_amount: null,
    currency: "GBP",
    is_free: false,
    promo_code: null,
    eligibility: "student",
    starts_at: null,
    ends_at: null,
    recurrence: { type: "always" },
    verified_at: daysAgo(2),
    lat: 55.9533,
    lng: -3.1883,
    created_at: daysAgo(40),
    ...over,
  };
}

function only(d: ReviewableDeal) {
  return reviewDeals([d], now).verdicts[0];
}

test("an ended weekly deal (until in the past) is retired", () => {
  const v = only(deal("a", { recurrence: { type: "weekly", days: [1], until: "2026-09-30" } }));
  assert.equal(v.action, "retire");
});

test("an open-ended weekly deal is kept", () => {
  assert.equal(only(deal("a", { recurrence: { type: "weekly", days: [1] } })).action, "keep");
});

test("a past ends_at retires, and a past season_valid_until retires", () => {
  assert.equal(only(deal("a", { ends_at: "2026-09-01T00:00:00Z" })).action, "retire");
  assert.equal(only(deal("b", { season_valid_until: "2026-09-01" })).action, "retire");
});

test("a finished season on a yearly rule goes dormant, not retired", () => {
  const v = only(deal("a", { recurrence: { type: "annual", month: 12, day: 1 }, season_valid_until: "2026-09-01" }));
  assert.equal(v.action, "dormant");
});

test("an undated one-off is not read as ended", () => {
  assert.equal(only(deal("a", { recurrence: { type: "once" }, starts_at: null })).action, "keep");
});

test("a deal unverified for 40 days goes dormant; so does one never verified", () => {
  assert.equal(only(deal("a", { verified_at: daysAgo(40) })).action, "dormant");
  assert.equal(only(deal("b", { verified_at: null as unknown as string })).action, "dormant");
});

test("a deal unverified for 20 days is kept (inside the 30-day window)", () => {
  assert.equal(only(deal("a", { verified_at: daysAgo(20) })).action, "keep");
});

test("ended beats stale: an ended and unverified deal is retired", () => {
  const v = only(deal("a", { ends_at: "2026-09-01T00:00:00Z", verified_at: daysAgo(60) }));
  assert.equal(v.action, "retire");
});

test("a fresh genuine deal is kept with no flags", () => {
  const v = only(deal("a"));
  assert.equal(v.action, "keep");
  assert.deepEqual(v.flags, []);
});

test("a non-genuine deal is only flagged, never changed", () => {
  const v = only(deal("a", { title: "Tickets on sale now", saving_label: "£20", eligibility: "anyone", saving_amount: null }));
  assert.equal(v.action, "keep");
  assert.deepEqual(v.flags.map((f) => f.flag), ["not_genuine"]);
});

test("an out-of-bounds deal is flagged; one with no coordinates is not", () => {
  const glasgow = only(deal("a", { lat: 55.8642, lng: -4.2518 }));
  assert.equal(glasgow.action, "keep");
  assert.deepEqual(glasgow.flags.map((f) => f.flag), ["outside_edinburgh"]);
  assert.deepEqual(only(deal("b", { lat: null, lng: null })).flags, []);
});

test("same venue plus the same saving badge is flagged as a duplicate on both rows", () => {
  const review = reviewDeals(
    [
      deal("a", { title: "Student night", venue_name: "The Beer Cellar", saving_label: "20% off" }),
      deal("b", { title: "Weekday offer for everyone", venue_name: "The Beer Cellar", saving_label: "Save 20% on food" }),
      deal("c", { title: "Other", venue_name: "Elsewhere", saving_label: "20% off" }),
    ],
    now
  );
  assert.deepEqual(
    review.flagged.map((v) => v.deal.id),
    ["a", "b"]
  );
  assert.equal(review.flagged[0].flags[0].flag, "duplicate");
});

test("same venue and a near-identical title is flagged as a duplicate", () => {
  const review = reviewDeals(
    [
      deal("a", { title: "2-for-1 Burgers (Mondays)", venue_name: "Bar One", saving_label: "2-for-1 burgers" }),
      deal("b", { title: "2-for-1 burgers", venue_name: "BAR ONE", saving_label: "Two burgers for the price of one" }),
    ],
    now
  );
  assert.equal(review.flagged.length, 2);
});

test("a duplicate of a row being retired is not flagged", () => {
  const review = reviewDeals(
    [
      deal("a", { venue_name: "Bar One", ends_at: "2026-09-01T00:00:00Z" }),
      deal("b", { venue_name: "Bar One" }),
    ],
    now
  );
  assert.equal(review.retire.length, 1);
  assert.equal(review.flagged.length, 0);
});

test("only live rows are reviewed", () => {
  const review = reviewDeals(
    [deal("a", { status: "dormant", verified_at: daysAgo(90) }), deal("b", { status: "retired", ends_at: "2026-01-01T00:00:00Z" })],
    now
  );
  assert.equal(review.verdicts.length, 0);
});

test("new today: created in the last 24 hours, whatever the verdict", () => {
  const review = reviewDeals(
    [
      deal("a", { created_at: daysAgo(0.5) }),
      deal("b", { created_at: daysAgo(0.5), title: "Tickets on sale", saving_label: null, eligibility: "anyone" }),
      deal("c", { created_at: daysAgo(3) }),
    ],
    now
  );
  assert.deepEqual(
    review.newToday.map((v) => v.deal.id),
    ["a", "b"]
  );
});

test("cap: exactly MAX_CHANGES is allowed, one more is not", () => {
  assert.equal(exceedsCap(MAX_CHANGES), false);
  assert.equal(exceedsCap(MAX_CHANGES + 1), true);

  const stale = (n: number) => Array.from({ length: n }, (_, i) => deal(`s${i}`, { verified_at: daysAgo(45) }));
  assert.equal(reviewDeals(stale(MAX_CHANGES), now).overCap, false);
  const over = reviewDeals(stale(MAX_CHANGES + 1), now);
  assert.equal(over.changeCount, MAX_CHANGES + 1);
  assert.equal(over.overCap, true);
});

test("a national chain's shallow discount is flagged; a deep one or a local 10% is not", () => {
  const shallow = only(deal("a", { venue_name: "COSMO Edinburgh", saving_label: "10% off food bill" }));
  assert.equal(shallow.action, "keep");
  assert.deepEqual(shallow.flags.map((f) => f.flag), ["chain_shallow"]);
  assert.deepEqual(only(deal("b", { venue_name: "ASK Italian Edinburgh", saving_label: "50% off mains" })).flags, []);
  assert.deepEqual(only(deal("c", { venue_name: "Paper Tiger", saving_label: "10% off" })).flags, []);
});
