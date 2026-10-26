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
    address: null,
    scope: "venue",
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

test("a pin outside the Edinburgh box (no postcode, no town) goes dormant", () => {
  const v = only(deal("a", { venue_name: "Some Bar", title: "Pint offer", lat: 55.8642, lng: -4.2518 }));
  assert.equal(v.action, "dormant");
  assert.equal(v.reason, "outside Edinburgh: pin 55.8642, -4.2518");
  assert.deepEqual(v.flags, []);
});

test("a deal with no coordinates is not read as outside Edinburgh", () => {
  assert.equal(only(deal("b", { lat: null, lng: null })).action, "keep");
});

test("an EH21 address (Musselburgh) goes dormant", () => {
  const v = only(deal("a", { venue_name: "Lido", address: "1 High St, Musselburgh EH21 7AB" }));
  assert.equal(v.action, "dormant");
  assert.equal(v.reason, "outside Edinburgh: EH21 postcode");
});

test("an EH6 address is kept", () => {
  assert.equal(only(deal("a", { address: "10 Leith Walk, Edinburgh EH6 5AB" })).action, "keep");
});

test("an EH30 address (South Queensferry) is kept", () => {
  assert.equal(only(deal("a", { address: "3 High St, South Queensferry EH30 9PA" })).action, "keep");
});

test("EH districts: the city, its edge and the non-geographic codes are in; the rest are out", () => {
  const inside = ["EH1 1AA", "EH17 8XY", "EH28 8AB", "EH29 9BA", "EH30 9TA", "EH91 1AB", "EH95 1AA", "EH99 1AB"];
  const outside = ["EH18 1AA", "EH22 1AA", "EH26 6AA", "EH27 8AA", "EH31 1AA", "EH39 4AA"];
  for (const address of inside) assert.equal(only(deal("i", { address })).action, "keep", address);
  for (const address of outside) assert.equal(only(deal("o", { address })).action, "dormant", address);
});

test("a Glasgow G1 postcode goes dormant", () => {
  const v = only(deal("a", { address: "12 Buchanan St, Glasgow G1 2FF" }));
  assert.equal(v.action, "dormant");
  assert.equal(v.reason, "outside Edinburgh: G1 postcode");
});

test("a town name in the venue goes dormant when there is no address", () => {
  const v = only(deal("a", { venue_name: "Lido Musselburgh", title: "20% off main menu" }));
  assert.equal(v.action, "dormant");
  assert.equal(v.reason, "outside Edinburgh: Musselburgh");
});

test("a town name in the title is matched too, whole words only", () => {
  assert.equal(only(deal("a", { title: "Bus trip to North Berwick" })).reason, "outside Edinburgh: North Berwick");
  assert.equal(only(deal("b", { title: "Stirlingshire offer" })).action, "keep");
});

test("Leith and Portobello are inside the city, so they never match as towns", () => {
  assert.equal(only(deal("a", { title: "The Lioness of Leith", venue_name: "The Lioness of Leith" })).action, "keep");
  assert.equal(only(deal("b", { venue_name: "Portobello Beach Bar", title: "Pizza night" })).action, "keep");
});

test("an Edinburgh postcode decides before a town name or the pin", () => {
  const v = only(deal("a", { address: "5 Shore, EH6 6QU", venue_name: "Musselburgh Arms", lat: 55.8642, lng: -4.2518 }));
  assert.equal(v.action, "keep");
});

test("no address, no coordinates and an Edinburgh name is kept", () => {
  const v = only(deal("a", { address: null, lat: null, lng: null, venue_name: "Bella Italia Edinburgh", title: "Student deal" }));
  assert.equal(v.action, "keep");
  assert.deepEqual(v.flags, []);
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

test("a national offer is never hidden for where its head office is", () => {
  const v = only(deal("a", { scope: "national", venue_name: "16-25 Railcard", address: "1 Euston Sq, London NW1 2FA" }));
  assert.equal(v.action, "keep");
});
