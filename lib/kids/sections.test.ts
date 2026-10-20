// Run with `npx tsx --test lib/kids/sections.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { event, happening } from "@/lib/finds/fixtures.test-util";
import type {
  DealCardData,
  EventCardData,
  FeedCardData,
  FeedResponse,
  FreeAnyTimeItem,
  HappeningCardData,
} from "@/lib/happenings/feed-types";
import type { Happening, Occurrence } from "@/lib/happenings/types";
import { flattenDeals, kidsComingUp, kidsDeals, kidsFreeAnyTime, selectKidsSections } from "@/lib/kids/sections";

// Wed 21 Oct 2026; the weekend is 24-25 Oct.
const TODAY = "2026-10-21";
const SAT = "2026-10-24";
const SUN = "2026-10-25";

const occ = (id: string, day: string): Occurrence => ({
  happeningId: id,
  dayDate: day,
  startsAt: null,
  endsAt: null,
  lastDayDate: day,
  seriesEndDayDate: null,
  exact: false,
});
const hCard = (h: Happening, day: string): HappeningCardData => ({ kind: "happening", happening: h, occurrence: occ(h.id, day) });
const kid = (id: string, day: string) => hCard(happening({ id, kind: "activity", category: "family" }), day);
const adult = (id: string, day: string) => hCard(happening({ id, kind: "activity", category: "music" }), day);
const kidEvent = (id: string, startsAt: string): EventCardData => ({
  kind: "event",
  event: event({ id, category: "family", starts_at: startsAt }),
});

const dealCard = (id: string, day: string, over: Partial<Happening> = {}, who: DealCardData["who"] = null): DealCardData => ({
  kind: "happening",
  happening: happening({ id, kind: "deal", ...over }),
  occurrence: occ(id, day),
  what: "food_drink",
  who,
});

function feed(over: { cards?: FeedCardData[]; deals?: DealCardData[]; free?: FreeAnyTimeItem[] }): FeedResponse {
  return {
    hero: null,
    whatsOn: [{ key: "coming_up", title: "x", meta: null, cards: over.cards ?? [] }],
    bookEarly: [],
    deals: { venueGroups: [], singles: over.deals ?? [] },
    freeAnyTime: over.free ?? [],
  } as FeedResponse;
}

const free = (id: string, familyFit: FreeAnyTimeItem["familyFit"]): FreeAnyTimeItem => ({
  kind: "place",
  id,
  name: id,
  description: null,
  imageUrl: null,
  locationLine: null,
  category: null,
  district: null,
  typeLabel: null,
  familyFit,
});

const ids = (cards: FeedCardData[]) =>
  cards.map((c) => (c.kind === "happening" ? c.happening.id : c.kind === "event" ? c.event.id : c.kind));

test("weekend: only kid-friendly cards on Saturday or Sunday", () => {
  const later = feed({ cards: [kid("sat", SAT), adult("sun-adult", SUN), kid("sun", SUN), kid("tue", "2026-10-27")] });
  const s = selectKidsSections(feed({}), later, TODAY, SAT, SUN);
  assert.deepEqual(ids(s.weekend), ["sat", "sun"]);
});

test("coming up: excludes the weekend, adult cards and anything past the lookahead; date order; each card once", () => {
  const now = feed({ cards: [kid("today", TODAY)] });
  const later = feed({
    cards: [
      kid("dec", "2026-12-21"),
      kid("sat", SAT),
      adult("adult", "2026-10-28"),
      kid("nov", "2026-11-02"),
      kid("today", TODAY),
      kid("oct27", "2026-10-27"),
    ],
  });
  assert.deepEqual(ids(kidsComingUp(now, later, TODAY, SAT, SUN)), ["today", "oct27", "nov"]);
});

test("coming up: lookahead is inclusive of day 31 and a longer one reaches further", () => {
  const later = feed({ cards: [kid("d31", "2026-11-21"), kid("d32", "2026-11-22")] });
  assert.deepEqual(ids(kidsComingUp(feed({}), later, TODAY, SAT, SUN)), ["d31"]);
  assert.deepEqual(ids(kidsComingUp(feed({}), later, TODAY, SAT, SUN, 40)), ["d31", "d32"]);
});

test("coming up: an event card counts when its category is family", () => {
  const later = feed({ cards: [kidEvent("e1", "2026-10-29T10:00:00Z")] });
  assert.deepEqual(ids(kidsComingUp(feed({}), later, TODAY, SAT, SUN)), ["e1"]);
});

test("deals: family eligibility first, then soonest; plain adult deals dropped; duplicates collapsed", () => {
  const later = feed({
    deals: [
      dealCard("adult", "2026-10-21"),
      dealCard("late-family", "2026-10-30", { eligibility: "family" }, "families"),
      dealCard("kid-fit", "2026-10-22", { category: "family" }),
      dealCard("early-family", "2026-10-22", { eligibility: "family" }, "families"),
      dealCard("early-family", "2026-10-22", { eligibility: "family" }, "families"),
    ],
  });
  assert.deepEqual(ids(kidsDeals(later.deals)), ["early-family", "late-family", "kid-fit"]);
});

test("deals: venue-group offers are included", () => {
  const deals: FeedResponse["deals"] = {
    venueGroups: [
      { placeId: "p1", placeName: "Cafe", placeImageUrl: null, district: null, offers: [dealCard("a", TODAY, { eligibility: "family" })] },
    ],
    singles: [dealCard("b", TODAY, { eligibility: "family" })],
  };
  assert.equal(flattenDeals(deals).length, 2);
  assert.equal(kidsDeals(deals).length, 2);
});

test("free any time: needs a family fit, kids ahead of all_ages", () => {
  const got = kidsFreeAnyTime([free("a", "all_ages"), free("b", null), free("c", "kids"), free("d", undefined)]);
  assert.deepEqual(got.map((i) => i.id), ["c", "a"]);
});

test("each section is capped but totals keep the full count; empty data gives empty sections", () => {
  const cards = Array.from({ length: 15 }, (_, i) => kid(`k${i}`, SAT));
  const s = selectKidsSections(feed({}), feed({ cards }), TODAY, SAT, SUN);
  assert.equal(s.weekend.length, 12);
  assert.equal(s.totals.weekend, 15);
  const empty = selectKidsSections(feed({}), feed({}), TODAY, SAT, SUN);
  assert.deepEqual(empty.totals, { weekend: 0, deals: 0, freeAnyTime: 0, comingUp: 0 });
});
