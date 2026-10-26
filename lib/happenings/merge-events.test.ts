// Run: npx tsx --test lib/happenings/merge-events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventItem } from "@/lib/types";
import type { HappeningCardData } from "./feed-types";
import type { Happening } from "./types";
import { dedupeHappenings, dedupeProviderEvents, isTitleMatch, mergeProviderEventsIntoCards } from "./merge-events";
import { normalizeEventTitle, normalizeVenueKey } from "@/lib/events/identity";

const TZ = "Europe/London";

function ev(over: Partial<EventItem> & Pick<EventItem, "id" | "provider" | "name" | "starts_at">): EventItem {
  return {
    provider_event_id: over.id,
    description: null,
    category: "music",
    image_url: null,
    ticket_url: null,
    ends_at: null,
    venue_name: "Edinburgh Corn Exchange",
    address: null,
    lat: null,
    lng: null,
    city: "Edinburgh",
    country: "GB",
    is_free: null,
    price_from: null,
    currency: null,
    destination: null,
    place_id: null,
    source: null,
    fetched_at: null,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

test("normalizeEventTitle strips venue suffixes", () => {
  assert.equal(normalizeEventTitle("Don Broco @ Edinburgh Corn Exchange"), "don broco");
  assert.equal(normalizeEventTitle("Walter Trout // Edinburgh Queens Hall"), "walter trout");
  assert.equal(normalizeEventTitle("Angèle - Edinburgh"), "angele");
  assert.equal(normalizeEventTitle("Foo at the Usher Hall", "Usher Hall"), "foo");
});

test("normalizeVenueKey folds the/edinburgh and flags missing", () => {
  assert.equal(normalizeVenueKey("The Queen's Hall"), normalizeVenueKey("Queen's Hall, Edinburgh"));
  assert.equal(normalizeVenueKey(null), "?");
  assert.equal(normalizeVenueKey("Edinburgh"), "?");
});

test("Don Broco songkick + ticketmaster pair collapses to one", () => {
  const songkick = ev({
    id: "sk",
    provider: "songkick",
    name: "Don Broco @ Edinburgh Corn Exchange",
    starts_at: "2026-10-01T19:00:00Z",
  });
  const tm = ev({ id: "tm", provider: "ticketmaster", name: "Don Broco", starts_at: "2026-10-01T18:00:00Z" });
  const out = dedupeProviderEvents([songkick, tm], TZ);
  assert.equal(out.length, 1);
  // Neither has price/image; ticketmaster outranks songkick.
  assert.equal(out[0].id, "tm");
});

test("price beats image beats provider priority; earliest start is the last tiebreak", () => {
  const base = { name: "Some Band", starts_at: "2026-10-01T19:00:00Z" };
  const priced = ev({ id: "a", provider: "allevents", ...base, price_from: 15 });
  const imaged = ev({ id: "b", provider: "ticketmaster", ...base, image_url: "https://x/y.jpg" });
  assert.equal(dedupeProviderEvents([imaged, priced], TZ)[0].id, "a");

  const imagedLow = ev({ id: "c", provider: "allevents", ...base, image_url: "https://x/y.jpg" });
  const plainHigh = ev({ id: "d", provider: "ticketmaster", ...base });
  assert.equal(dedupeProviderEvents([plainHigh, imagedLow], TZ)[0].id, "c");

  const early = ev({ id: "e", provider: "skiddle", name: "Some Band", starts_at: "2026-10-01T18:30:00Z" });
  const late = ev({ id: "f", provider: "ticketmaster", name: "Some Band", starts_at: "2026-10-01T19:30:00Z" });
  assert.equal(dedupeProviderEvents([late, early], TZ)[0].id, "e");
});

test("matinee and evening show at the same venue stay separate", () => {
  const matinee = ev({ id: "m", provider: "ticketmaster", name: "The Lion King", starts_at: "2026-10-03T13:00:00Z" });
  const evening = ev({ id: "n", provider: "skiddle", name: "The Lion King @ Edinburgh Corn Exchange", starts_at: "2026-10-03T18:30:00Z" });
  assert.equal(dedupeProviderEvents([matinee, evening], TZ).length, 2);
});

test("two different acts at the same venue on the same night stay separate", () => {
  const a = ev({ id: "a", provider: "ticketmaster", name: "Don Broco", starts_at: "2026-10-01T18:00:00Z" });
  const b = ev({ id: "b", provider: "songkick", name: "Enter Shikari @ Edinburgh Corn Exchange", starts_at: "2026-10-01T19:00:00Z" });
  assert.equal(dedupeProviderEvents([a, b], TZ).length, 2);
});

test("same title, same night, different venues stay separate", () => {
  const a = ev({ id: "a", provider: "ticketmaster", name: "Comedy Night", starts_at: "2026-10-01T19:00:00Z", venue_name: "The Stand" });
  const b = ev({ id: "b", provider: "skiddle", name: "Comedy Night", starts_at: "2026-10-01T19:00:00Z", venue_name: "Monkey Barrel" });
  assert.equal(dedupeProviderEvents([a, b], TZ).length, 2);
});

test("missing venue on one row falls back to title + day + 3h guard", () => {
  const a = ev({ id: "a", provider: "ticketmaster", name: "Don Broco", starts_at: "2026-10-01T18:00:00Z" });
  const b = ev({ id: "b", provider: "songkick", name: "Don Broco", starts_at: "2026-10-01T19:00:00Z", venue_name: null });
  assert.equal(dedupeProviderEvents([a, b], TZ).length, 1);
  const far = ev({ id: "c", provider: "songkick", name: "Don Broco", starts_at: "2026-10-01T22:30:00Z", venue_name: null });
  assert.equal(dedupeProviderEvents([a, far], TZ).length, 2);
});

test("different local days stay separate; order of first appearance preserved", () => {
  const a = ev({ id: "a", provider: "ticketmaster", name: "Don Broco", starts_at: "2026-10-01T18:00:00Z" });
  const other = ev({ id: "o", provider: "skiddle", name: "Quiz", starts_at: "2026-10-02T18:00:00Z", venue_name: "Bar" });
  const b = ev({ id: "b", provider: "songkick", name: "Don Broco @ Edinburgh Corn Exchange", starts_at: "2026-10-02T18:00:00Z" });
  const out = dedupeProviderEvents([a, other, b], TZ);
  assert.deepEqual(out.map((e) => e.id), ["a", "o", "b"]);
});

function hap(over: Partial<Happening> & Pick<Happening, "id" | "title">): Happening {
  return {
    slug: over.id,
    summary: null,
    kind: "event",
    category: "music",
    scope: "venue",
    is_free: null,
    eligibility: "anyone",
    starts_at: null,
    ends_at: null,
    recurrence: { type: "once" },
    venue_name: "Usher Hall",
    image_url: null,
    booking_url: null,
    place_id: null,
    lat: null,
    lng: null,
    source_name: "Ticketmaster",
    source_url: "https://example.com",
    verified_at: "2026-10-01T00:00:00Z",
    status: "live",
    ...over,
  } as Happening;
}

const NOW = new Date("2026-10-26T09:00:00Z");

test("Alison Moyet: curated 'at Usher Hall' card absorbs the Ticketmaster event", () => {
  const h = hap({ id: "h", title: "Alison Moyet at Usher Hall", starts_at: "2026-10-26T00:00:00+00:00", source_name: "Ticketmaster UK" });
  const card: HappeningCardData = {
    kind: "happening",
    happening: h,
    occurrence: { happeningId: "h", dayDate: "2026-10-26", startsAt: h.starts_at, endsAt: null, lastDayDate: "2026-10-26", seriesEndDayDate: "2026-10-26", exact: true },
  };
  const tm = ev({ id: "tm", provider: "ticketmaster", name: "Alison Moyet", venue_name: "Usher Hall", starts_at: "2026-10-26T19:00:00Z", ticket_url: "https://tm/1" });
  // Raw titles miss (Jaccard 0.5); the venue-stripped retry catches it.
  assert.equal(isTitleMatch(h.title, tm.name), false);
  const { cards, unmatchedEvents } = mergeProviderEventsIntoCards([card], [tm], TZ);
  assert.equal(unmatchedEvents.length, 0);
  assert.equal((cards[0] as HappeningCardData).happening.booking_url, "https://tm/1");
});

test("venue-stripped match needs the same venue", () => {
  const h = hap({ id: "h", title: "Alison Moyet at Usher Hall", starts_at: "2026-10-26T00:00:00+00:00" });
  const card: HappeningCardData = {
    kind: "happening",
    happening: h,
    occurrence: { happeningId: "h", dayDate: "2026-10-26", startsAt: h.starts_at, endsAt: null, lastDayDate: "2026-10-26", seriesEndDayDate: "2026-10-26", exact: true },
  };
  const elsewhere = ev({ id: "tm", provider: "ticketmaster", name: "Alison Moyet", venue_name: "Eden Court Theatre", starts_at: "2026-10-26T19:00:00Z" });
  assert.equal(mergeProviderEventsIntoCards([card], [elsewhere], TZ).unmatchedEvents.length, 1);
});

test("dedupeHappenings: Classic Rock Show twice at the Usher Hall, keeps the one with a real time", () => {
  const uk = hap({ id: "uk", title: "The Classic Rock Show", starts_at: "2027-01-21T00:00:00+00:00", source_name: "Ticketmaster UK" });
  const tm = hap({ id: "tm", title: "The Classic Rock Show at Usher Hall", starts_at: "2027-01-21T19:00:00+00:00", booking_url: null });
  const withLink = { ...uk, booking_url: "https://tm/uk" };
  const out = dedupeHappenings([withLink, tm], NOW, TZ);
  assert.deepEqual(out.map((h) => h.id), ["tm"]);
  // The survivor borrows the dropped copy's booking link.
  assert.equal(out[0].booking_url, "https://tm/uk");
});

test("dedupeHappenings: Hogmanay festival rows with loose venues collapse; year ranges ignored", () => {
  const a = hap({ id: "a", kind: "festival", title: "Edinburgh's Hogmanay 2026/27", venue_name: "West Princes Street Gardens / Edinburgh city centre", starts_at: "2026-12-29T00:00:00+00:00", ends_at: "2027-01-01T00:00:00+00:00", recurrence: { type: "annual", month: 12, day: 29, endDay: 31 }, image_url: "https://img" });
  const b = hap({ id: "b", kind: "festival", title: "Edinburgh's Hogmanay", venue_name: "Various city centre venues", starts_at: "2026-12-29T00:00:00+00:00", ends_at: "2027-01-01T00:00:00+00:00", recurrence: { type: "annual", month: 12, day: 29 } });
  assert.deepEqual(dedupeHappenings([b, a], NOW, TZ).map((h) => h.id), ["a"]);
});

test("dedupeHappenings: different shows, different venues, weekly line-ups and matinees stay apart", () => {
  const early = hap({ id: "e", title: "The Early Saturday Show at The Stand", venue_name: "The Stand", recurrence: { type: "weekly", days: [6] } });
  const late = hap({ id: "l", title: "The Saturday Show at The Stand", venue_name: "The Stand", recurrence: { type: "weekly", days: [6] } });
  assert.equal(dedupeHappenings([early, late], NOW, TZ).length, 2);

  const oneOffEarly = hap({ id: "e1", title: "The Early Show", starts_at: "2026-11-07T18:00:00Z" });
  const oneOffLate = hap({ id: "l1", title: "The Show", starts_at: "2026-11-07T18:00:00Z" });
  assert.equal(dedupeHappenings([oneOffEarly, oneOffLate], NOW, TZ).length, 2);

  const usher = hap({ id: "u", title: "Mogwai", starts_at: "2026-11-07T19:00:00Z" });
  const queens = hap({ id: "q", title: "Mogwai", venue_name: "The Queen's Hall", starts_at: "2026-11-07T19:00:00Z" });
  assert.equal(dedupeHappenings([usher, queens], NOW, TZ).length, 2);

  const matinee = hap({ id: "m", title: "Nutcracker", starts_at: "2026-12-12T14:00:00Z" });
  const evening = hap({ id: "n", title: "Nutcracker", starts_at: "2026-12-12T19:30:00Z" });
  assert.equal(dedupeHappenings([matinee, evening], NOW, TZ).length, 2);

  const deal1 = hap({ id: "d1", kind: "deal", title: "Student tickets", starts_at: "2026-11-07T19:00:00Z" });
  const deal2 = hap({ id: "d2", kind: "deal", title: "Student tickets", starts_at: "2026-11-07T19:00:00Z" });
  assert.equal(dedupeHappenings([deal1, deal2], NOW, TZ).length, 2);
});
