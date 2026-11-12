// Run with `npx tsx --test lib/radar/radar.test.ts lib/db/radar.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  disqualifier,
  formatCandidateTable,
  isHeadlineAttraction,
  neighbourhoodOf,
  scorePlace,
  selectCandidates,
} from "@/lib/radar/candidates";
import { featuredFirst, featuredPick, isRadarPick, orderPicks } from "@/lib/radar/picks";
import { isMissingRadarColumn } from "@/lib/radar/safe";
import { currentWeekStart, isDayDate, mondayOf } from "@/lib/radar/week";
import type { Place } from "@/lib/types";

let n = 0;
/** A plausible independent Stockbridge cafe; override what a test cares about. */
export function place(over: Partial<Place> = {}): Place {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Cafe ${n}`,
    category: "cafe",
    rating: 4.7,
    image_url: "https://example.com/a.jpg",
    distance_label: null,
    tips: [],
    reviews: [],
    hours: null,
    station: null,
    badges: [],
    google_place_id: null,
    lat: 55.9601,
    lng: -3.2081, // Stockbridge
    address: "1 Example St, Edinburgh",
    price_level: 1,
    destination: null,
    source: "seed",
    fetched_at: null,
    city: "Edinburgh",
    prefecture: null,
    country: "GB",
    description: null,
    last_verified_at: null,
    hours_status: null,
    opening_hours: null,
    mention_count: 0,
    mention_sources: [],
    detail_line: null,
    image_quality: "ok",
    website: null,
    phone: null,
    google_rating_count: 80,
    price_range: null,
    business_status: "OPERATIONAL",
    google_maps_uri: null,
    google_summary: null,
    google_summary_disclosure: null,
    google_fetched_at: null,
    ...over,
  };
}

test("disqualifier: chains, event venues, closed, headline, far away, lodging, already picked", () => {
  assert.equal(disqualifier(place()), null);
  assert.equal(disqualifier(place({ name: "Starbucks" })), "national chain");
  assert.equal(disqualifier(place({ source: "event-venue" })), "event venue");
  assert.equal(disqualifier(place({ business_status: "CLOSED_PERMANENTLY" })), "closed");
  assert.equal(disqualifier(place({ name: "Edinburgh Castle" })), "headline attraction");
  assert.equal(disqualifier(place({ google_rating_count: 9000 })), "headline attraction");
  assert.equal(disqualifier(place({ lat: 57.1, lng: -2.1, address: "Aberdeen" })), "not in Edinburgh");
  assert.equal(disqualifier(place({ name: "The Quiet Hotel" })), "not a place to recommend");
  assert.equal(disqualifier(place({ radar_picked_at: "2026-11-01T00:00:00Z" })), "already a pick");
  assert.equal(disqualifier(place({ name: "  " })), "no name");
});

test("disqualifier: no coordinates falls back to the address saying Edinburgh", () => {
  assert.equal(disqualifier(place({ lat: null, lng: null, address: "5 Leith Walk, Edinburgh" })), null);
  assert.equal(disqualifier(place({ lat: null, lng: null, city: null, address: "Glasgow" })), "not in Edinburgh");
});

test("isHeadlineAttraction: by name (curly apostrophe too) or by review count", () => {
  assert.equal(isHeadlineAttraction({ name: "Arthur’s Seat", google_rating_count: null }), true);
  assert.equal(isHeadlineAttraction({ name: "Tiny Bookshop", google_rating_count: 40 }), false);
  assert.equal(isHeadlineAttraction({ name: "Tiny Bookshop", google_rating_count: 2500 }), true);
});

test("scorePlace: high rating on a modest count beats a famous or thin one", () => {
  const loved = scorePlace(place({ rating: 4.8, google_rating_count: 90 }));
  const famous = scorePlace(place({ rating: 4.8, google_rating_count: 2000 }));
  const thin = scorePlace(place({ rating: 4.8, google_rating_count: 4 }));
  assert.ok(loved.score > famous.score);
  assert.ok(loved.score > thin.score);
  assert.equal(loved.signal, "strong");
  assert.equal(thin.signal, "weak");
});

test("scorePlace: a real photo helps; missing rating is a weak signal, not a disqualifier", () => {
  const photo = scorePlace(place({ image_quality: "ok" }));
  const none = scorePlace(place({ image_quality: "none", image_url: null }));
  assert.ok(photo.score > none.score);
  const unrated = scorePlace(place({ rating: null, google_rating_count: null }));
  assert.equal(unrated.signal, "weak");
  assert.ok(unrated.score > 0);
  assert.equal(disqualifier(place({ rating: null, google_rating_count: null })), null);
});

test("neighbourhoodOf: nearest named area, else Elsewhere / Unknown", () => {
  assert.equal(neighbourhoodOf({ lat: 55.9601, lng: -3.2081 }), "Stockbridge");
  assert.equal(neighbourhoodOf({ lat: 55.9751, lng: -3.17 }), "Leith");
  assert.equal(neighbourhoodOf({ lat: 55.9, lng: -3.4 }), "Elsewhere");
  assert.equal(neighbourhoodOf({ lat: null, lng: null }), "Unknown");
});

test("selectCandidates: drops disqualified and excluded, respects the limit, is deterministic", () => {
  const good = Array.from({ length: 5 }, () => place());
  const bad = [place({ name: "Pret a Manger" }), place({ source: "event-venue" })];
  const excluded = new Set([good[0].id]);
  const a = selectCandidates([...bad, ...good], { limit: 3, excludedIds: excluded });
  const b = selectCandidates([...good].reverse().concat(bad), { limit: 3, excludedIds: excluded });
  assert.equal(a.length, 3);
  assert.ok(a.every((c) => c.place.id !== good[0].id && !bad.some((x) => x.id === c.place.id)));
  assert.deepEqual(a.map((c) => c.place.id), b.map((c) => c.place.id));
});

test("selectCandidates: spreads across neighbourhoods and categories", () => {
  const stockbridgeCafes = Array.from({ length: 4 }, () => place({ rating: 4.9, google_rating_count: 60 }));
  const leithBookshop = place({
    category: "bookshop",
    lat: 55.975,
    lng: -3.17,
    rating: 4.6,
    google_rating_count: 120,
  });
  const out = selectCandidates([...stockbridgeCafes, leithBookshop], { limit: 3 });
  assert.ok(out.some((c) => c.place.id === leithBookshop.id), "the Leith bookshop is pulled into the top 3");
});

test("selectCandidates: places with no ratings are still listed, marked weak", () => {
  const out = selectCandidates([place({ rating: null, google_rating_count: null })], { limit: 5 });
  assert.equal(out.length, 1);
  assert.equal(out[0].signal, "weak");
  assert.match(formatCandidateTable(out), /WEAK signal/);
  assert.match(formatCandidateTable(out), /no rating/);
});

test("formatCandidateTable: empty list", () => {
  assert.match(formatCandidateTable([]), /no candidates/);
});

// --- picks / weeks ----------------------------------------------------------

const pick = (over: Partial<Place> = {}) =>
  place({ radar_why: "A courtyard cafe most people walk past", radar_picked_at: "2026-11-02T10:00:00Z", ...over });

test("isRadarPick needs both the approval stamp and a non-blank reason", () => {
  assert.equal(isRadarPick(pick()), true);
  assert.equal(isRadarPick(pick({ radar_why: "   " })), false);
  assert.equal(isRadarPick(pick({ radar_picked_at: null })), false);
  assert.equal(isRadarPick(place()), false);
});

test("orderPicks keeps approved only, newest first", () => {
  const old = pick({ radar_picked_at: "2026-10-01T00:00:00Z" });
  const recent = pick({ radar_picked_at: "2026-11-05T00:00:00Z" });
  const out = orderPicks([old, place(), recent]);
  assert.deepEqual(out.map((p) => p.id), [recent.id, old.id]);
});

test("week helpers: mondayOf, isDayDate, currentWeekStart (Europe/London)", () => {
  assert.equal(mondayOf("2026-11-11"), "2026-11-09"); // Wed
  assert.equal(mondayOf("2026-11-09"), "2026-11-09"); // Mon
  assert.equal(mondayOf("2026-11-15"), "2026-11-09"); // Sun
  assert.equal(isDayDate("2026-02-30"), false);
  assert.equal(isDayDate("2026-11-9"), false);
  assert.equal(isDayDate("2026-11-09"), true);
  // 23:30 UTC on Sun 8 Nov is still Sunday in London (GMT), so the week began Mon 2 Nov.
  assert.equal(currentWeekStart(new Date("2026-11-08T23:30:00Z")), "2026-11-02");
});

test("featuredPick matches only this week's Monday; featuredFirst leads with it", () => {
  const now = new Date("2026-11-11T12:00:00Z"); // week of 2026-11-09
  const a = pick({ radar_featured_week: "2026-11-02" });
  const b = pick({ radar_featured_week: "2026-11-09", radar_picked_at: "2026-10-20T00:00:00Z" });
  const c = pick();
  const picks = orderPicks([a, b, c]);
  assert.equal(featuredPick(picks, now)?.id, b.id);
  assert.equal(featuredFirst(picks, now)[0].id, b.id);
  assert.equal(featuredFirst(picks, now).length, 3);
  assert.equal(featuredPick(picks, new Date("2026-12-01T12:00:00Z")), null);
  assert.deepEqual(featuredFirst(picks, new Date("2026-12-01T12:00:00Z")).map((p) => p.id), picks.map((p) => p.id));
});

test("isMissingRadarColumn recognises the missing-column errors, and only for radar columns", () => {
  assert.equal(isMissingRadarColumn({ code: "42703", message: "column places.radar_picked_at does not exist" }), true);
  assert.equal(isMissingRadarColumn({ code: "PGRST204", message: "Could not find the 'radar_why' column of 'places'" }), true);
  assert.equal(isMissingRadarColumn({ message: "column places.radar_why does not exist" }), true);
  assert.equal(isMissingRadarColumn({ code: "42703", message: "column places.other does not exist" }), false);
  assert.equal(isMissingRadarColumn({ code: "500", message: "boom" }), false);
  assert.equal(isMissingRadarColumn(null), false);
});
