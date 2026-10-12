// Run with `npx tsx --test lib/finds/candidates.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipWhy,
  comingFriday,
  evergreenDealScore,
  fallbackWhy,
  levelFromScore,
  parseAiDrafts,
  scoreCandidates,
  selectCandidates,
  WHY_MAX_CHARS,
  type Scorers,
} from "@/lib/finds/candidates";
import { event, happening, NOW } from "@/lib/finds/fixtures.test-util";

/** Stub scorers: score comes from the row's `priority` / `price_from`, so tests control ranking directly. */
const stub: Scorers = {
  happening: (h) => ({ score: h.priority ?? 0, reason: "stub" }),
  event: (e) => ({ score: e.price_from == null ? 0 : 100 - e.price_from, reason: null }),
};

const base = { now: NOW, excluded: new Set<string>(), scorers: stub };
const ids = (xs: { subject_id: string }[]) => xs.map((x) => x.subject_id);

// Wed 14 Oct 2026. Default window = to Sat 24 Oct.
const SOON = "2026-10-17T18:00:00Z";

test("happenings: needs an occurrence inside the window", () => {
  const got = scoreCandidates({
    ...base,
    events: [],
    happenings: [
      happening({ id: "in", starts_at: SOON }),
      happening({ id: "later", starts_at: "2026-12-01T18:00:00Z" }),
      happening({ id: "over", starts_at: "2026-10-01T18:00:00Z" }),
      happening({ id: "weekly", recurrence: { type: "weekly", days: [6] }, starts_at: null }),
    ],
  });
  assert.deepEqual(ids(got).sort(), ["in", "weekly"]);
});

test("happenings: not live, wrong city, family-only and over-60-only are dropped", () => {
  const got = scoreCandidates({
    ...base,
    events: [],
    happenings: [
      happening({ id: "ok", starts_at: SOON }),
      happening({ id: "dormant", starts_at: SOON, status: "dormant" }),
      happening({ id: "glasgow", starts_at: SOON, city: "Glasgow" }),
      happening({ id: "national", starts_at: SOON, scope: "national", city: null, region: null }),
      happening({ id: "region", starts_at: SOON, scope: "region", city: null, region: "Scotland" }),
      happening({ id: "otherregion", starts_at: SOON, scope: "region", city: null, region: "Wales" }),
      happening({ id: "family", starts_at: SOON, category: "family" }),
      happening({ id: "over60", starts_at: SOON, eligibility: "over_60" }),
      happening({ id: "pastseason", starts_at: SOON, season_valid_until: "2026-10-01" }),
    ],
  });
  assert.deepEqual(ids(got).sort(), ["national", "ok", "region"]);
});

test("evergreen (`always`) rows only when a genuine deal, scored by evergreenDealScore", () => {
  const always = { recurrence: { type: "always" as const } };
  const got = scoreCandidates({
    ...base,
    events: [],
    happenings: [
      happening({ id: "deal", ...always, saving_label: "2-for-1 pizza", saving_amount: 10 }),
      happening({ id: "freebie", ...always, kind: "free_access", is_free: true, title: "Open daily" }),
      happening({ id: "plain", ...always, kind: "free_access", title: "A museum", saving_label: null }),
    ],
  });
  // "Open daily" is not a discount shape and has no promo/eligibility saving -> not a genuine deal.
  assert.deepEqual(ids(got), ["deal"]);
  assert.equal(got[0].when, "Any day");
  assert.equal(got[0].score, evergreenDealScore(happening({ id: "deal", ...always, saving_label: "2-for-1 pizza", saving_amount: 10 }), NOW).score);
});

test("evergreen score: free + image beats unverified image-less; stale and narrow eligibility cost points", () => {
  const strong = evergreenDealScore(happening({ id: "a", is_free: true, saving_label: "Free entry", image_url: "x" }), NOW).score;
  const weak = evergreenDealScore(happening({ id: "b", saving_label: "10% off", image_url: null, verified_at: "2026-08-01T00:00:00Z", eligibility: "student" }), NOW).score;
  assert.ok(strong > weak + 40, `${strong} vs ${weak}`);
});

test("events: free or <= £15, active, starting in the window; priced/unpriced/ended/off/family dropped", () => {
  const got = scoreCandidates({
    ...base,
    happenings: [],
    events: [
      event({ id: "free", is_free: true, price_from: null }),
      event({ id: "cheap", price_from: 15 }),
      event({ id: "dear", price_from: 15.5 }),
      event({ id: "unpriced", is_free: false, price_from: null }),
      event({ id: "cancelled", status: "cancelled", is_free: true }),
      event({ id: "started", is_free: true, starts_at: "2026-10-14T10:00:00Z" }),
      event({ id: "toolate", is_free: true, starts_at: "2026-11-30T19:00:00Z" }),
      event({ id: "family", is_free: true, category: "family" }),
    ],
  });
  assert.deepEqual(ids(got).sort(), ["cheap", "free"]);
});

test("events collapse by title (a daily tour is one candidate, its best-scoring row) and yield to a same-day happening", () => {
  const got = scoreCandidates({
    ...base,
    happenings: [happening({ id: "hap", title: "Comedy Night!", starts_at: "2026-10-16T19:00:00Z", priority: 10 })],
    events: [
      event({ id: "tour1", name: "Ghost Tour", price_from: 12, starts_at: "2026-10-15T19:00:00Z" }),
      event({ id: "tour2", name: "Ghost Tour", price_from: 5, starts_at: "2026-10-16T19:00:00Z" }),
      event({ id: "dup", name: "comedy night", price_from: 5, starts_at: "2026-10-16T21:00:00Z" }),
    ],
  });
  assert.deepEqual(ids(got).sort(), ["hap", "tour2"]);
});

test("excluded subjects (live/retired Finds) are never candidates", () => {
  const got = scoreCandidates({
    ...base,
    excluded: new Set(["happening:h1", "event:e1"]),
    happenings: [happening({ id: "h1", starts_at: SOON }), happening({ id: "h2", starts_at: SOON })],
    events: [event({ id: "e1", is_free: true }), event({ id: "e2", is_free: true })],
  });
  assert.deepEqual(ids(got).sort(), ["e2", "h2"]);
});

test("festival rows are down-ranked, not dropped", () => {
  const got = scoreCandidates({
    ...base,
    events: [],
    happenings: [happening({ id: "f", kind: "festival", starts_at: SOON, priority: 60 }), happening({ id: "n", starts_at: SOON, priority: 60 })],
  });
  const score = (id: string) => got.find((c) => c.subject_id === id)!.score;
  assert.equal(score("n") - score("f"), 10);
});

test("selectCandidates: top N by score, events capped at half, then backfilled", () => {
  const hs = [90, 80, 70].map((p, i) => happening({ id: `h${i}`, starts_at: SOON, priority: p }));
  const es = [1, 2, 3, 4, 5].map((p) => event({ id: `e${p}`, name: `E${p}`, price_from: p })); // scores 99..95, all above the happenings
  const picked = selectCandidates({ ...base, happenings: hs, events: es, limit: 4 });
  // Cap = 2 events; the rest are the top happenings, then sorted by score overall.
  assert.deepEqual(ids(picked), ["e1", "e2", "h0", "h1"]);

  // Not enough happenings: skipped events backfill rather than leaving it short.
  const few = selectCandidates({ ...base, happenings: [hs[0]], events: es, limit: 4 });
  assert.deepEqual(ids(few), ["e1", "e2", "e3", "h0"]);
});

test("selectCandidates ranking is deterministic: score, then soonest, then id", () => {
  const picked = selectCandidates({
    ...base,
    events: [],
    happenings: [
      happening({ id: "b", starts_at: "2026-10-18T18:00:00Z", priority: 70 }),
      happening({ id: "a", starts_at: "2026-10-18T18:00:00Z", priority: 70 }),
      happening({ id: "early", starts_at: "2026-10-16T18:00:00Z", priority: 70 }),
    ],
  });
  assert.deepEqual(ids(picked), ["early", "a", "b"]);
});

test("levelFromScore is monotonic and spans 1-5", () => {
  const levels = [0, 29, 30, 44, 45, 59, 60, 74, 75, 200].map(levelFromScore);
  assert.deepEqual(levels, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
});

test("clipWhy keeps short text and cuts long text on a word boundary within the budget", () => {
  assert.equal(clipWhy("  £8 wristband gets you £5 cocktails all week "), "£8 wristband gets you £5 cocktails all week");
  const long = clipWhy("Cheap cocktails and free entry before eleven for students at every single bar on the Cowgate this week");
  assert.ok(long.length <= WHY_MAX_CHARS, String(long.length));
  assert.ok(long.endsWith("…"));
});

test("fallbackWhy uses the reason, else price, else a neutral line; never invents a price", () => {
  assert.equal(fallbackWhy({ reason: "Free · tomorrow", price: "Free", venue: "Summerhall" }), "Free · tomorrow at Summerhall");
  assert.equal(fallbackWhy({ reason: null, price: "From £8", venue: null }), "From £8");
  assert.equal(fallbackWhy({ reason: null, price: "", venue: "The Bar" }), "On at The Bar");
  assert.equal(fallbackWhy({ reason: null, price: "", venue: null }), "Worth a look this week");
});

test("parseAiDrafts clamps levels, clips whys and skips malformed entries", () => {
  const drafts = parseAiDrafts(
    {
      finds: [
        { n: 1, why: "Good one", fomo_level: 9 },
        { n: 2, why: "", fomo_level: 3 },
        { n: 7, why: "out of range", fomo_level: 3 },
        { n: 3, why: "Fine", fomo_level: "four" },
        { n: 3, why: "x".repeat(200), fomo_level: 0 },
      ],
    },
    3
  );
  assert.equal(drafts.get(0)?.fomo_level, 5);
  assert.equal(drafts.has(1), false);
  assert.equal(drafts.get(2)?.fomo_level, 1);
  assert.ok((drafts.get(2)?.why.length ?? 999) <= WHY_MAX_CHARS);
  assert.equal(parseAiDrafts(null, 3).size, 0);
  assert.equal(parseAiDrafts({ finds: "nope" }, 3).size, 0);
});

test("comingFriday: today if Friday, else the next one (Europe/London)", () => {
  assert.equal(comingFriday(new Date("2026-10-14T12:00:00Z")), "2026-10-16"); // Wed
  assert.equal(comingFriday(new Date("2026-10-16T07:00:00Z")), "2026-10-16"); // Fri
  assert.equal(comingFriday(new Date("2026-10-17T12:00:00Z")), "2026-10-23"); // Sat
});
