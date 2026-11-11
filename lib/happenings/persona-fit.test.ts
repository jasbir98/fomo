// Run: npx tsx --test lib/happenings/persona-fit.test.ts
// Lead-slot persona fit: fixtures modelled on the live rows seen on 11 Nov 2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening, Occurrence } from "./types";
import type { DealCardData, DealsSection, FeedCardData, FeedResponse, FreeAnyTimeItem } from "./feed-types";
import type { EventItem } from "@/lib/types";
import { leadMisfit, dealLeadPenalty } from "./audience";
import { dealLeadScore, dealStealScore } from "./deal-score";
import { eventRecommendationScore, happeningRecommendationScore, isHeroStealEvent, isHeroStealHappening, selectHeroPool } from "./hero";
import { todaysDeals } from "./today-deals";
import { freeAnyTimePenalty, isOneOffDated, rankFreeAnyTime } from "./free-any-time-rank";
import { isDescriptorVariantAtVenue, isTitleMatchAtVenue } from "./merge-events";
import { collapseSameVenueDuplicates, weekendCards } from "./weekend";
import { topPicks } from "@/lib/personalise/top-picks";
import type { BoostPrefs } from "@/lib/personalise/score";

const TZ = "Europe/London";
// Wed 11 Nov 2026, midday London.
const NOW = new Date("2026-11-11T12:00:00Z");
const PHOTO = "https://example.com/uploads/street-scene.jpg";
const NO_PREFS: BoostPrefs = { interests: [], budget: "any", who: [] };

function happening(id: string, over: Partial<Happening> = {}): Happening {
  return {
    id,
    title: id,
    summary: null,
    kind: "deal",
    category: "other",
    status: "live",
    eligibility: "anyone",
    is_free: false,
    saving_label: null,
    saving_amount: null,
    currency: "GBP",
    price_text: null,
    venue_name: null,
    source_name: "curated",
    starts_at: null,
    ends_at: null,
    recurrence: { type: "always" },
    image_url: PHOTO,
    verified_at: "2026-11-11T00:00:00Z",
    priority: 50,
    ...over,
  } as unknown as Happening;
}

function occ(id: string, dayDate = "2026-11-11", startsAt: string | null = null): Occurrence {
  return { happeningId: id, dayDate, startsAt, endsAt: null, lastDayDate: dayDate, seriesEndDayDate: null, exact: true };
}

function dealCard(id: string, over: Partial<Happening> = {}): DealCardData {
  const h = happening(id, over);
  return { kind: "happening", happening: h, occurrence: occ(id), what: "food_drink", who: null } as unknown as DealCardData;
}

function event(id: string, over: Partial<EventItem> = {}): EventItem {
  return {
    id,
    provider: "skiddle",
    provider_event_id: id,
    name: id,
    description: null,
    category: "music",
    image_url: PHOTO,
    ticket_url: null,
    starts_at: "2026-11-11T19:00:00Z",
    ends_at: null,
    venue_name: null,
    is_free: false,
    price_from: 8,
    currency: "GBP",
    ...over,
  } as unknown as EventItem;
}

const eventCard = (e: EventItem): FeedCardData => ({ kind: "event", event: e });

function happeningCard(id: string, over: Partial<Happening> = {}): FeedCardData {
  const h = happening(id, { kind: "event", recurrence: { type: "once" }, starts_at: "2026-11-11T19:00:00Z", ...over });
  return { kind: "happening", happening: h, occurrence: occ(id, "2026-11-11", h.starts_at) };
}

// ---- Fixtures modelled on the live rows -------------------------------------
const hotel = { title: "New Town Hotel stay with Prosecco and breakfast", saving_label: "66% off", venue_name: "The Balmoral" };
const hairCheynes = { title: "Student discount at Cheynes", saving_label: "20% off", venue_name: "Cheynes" };
const hairCharlie = { title: "Cut and blow dry", saving_label: "25% off", venue_name: "Charlie Miller" };
const britannia = { title: "Edinburgh resident discount", saving_label: "£11.50", venue_name: "Royal Yacht Britannia", eligibility: "local_resident" as const };
const dungeon = { title: "Resident ticket", saving_label: "30% off", venue_name: "The Edinburgh Dungeon", eligibility: "local_resident" as const };
const over60 = { title: "Edinburgh Trams Free Travel Over 60s", saving_label: "Free", eligibility: "over_60" as const };
const studentPint = { title: "£4 cask pints for students", saving_label: "£4 pints", venue_name: "Biddy Mulligans", eligibility: "student" as const };
const kink = { title: "The Psychology of Fetish & Kink", venue_name: "Summerhall" };

test("leadMisfit names the misfit for the live rows, and nothing for ordinary ones", () => {
  assert.equal(leadMisfit(hotel), "accommodation");
  assert.equal(leadMisfit(hairCheynes), "beauty");
  assert.equal(leadMisfit(hairCharlie), "beauty");
  assert.equal(leadMisfit(britannia), "attraction");
  assert.equal(leadMisfit(dungeon), "attraction");
  assert.equal(leadMisfit(kink), "sensitive");
  assert.equal(leadMisfit({ title: "Corporate team building night" }), "corporate");
  assert.equal(leadMisfit(studentPint), null);
  assert.equal(leadMisfit({ title: "Hair the musical", venue_name: "Edinburgh Playhouse" }), null);
  assert.equal(leadMisfit({ title: "The Barber of Seville" }), null);
  assert.equal(leadMisfit({ title: "Hotel bar cocktails £5", venue_name: "Hotel Missoni" }), null);
  // A free attraction is not an admission discount.
  assert.equal(leadMisfit({ title: "Edinburgh Castle open day", is_free: true }), null);
});

test("deal order: a student pint beats a hotel stay and two hairdressers despite a deeper discount", () => {
  const scores = [hotel, hairCheynes, hairCharlie].map((h) => dealLeadScore({ ...h, summary: null, priority: 50, recurrence: { type: "always" }, is_free: false, eligibility: "anyone" }));
  const pint = dealLeadScore({ ...studentPint, summary: null, priority: 50, recurrence: { type: "always" }, is_free: false });
  for (const s of scores) assert.ok(pint > s, `${pint} > ${s}`);
  // The plain steal score would have ranked the hotel above the pint: the demotion is what flips it.
  assert.ok(dealStealScore({ ...hotel, priority: 50, recurrence: { type: "always" } }) > dealStealScore({ ...studentPint, priority: 50, recurrence: { type: "always" } }) - 1);
});

test("resident and over-60 offers are marked down by default, and a matching stored profile removes it", () => {
  const base = { summary: null, venue_name: null, priority: 50, recurrence: { type: "always" } as const, is_free: false };
  assert.equal(dealLeadPenalty({ ...base, ...britannia, description: null }, []), 20); // attraction; resident 15 does not stack
  const residentOnly = { title: "Resident day", saving_label: "50% off", eligibility: "local_resident" as const };
  assert.equal(dealLeadPenalty(residentOnly, []), 15);
  assert.equal(dealLeadPenalty(residentOnly, ["residents"]), 0);
  assert.equal(dealLeadPenalty({ ...over60 }, []), 20); // niche "older"
  assert.equal(dealLeadPenalty({ ...over60 }, ["over_60"]), 15 - 15); // eligibility and niche both cleared
  assert.equal(dealLeadPenalty({ title: "Family ticket", eligibility: "family" }, []), 15);
  assert.equal(dealLeadPenalty({ title: "Family ticket", eligibility: "family" }, ["families"]), 0);
  // Students and under-26s are the audience: never marked down.
  assert.equal(dealLeadPenalty({ title: "Student night", eligibility: "student" }, []), 0);
  assert.equal(dealLeadPenalty({ title: "Under 26 price", eligibility: "under_26" }, []), 0);
  const a = dealLeadScore({ ...residentOnly, ...base }, []);
  const b = dealLeadScore({ ...residentOnly, ...base }, ["residents"]);
  assert.ok(b > a);
});

test("Today's deals: hotel, hairdressers and attraction offers don't lead, but come back when the day is thin", () => {
  const mon: Happening["recurrence"] = { type: "weekly", days: [3] }; // Wed
  const cards = [
    dealCard("hotel", { ...hotel, recurrence: mon }),
    dealCard("cheynes", { ...hairCheynes, recurrence: mon }),
    dealCard("britannia", { ...britannia, recurrence: mon }),
    dealCard("pint", { ...studentPint, recurrence: mon }),
    dealCard("twofor1", { title: "2 for 1 burgers", saving_label: "2 for 1", venue_name: "Local Burger", recurrence: mon }),
    dealCard("cocktail", { title: "£5 cocktails", saving_label: "£5 cocktails", venue_name: "Bar One", recurrence: mon }),
  ];
  const section: DealsSection = { venueGroups: [], singles: cards };
  const ids = (list: ReturnType<typeof todaysDeals>) => list.map((i) => (i.kind === "single" ? i.card.happening.id : "group"));
  const withFits = ids(todaysDeals(section, NOW, { timeZone: TZ, limit: 3 }));
  assert.equal(withFits.length, 3);
  for (const bad of ["hotel", "cheynes", "britannia"]) assert.ok(!withFits.includes(bad), `${bad} should not be in the first three`);
  // A thin day still shows them: limit 6 takes everything.
  const all = ids(todaysDeals(section, NOW, { timeZone: TZ, limit: 6 }));
  assert.equal(all.length, 6);
  for (const bad of ["hotel", "cheynes", "britannia"]) assert.ok(all.indexOf(bad) >= 3, `${bad} ranks after the fits`);
  // A resident's own offer is not demoted for a known resident.
  const resident = dealCard("resident", { title: "Resident day", saving_label: "50% off", eligibility: "local_resident", recurrence: mon });
  const mixed: DealsSection = { venueGroups: [], singles: [resident, ...cards.slice(3)] };
  const anon = ids(todaysDeals(mixed, NOW, { timeZone: TZ, limit: 3 }));
  const known = ids(todaysDeals(mixed, NOW, { timeZone: TZ, limit: 3, who: ["residents"] }));
  assert.ok(!anon.includes("resident"));
  assert.ok(known.includes("resident"));
});

// ---- Hero -------------------------------------------------------------------

test("hero: adult-themed events and hotel deals are scored far below an ordinary free one", () => {
  const free = happeningRecommendationScore(happening("free", { kind: "activity", is_free: true, title: "Free comedy night" }), occ("free"), NOW, TZ).score;
  const talk = happeningRecommendationScore(happening("talk", { kind: "event", is_free: true, title: kink.title, venue_name: kink.venue_name }), occ("talk"), NOW, TZ).score;
  const stay = happeningRecommendationScore(happening("stay", { ...hotel, kind: "deal", is_free: false }), occ("stay"), NOW, TZ).score;
  assert.ok(free - talk >= 60, `${free} vs ${talk}`);
  assert.ok(free > stay);
  const evFree = eventRecommendationScore(event("e1", { name: "Quiz", is_free: true, price_from: null }), NOW, TZ).score;
  const evKink = eventRecommendationScore(event("e2", { name: kink.title, is_free: true, price_from: null }), NOW, TZ).score;
  assert.equal(evFree - evKink, 60);
});

test("hero reasons carry the actual reason: price, start time, student price", () => {
  const free = eventRecommendationScore(event("a", { is_free: true, price_from: null, starts_at: "2026-11-11T18:15:00Z" }), NOW, TZ);
  assert.equal(free.reason, "Free · starts 18:15");
  const quid = eventRecommendationScore(event("b", { price_from: 1, starts_at: "2026-11-11T20:00:00Z" }), NOW, TZ);
  assert.equal(quid.reason, "£1 tickets · starts 20:00");
  const student = happeningRecommendationScore(happening("c", { ...studentPint, is_free: false }), occ("c"), NOW, TZ);
  assert.ok(student.reason?.includes("Student price"), String(student.reason));
  const plain = happeningRecommendationScore(happening("d", { kind: "event", recurrence: { type: "once" }, priority: 50 }), occ("d", "2026-11-25"), NOW, TZ);
  assert.equal(plain.reason, null);
});

test("hero pool: a £12.50 gig loses to a free or under-£10 listing, and is used only when nothing qualifies", () => {
  const gig = event("gig", { price_from: 12.5 });
  const cheap = event("cheap", { price_from: 7 });
  assert.equal(isHeroStealEvent(gig), false);
  assert.equal(isHeroStealEvent(cheap), true);
  assert.equal(isHeroStealEvent(event("f", { is_free: true, price_from: null })), true);
  const mk = (name: string, steal: boolean) => ({ name, steal, everyday: false, photo: true });
  assert.deepEqual(selectHeroPool([mk("gig", false), mk("cheap", true)]).map((c) => c.name), ["cheap"]);
  assert.deepEqual(selectHeroPool([mk("gig", false), mk("other", false)]).map((c) => c.name), ["gig", "other"]);
  // Steal beats photo; everyday never leads while anything else exists.
  const pool = selectHeroPool([
    { name: "everyday", steal: true, everyday: true, photo: true },
    { name: "nophoto-steal", steal: true, everyday: false, photo: false },
    { name: "photo-pricey", steal: false, everyday: false, photo: true },
  ]);
  assert.deepEqual(pool.map((c) => c.name), ["nophoto-steal"]);
});

test("hero steal for happenings: free, nominal or stated under £10; a 66% hotel deal and £11.50 admission are not", () => {
  const base = { price_text: null, saving_label: null, is_free: false };
  assert.equal(isHeroStealHappening({ ...base, kind: "event", title: "Gig", is_free: true }), true);
  assert.equal(isHeroStealHappening({ ...base, kind: "activity", title: "Parkrun" }), true);
  assert.equal(isHeroStealHappening({ ...base, kind: "deal", title: "Burger night £6" }), true);
  assert.equal(isHeroStealHappening({ ...base, kind: "deal", title: hotel.title, saving_label: hotel.saving_label }), false);
  assert.equal(isHeroStealHappening({ ...base, kind: "deal", title: britannia.title, saving_label: "£11.50" }), false);
  assert.equal(isHeroStealHappening({ ...base, kind: "deal", title: "£5 off a £30 meal" }), false);
});

// ---- Top picks ----------------------------------------------------------------

test("Top picks: one card per venue, no adult-themed talk, no tautological reasons", () => {
  const jazz = (id: string, price: number) => eventCard(event(id, { name: `Jazz night ${id}`, venue_name: "The Jazz Bar", price_from: price, description: "An event at The Jazz Bar" }));
  const cards: FeedCardData[] = [
    jazz("j1", 1),
    jazz("j2", 1),
    jazz("j3", 1),
    eventCard(event("kink", { name: kink.title, venue_name: "Summerhall", is_free: true, price_from: null })),
    eventCard(event("quiz", { name: "Pub quiz", venue_name: "Biddy Mulligans", is_free: true, price_from: null, starts_at: "2026-11-11T20:00:00Z" })),
    eventCard(event("comedy", { name: "Free comedy", venue_name: "The Stand", is_free: true, price_from: null, starts_at: "2026-11-11T19:30:00Z", provider: "ticketmaster" })),
    eventCard(event("ceilidh", { name: "Ceilidh", venue_name: "Assembly Rooms", price_from: 5, provider: "ticketmaster" })),
    eventCard(event("gig", { name: "Gig", venue_name: "Sneaky Petes", price_from: 6, provider: "songkick" })),
    eventCard(event("film", { name: "Film night", venue_name: "Filmhouse", price_from: 7, provider: "songkick" })),
  ];
  const { picks, rest } = topPicks(cards, { prefs: NO_PREFS, now: NOW, timeZone: TZ });
  const names = picks.map((p) => (p.card.kind === "event" ? p.card.event.name : "?"));
  assert.equal(picks.length, 5);
  assert.equal(names.filter((n) => n.startsWith("Jazz night")).length, 1);
  assert.ok(!names.includes(kink.title));
  // Nothing is dropped: the other Jazz Bar rows and the kink talk are in `rest`.
  assert.equal(rest.length, cards.length - 5);
  for (const p of picks) {
    assert.ok(!p.reason || !/^an? .* at /i.test(p.reason), String(p.reason));
    assert.ok(!p.reason || !/^from £/i.test(p.reason), String(p.reason));
  }
  const quiz = picks.find((p) => p.card.kind === "event" && p.card.event.name === "Pub quiz");
  assert.equal(quiz?.reason, "Free · starts 20:00");
});

test("Top picks: at most two per source, and the venue cap still lets a short list fill", () => {
  const cards = ["a", "b", "c", "d"].map((id, i) => eventCard(event(id, { name: id, venue_name: `Venue ${id}`, provider: i < 3 ? "skiddle" : "songkick", price_from: 5 })));
  const { picks } = topPicks(cards, { prefs: NO_PREFS, now: NOW, timeZone: TZ, count: 3 });
  const providers = picks.map((p) => (p.card.kind === "event" ? p.card.event.provider : ""));
  assert.ok(providers.filter((p) => p === "skiddle").length <= 2);
  // Only one venue available: the section still fills rather than shrinking to one card.
  const same = ["x", "y", "z"].map((id) => eventCard(event(id, { name: id, venue_name: "The Jazz Bar" })));
  assert.equal(topPicks(same, { prefs: NO_PREFS, now: NOW, timeZone: TZ }).picks.length, 3);
});

// ---- Free any time ---------------------------------------------------------------

function freeItem(name: string, description: string | null = null): FreeAnyTimeItem {
  return { kind: "happening", id: name, name, description, imageUrl: null, locationLine: null, category: null, district: null, typeLabel: null };
}

test("Free any time: one-off dated talks leave, tip-based tours and age-restricted entitlements sink", () => {
  const items = [
    freeItem("Edinburgh Free Walking Tour", "Tip-based tour of the Old Town"),
    freeItem("Edinburgh Trams Free Travel Over 60s"),
    freeItem("Beth Simone Noveck: Civic University", "Public talk on 18 November 2026"),
    freeItem("National Galleries Free Entry for Under-18s"),
    freeItem("National Museum of Scotland", "Free entry, open daily 10am to 5pm"),
    freeItem("Arthur's Seat", "Open all year"),
    freeItem("Open Mic Night - Thursday, 26th November"),
  ];
  const ranked = rankFreeAnyTime(items).map((i) => i.name);
  assert.deepEqual(ranked.slice(0, 2), ["National Museum of Scotland", "Arthur's Seat"]);
  assert.ok(!ranked.includes("Beth Simone Noveck: Civic University"));
  assert.ok(!ranked.includes("Open Mic Night - Thursday, 26th November"));
  assert.deepEqual(ranked.slice(2).sort(), ["Edinburgh Free Walking Tour", "Edinburgh Trams Free Travel Over 60s", "National Galleries Free Entry for Under-18s"].sort());
  // Kept in the list, just lower.
  assert.equal(ranked.length, 5);
  assert.equal(freeAnyTimePenalty(freeItem("Dean Village")), 0);
  assert.equal(isOneOffDated("Botanic Gardens", "Open 1 April to 30 September"), false);
});

// ---- Weekend duplicates ---------------------------------------------------------

test("weekend: 'Big Cheese Student Club Night' and 'Big Cheese' at Potterrow collapse to one", () => {
  const a = eventCard(event("bc1", { name: "Big Cheese Student Club Night", venue_name: "Potterrow", starts_at: "2026-11-14T22:00:00Z", image_url: null }));
  const b = eventCard(event("bc2", { name: "Big Cheese", venue_name: "Potterrow", starts_at: "2026-11-14T22:30:00Z" }));
  const out = collapseSameVenueDuplicates([a, b]);
  assert.equal(out.length, 1);
  // The copy with a photo wins.
  assert.equal(out[0].kind === "event" && out[0].event.id, "bc2");
  // Across a happening and an event too.
  const h = happeningCard("bch", { title: "Big Cheese", venue_name: "Potterrow", starts_at: "2026-11-14T22:00:00Z" });
  const mixed = [h, a].map((c) => (c.kind === "happening" ? { ...c, occurrence: { ...c.occurrence, dayDate: "2026-11-14" } } : c));
  assert.equal(collapseSameVenueDuplicates(mixed as FeedCardData[]).length, 1);
});

test("weekend: different events at one venue are never merged", () => {
  const venue = "The Stand";
  const mk = (id: string, name: string, startsAt = "2026-11-14T20:00:00Z") => eventCard(event(id, { name, venue_name: venue, starts_at: startsAt }));
  const pairs: [FeedCardData, FeedCardData][] = [
    [mk("1", "Comedy Night"), mk("2", "Quiz Night")],
    [mk("3", "Late Show"), mk("4", "Late Show Matinee", "2026-11-14T13:00:00Z")],
    [mk("5", "Big Cheese", "2026-11-14T13:00:00Z"), mk("6", "Big Cheese Student Club Night", "2026-11-14T22:00:00Z")], // matinee vs night, > 3h apart
    [mk("7", "Quiz"), mk("8", "Quiz Night")], // one-word title is never absorbed
    [mk("9", "Ceilidh"), mk("10", "Ceilidh with Rob Roy")], // extra words that name something else
  ];
  for (const [a, b] of pairs) assert.equal(collapseSameVenueDuplicates([a, b]).length, 2, `${JSON.stringify([a, b].map((c) => c.kind === "event" && c.event.name))}`);
  // Same title at two venues stays two.
  const x = eventCard(event("v1", { name: "Big Cheese", venue_name: "Potterrow" }));
  const y = eventCard(event("v2", { name: "Big Cheese Student Club Night", venue_name: "The Liquid Room" }));
  assert.equal(collapseSameVenueDuplicates([x, y]).length, 2);
});

test("weekendCards applies the collapse after the window merge", () => {
  const resp = (cards: FeedCardData[]) => ({ whatsOn: [{ cards }] }) as unknown as FeedResponse;
  const a = eventCard(event("bc1", { name: "Big Cheese Student Club Night", venue_name: "Potterrow", starts_at: "2026-11-14T22:00:00Z" }));
  const b = eventCard(event("bc2", { name: "Big Cheese", venue_name: "Potterrow", starts_at: "2026-11-14T22:00:00Z" }));
  const out = weekendCards(resp([a]), resp([b]), "2026-11-14", "2026-11-15");
  assert.equal(out.length, 1);
});

test("descriptor-variant title rule", () => {
  assert.equal(isDescriptorVariantAtVenue("Big Cheese", "Potterrow", "Big Cheese Student Club Night", "Potterrow"), true);
  assert.equal(isTitleMatchAtVenue("Big Cheese", "Potterrow", "Big Cheese Student Club Night", "Potterrow"), true);
  assert.equal(isDescriptorVariantAtVenue("Big Cheese", "Potterrow", "Big Cheese", "Potterrow"), false);
  assert.equal(isDescriptorVariantAtVenue("Comedy Club", "The Stand", "Comedy Club Kids Matinee", "The Stand"), false);
});

// ---- False-positive guards (review of fd77057) -----------------------------------

test("age gates and show titles are not adult-themed", () => {
  assert.equal(leadMisfit({ title: "Big Cheese Student Club Night 18+", venue_name: "Potterrow" }), null);
  assert.equal(leadMisfit({ title: "Indie gig 18+", description: "Doors 7pm. 18+ only, ID required." }), null);
  assert.equal(leadMisfit({ title: "The Kinks tribute night" }), null);
  assert.equal(leadMisfit({ title: "Kinky Boots" }), null);
  assert.equal(leadMisfit({ title: "Swingers (1996) screening" }), null);
  assert.equal(leadMisfit({ title: "Adults only burlesque brunch" }), "sensitive");
  assert.equal(leadMisfit({ title: "Talk", description: "An evening on kink and consent" }), "sensitive");
});

test("attraction misfit: £1 under-26 and student entry is a steal, a resident offer still is demoted", () => {
  const castle = { title: "Edinburgh Castle £1 entry", saving_label: "£1", venue_name: "Edinburgh Castle" };
  assert.equal(leadMisfit({ ...castle, eligibility: "under_26" }), null);
  assert.equal(leadMisfit({ ...castle, eligibility: "student" }), null);
  assert.equal(leadMisfit({ ...castle, eligibility: "anyone" }), "attraction");
  assert.equal(leadMisfit({ ...britannia }), "attraction");
  // Only the attraction rule is exempt: a student-priced haircut or hotel stay is still demoted.
  assert.equal(leadMisfit({ ...hairCheynes, eligibility: "student" }), "beauty");
  assert.equal(leadMisfit({ ...hotel, eligibility: "student" }), "accommodation");
  assert.equal(leadMisfit({ title: "Traverse £1 tickets", venue_name: "Traverse Theatre", eligibility: "under_26" }), null);
});

test("beauty and salon only match treatments and businesses", () => {
  for (const title of ["Sleeping Beauty", "Beauty and the Beast", "Literary Salon", "Hammer and Nails (band)", "Whiplash", "Waxing Lyrical", "The Barbers", "Spa Town Blues"]) {
    assert.equal(leadMisfit({ title }), null, title);
  }
  assert.equal(leadMisfit({ title: "Cheynes Hairdressing 25% off cut and colour" }), "beauty");
  assert.equal(leadMisfit({ title: "Beauty salon student offer" }), "beauty");
  assert.equal(leadMisfit({ title: "Nail bar 2 for 1" }), "beauty");
  assert.equal(leadMisfit({ title: "Spa day for two" }), "beauty");
  assert.equal(leadMisfit({ title: "Brazilian waxing deal" }), "beauty");
});

test("accommodation needs a stay word: a hostel quiz night or a hotel escape room is not a hotel deal", () => {
  assert.equal(leadMisfit({ title: "Quiz Night", venue_name: "Safestay Hostel" }), null);
  assert.equal(leadMisfit({ title: "Escape room", venue_name: "Hotel Missoni" }), null);
  assert.equal(leadMisfit({ title: "Three Nights of Jazz", venue_name: "The Jazz Bar" }), null);
  assert.equal(leadMisfit({ title: "Two nights Fringe comedy showcase" }), null);
  assert.equal(leadMisfit({ title: "2 nights hotel stay with breakfast" }), "accommodation");
  assert.equal(leadMisfit({ title: "Weekend package", venue_name: "Apex Hotel" }), "accommodation");
});

test("youth rule does not catch artists called Junior or Teens", () => {
  assert.equal(leadMisfit({ title: "Junior Brother live" }), null);
  assert.equal(dealLeadPenalty({ title: "Junior Boys gig", eligibility: "anyone" }, []), 0);
  assert.equal(dealLeadPenalty({ title: "Teen Spirit: a Nirvana tribute", eligibility: "anyone" }, []), 0);
  assert.equal(dealLeadPenalty({ title: "Free entry for Under-18s", eligibility: "anyone" }, []), 20);
  assert.equal(dealLeadPenalty({ title: "Junior ticket half price", eligibility: "anyone" }, []), 20);
});
