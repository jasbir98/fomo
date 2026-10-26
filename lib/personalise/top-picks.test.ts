// Run: npx tsx --test lib/personalise/top-picks.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening } from "@/lib/happenings/types";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import { cardRecommendationScore } from "@/lib/happenings/hero";
import { topPicks } from "./top-picks";
import type { BoostPrefs } from "./score";

const NOW = new Date("2026-10-12T10:00:00Z");
const TZ = "Europe/London";
const NO_PREFS: BoostPrefs = { interests: [], budget: "any", who: [] };
const PHOTO = "https://example.com/uploads/street-scene.jpg";

function happening(id: string, over: Partial<Happening> = {}): Happening {
  return {
    id,
    title: `Happening ${id}`,
    kind: "event",
    category: "other",
    status: "live",
    eligibility: "anyone",
    is_free: false,
    saving_label: null,
    saving_amount: null,
    currency: "GBP",
    starts_at: "2026-10-14T19:00:00Z",
    ends_at: null,
    recurrence: { type: "once" },
    image_url: PHOTO,
    verified_at: "2026-10-12T00:00:00Z",
    priority: 50,
    ...over,
  } as unknown as Happening;
}

function card(id: string, over: Partial<Happening> = {}): FeedCardData {
  const h = happening(id, over);
  return {
    kind: "happening",
    happening: h,
    occurrence: {
      happeningId: id,
      dayDate: "2026-10-14",
      startsAt: h.starts_at,
      endsAt: null,
      lastDayDate: "2026-10-14",
      seriesEndDayDate: "2026-10-14",
      exact: true,
    },
  };
}

const ids = (cards: readonly { card: FeedCardData }[]) =>
  cards.map((p) => (p.card.kind === "happening" ? p.card.happening.id : "?"));

/** Ten plain cards with descending priority (the hero clamps it to +-15 around 50), so the hero score order is a, b, c, ... */
function plain(n: number, over: Partial<Happening> = {}): FeedCardData[] {
  return Array.from({ length: n }, (_, i) => card(String.fromCharCode(97 + i), { priority: 65 - i * 3, ...over }));
}

test("a student-only card is not picked for a known local resident, unless there aren't enough others", () => {
  const studentOnly = card("student", { eligibility: "student", is_free: true, priority: 100 });
  const cards = [studentOnly, ...plain(6)];
  const prefs: BoostPrefs = { ...NO_PREFS, who: ["residents"] };
  const { picks, rest } = topPicks(cards, { prefs, now: NOW, timeZone: TZ });
  assert.equal(picks.length, 5);
  assert.ok(!ids(picks).includes("student"));
  assert.ok(ids(rest.map((c) => ({ card: c }))).includes("student"));

  // Only 3 cards in total: the section still fills, the ineligible one last.
  const few = topPicks([studentOnly, ...plain(2)], { prefs, now: NOW, timeZone: TZ });
  assert.equal(few.picks.length, 3);
  assert.equal(ids(few.picks)[2], "student");

  // An unknown visitor is never ineligible.
  const anon = topPicks(cards, { prefs: NO_PREFS, now: NOW, timeZone: TZ });
  assert.ok(ids(anon.picks).includes("student"));
});

test("a comedy card ranks into the five for a visitor into comedy", () => {
  const comedy = card("comedy", { category: "comedy", priority: 10 });
  const cards = [...plain(8), comedy];
  const without = topPicks(cards, { prefs: NO_PREFS, now: NOW, timeZone: TZ });
  assert.ok(!ids(without.picks).includes("comedy"));
  const prefs: BoostPrefs = { ...NO_PREFS, interests: ["comedy"] };
  const { picks } = topPicks(cards, { prefs, now: NOW, timeZone: TZ });
  assert.ok(ids(picks).includes("comedy"));
});

test("the minimum number of photo cards is respected", () => {
  const noPhoto = Array.from({ length: 5 }, (_, i) => card(`n${i}`, { priority: 65 - i, image_url: null }));
  const photos = Array.from({ length: 4 }, (_, i) => card(`p${i}`, { priority: 5 - i }));
  const { picks } = topPicks([...noPhoto, ...photos], { prefs: NO_PREFS, now: NOW, timeZone: TZ });
  const picked = ids(picks);
  assert.equal(picked.length, 5);
  assert.equal(picked.filter((id) => id.startsWith("p")).length, 3);
  // The best non-photo cards survive.
  assert.ok(picked.includes("n0") && picked.includes("n1"));

  // Fewer photo cards than the minimum: take what exists, still five picks.
  const one = topPicks([...noPhoto, photos[0]], { prefs: NO_PREFS, now: NOW, timeZone: TZ });
  assert.equal(one.picks.length, 5);
  assert.ok(ids(one.picks).includes("p0"));
});

test("with no prefs the order follows the hero score", () => {
  const cards = [card("low", { priority: 5 }), card("free", { is_free: true, priority: 50 }), card("mid", { priority: 40 }), ...plain(4)];
  const { picks, rest } = topPicks(cards, { prefs: NO_PREFS, now: NOW, timeZone: TZ });
  const scores = picks.map((p) => cardRecommendationScore(p.card, NOW, TZ));
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal(ids(picks)[0], "free");
  assert.equal(picks.length + rest.length, cards.length);
  // rest keeps the original order.
  const order = cards.map((c) => (c.kind === "happening" ? c.happening.id : ""));
  const restIds = ids(rest.map((c) => ({ card: c })));
  assert.deepEqual(restIds, order.filter((id) => restIds.includes(id)));
});

test("reasons: the visitor's taste when personalised, else the hero reason", () => {
  const free = card("free", { is_free: true, category: "other" });
  const comedy = card("comedy", { category: "comedy" });
  const personal = topPicks([free, comedy], { prefs: { ...NO_PREFS, interests: ["comedy"] }, now: NOW, timeZone: TZ });
  const byId = new Map(personal.picks.map((p) => [ids([p])[0], p.reason]));
  assert.equal(byId.get("comedy"), "You're into Comedy");

  const plainPicks = topPicks([free], { prefs: NO_PREFS, now: NOW, timeZone: TZ });
  assert.ok(plainPicks.picks[0].reason?.includes("Free"));
});

test("a series and its member never both appear", () => {
  const lead = happening("lead");
  const member = card("lead");
  const series: FeedCardData = {
    kind: "series",
    key: "s1",
    title: "Series",
    lead,
    occurrence: (member as Extract<FeedCardData, { kind: "happening" }>).occurrence,
    members: [],
  } as unknown as FeedCardData;
  const { picks } = topPicks([series, member, ...plain(3)], { prefs: NO_PREFS, now: NOW, timeZone: TZ });
  assert.equal(picks.filter((p) => p.card.kind === "series" || (p.card.kind === "happening" && p.card.happening.id === "lead")).length, 1);
});
