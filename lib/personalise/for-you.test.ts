// Run: npx tsx --test lib/personalise/for-you.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import type { FindItem } from "@/lib/finds/types";
import { MAX_PER_INTEREST, buildForYou, hasTaste, personalReason } from "./for-you";
import type { BoostPrefs } from "./score";

const NOW = new Date("2026-10-12T10:00:00Z");
const NO_PREFS: BoostPrefs = { interests: [], budget: "any", who: [] };

function happening(id: string, over: Partial<Happening> = {}): Happening {
  return {
    id,
    title: `Happening ${id}`,
    kind: "event",
    category: "comedy",
    status: "live",
    eligibility: "anyone",
    is_free: false,
    saving_label: null,
    saving_amount: null,
    currency: "GBP",
    starts_at: "2026-10-14T19:00:00Z",
    ends_at: null,
    recurrence: { type: "once" },
    image_url: null,
    verified_at: "2026-10-12T00:00:00Z",
    priority: 50,
    ...over,
  } as unknown as Happening;
}

function hapCard(h: Happening, dayDate = "2026-10-14"): FeedCardData {
  return {
    kind: "happening",
    happening: h,
    occurrence: {
      happeningId: h.id,
      dayDate,
      startsAt: h.starts_at,
      endsAt: null,
      lastDayDate: dayDate,
      seriesEndDayDate: dayDate,
      exact: true,
    },
  };
}

function eventCard(id: string, over: Partial<EventItem> = {}): FeedCardData {
  return {
    kind: "event",
    event: {
      id,
      name: `Event ${id}`,
      category: "music",
      starts_at: "2026-10-15T20:00:00Z",
      is_free: false,
      price_from: 12,
      currency: "GBP",
      image_url: null,
      ...over,
    } as unknown as EventItem,
  };
}

function find(h: Happening, fomoLevel: number): FindItem {
  return { id: `f-${h.id}`, why: "steal", fomoLevel, kind: "happening", happening: h };
}

test("no prefs and no saves is not personalised", () => {
  assert.equal(hasTaste(NO_PREFS, {}), false);
  assert.equal(hasTaste(NO_PREFS, { comedy: 1 }), true);
  const r = buildForYou({ finds: [], cards: [hapCard(happening("a"))], prefs: NO_PREFS, affinity: {}, now: NOW });
  assert.equal(r.personalised, false);
  assert.equal(r.moreTitle, "Popular this week");
});

test("taste beats one Fomo level, never two", () => {
  const comedy = happening("c", { category: "comedy" });
  const food = happening("f", { category: "food" });
  const loud = happening("l", { category: "food" });
  const prefs: BoostPrefs = { interests: ["comedy"], budget: "any", who: [] };
  const r = buildForYou({
    finds: [find(food, 4), find(comedy, 4), find(loud, 5), find(happening("c3", { category: "comedy" }), 3)],
    cards: [],
    prefs,
    affinity: {},
    now: NOW,
  });
  assert.deepEqual(
    r.picks.map((p) => p.find?.id),
    ["f-c", "f-l", "f-c3", "f-f"]
  );
  assert.equal(r.picks[0].reason, "You're into Comedy");
});

test("a Find the visitor can't use sinks to the bottom but stays", () => {
  const student = happening("s", { eligibility: "student", kind: "deal" });
  const open = happening("o");
  const prefs: BoostPrefs = { interests: [], budget: "any", who: ["residents"] };
  const r = buildForYou({ finds: [find(student, 5), find(open, 1)], cards: [], prefs, affinity: {}, now: NOW });
  assert.deepEqual(r.picks.map((p) => p.find?.id), ["f-o", "f-s"]);
});

test("more excludes Finds, duplicates, far-off and unusable cards", () => {
  const isFind = happening("x");
  const later = happening("later", { starts_at: "2026-10-30T19:00:00Z" });
  const student = happening("stu", { eligibility: "student", kind: "deal" });
  const ok = happening("ok");
  const prefs: BoostPrefs = { interests: [], budget: "any", who: ["residents"] };
  const r = buildForYou({
    finds: [find(isFind, 3)],
    cards: [hapCard(isFind), hapCard(ok), hapCard(ok), hapCard(later, "2026-10-30"), hapCard(student)],
    prefs,
    affinity: {},
    now: NOW,
  });
  assert.deepEqual(r.more.map((e) => e.key), ["happening:ok"]);
});

test("personalised more prefers matches, caps one interest, then tops up", () => {
  const comedy = Array.from({ length: 5 }, (_, i) => hapCard(happening(`c${i}`, { category: "comedy" })));
  const gigs = Array.from({ length: 3 }, (_, i) => eventCard(`g${i}`));
  const prefs: BoostPrefs = { interests: ["comedy"], budget: "any", who: [] };
  const r = buildForYou({ finds: [], cards: [...gigs, ...comedy], prefs, affinity: {}, now: NOW });
  assert.equal(r.moreTitle, "More for you");
  const comedyCount = r.more.filter((e) => e.key.startsWith("happening:c")).length;
  assert.equal(comedyCount, MAX_PER_INTEREST);
  // Only 3 matches (< MORE_MIN), so the gigs top the list up.
  assert.equal(r.more.length, MAX_PER_INTEREST + 3);
  assert.equal(r.more[0].reason, "You're into Comedy");
});

test("a visitor who answered 'Working' isn't recommended student-only offers", () => {
  const student = happening("stu", { eligibility: "student", kind: "deal" });
  const ok = happening("ok");
  const working: BoostPrefs = { interests: [], budget: "any", who: [] };
  const cards = [hapCard(student), hapCard(ok)];
  const unknown = buildForYou({ finds: [], cards, prefs: working, affinity: {}, now: NOW });
  assert.equal(unknown.more.length, 2);
  const known = buildForYou({ finds: [], cards, prefs: working, affinity: {}, whoKnown: true, now: NOW });
  assert.deepEqual(known.more.map((e) => e.key), ["happening:ok"]);
});

test("splits into Deals & offers then Events, and drops an empty group", () => {
  const deal = happening("d", { kind: "deal", saving_label: "2-for-1" });
  const gig = eventCard("g");
  const r = buildForYou({ finds: [find(deal, 4)], cards: [gig, hapCard(happening("t"))], prefs: NO_PREFS, affinity: {}, now: NOW });
  assert.deepEqual(r.groups.map((g) => g.title), ["Deals & offers", "Events"]);
  assert.deepEqual(r.groups[0].picks.map((e) => e.find?.id), ["f-d"]);
  assert.equal(r.groups[0].more.length, 0);
  assert.deepEqual(r.groups[1].more.map((e) => e.key).sort(), ["event:g", "happening:t"]);

  const eventsOnly = buildForYou({ finds: [], cards: [gig], prefs: NO_PREFS, affinity: {}, now: NOW });
  assert.deepEqual(eventsOnly.groups.map((g) => g.key), ["events"]);
});

test("I've got kids: kid-friendly cards get a reason and a boost, others none", () => {
  const kidsPrefs: BoostPrefs = { interests: [], budget: "any", who: ["families"], kids: true };
  const kid = hapCard(happening("k", { category: "family" }));
  const allAges = hapCard(happening("aa", { category: "museum", family_fit: "all_ages" }));
  const plain = hapCard(happening("p", { category: "comedy" }));
  assert.equal(hasTaste(kidsPrefs, {}), true);
  assert.equal(hasTaste({ ...kidsPrefs, who: [] }, {}), true);
  assert.equal(personalReason(kid, kidsPrefs, {}), "Good with kids");
  assert.equal(personalReason(allAges, kidsPrefs, {}), "Good with kids");
  assert.equal(personalReason(plain, kidsPrefs, {}), null);
  const r = buildForYou({ finds: [], cards: [plain, allAges, kid], prefs: kidsPrefs, affinity: {}, now: NOW });
  assert.deepEqual(r.more.map((e) => e.key), ["happening:k", "happening:aa", "happening:p"]);
  assert.equal(r.more.find((e) => e.key === "happening:k")?.reason, "Good with kids");
});
