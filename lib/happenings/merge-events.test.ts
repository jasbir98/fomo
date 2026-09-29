// Run: npx tsx --test lib/happenings/merge-events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventItem } from "@/lib/types";
import { dedupeProviderEvents } from "./merge-events";
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
