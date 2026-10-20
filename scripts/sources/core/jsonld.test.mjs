import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressFromLocation,
  canonicalUrl,
  extractJsonLdBlocks,
  isoFromJsonLd,
  iterJsonObjects,
  mapJsonLdEvent,
  parsePrice,
  pickImage,
} from "./jsonld.mjs";

test("isoFromJsonLd: date-only becomes UTC midnight / end of day", () => {
  assert.equal(isoFromJsonLd("2026-10-10"), "2026-10-10T00:00:00+00:00");
  assert.equal(isoFromJsonLd("2026-10-10", { end: true }), "2026-10-10T23:59:59+00:00");
});

test("isoFromJsonLd: explicit offset / Z is passed through untouched", () => {
  assert.equal(isoFromJsonLd("2026-10-10T19:00:00+01:00"), "2026-10-10T19:00:00+01:00");
  assert.equal(isoFromJsonLd("2026-10-10T19:00:00Z"), "2026-10-10T19:00:00Z");
});

test("isoFromJsonLd: no offset is Europe/London wall time (BST and GMT)", () => {
  assert.equal(isoFromJsonLd("2026-10-10T19:00:00"), "2026-10-10T18:00:00.000Z"); // BST
  assert.equal(isoFromJsonLd("2026-01-10T19:00"), "2026-01-10T19:00:00.000Z"); // GMT
});

test("isoFromJsonLd: junk gives null", () => {
  assert.equal(isoFromJsonLd(""), null);
  assert.equal(isoFromJsonLd(undefined), null);
  assert.equal(isoFromJsonLd(12345), null);
  assert.equal(isoFromJsonLd("next tuesday"), null);
});

test("parsePrice: free flag, offers array, lowPrice, zero, junk", () => {
  assert.deepEqual(parsePrice({ isAccessibleForFree: true }), { isFree: true, priceFrom: 0, currency: null });
  assert.deepEqual(parsePrice({ offers: { price: "12.50", priceCurrency: "GBP" } }), { isFree: false, priceFrom: 12.5, currency: "GBP" });
  assert.deepEqual(parsePrice({ offers: [{ lowPrice: 8, priceCurrency: "GBP" }] }), { isFree: false, priceFrom: 8, currency: "GBP" });
  assert.deepEqual(parsePrice({ offers: { price: 5, priceCurrency: "gbp" } }), { isFree: false, priceFrom: 5, currency: "GBP" });
  assert.deepEqual(parsePrice({ offers: { price: 0, priceCurrency: "GBP" } }), { isFree: true, priceFrom: 0, currency: null });
  assert.deepEqual(parsePrice({ offers: { price: "tbc", priceCurrency: "GBP" } }), { isFree: null, priceFrom: null, currency: "GBP" });
  assert.deepEqual(parsePrice({}), { isFree: null, priceFrom: null, currency: null });
});

test("canonicalUrl: strips query/hash/trailing slash, lowercases host", () => {
  assert.equal(canonicalUrl("https://Lu.ma/Abc/?utm=1#x"), "https://lu.ma/Abc");
  assert.equal(canonicalUrl("not a url"), "not a url");
});

test("pickImage: string, array of strings/objects, object", () => {
  assert.equal(pickImage("https://x/a.jpg"), "https://x/a.jpg");
  assert.equal(pickImage(["https://x/a.jpg", "https://x/b.jpg"]), "https://x/a.jpg");
  assert.equal(pickImage([{ url: "https://x/c.jpg" }]), "https://x/c.jpg");
  assert.equal(pickImage({ url: "https://x/d.jpg" }), "https://x/d.jpg");
  assert.equal(pickImage(null), null);
});

test("addressFromLocation: place with PostalAddress + geo", () => {
  const loc = {
    name: "Queen's Hall",
    address: { streetAddress: "85-89 Clerk St", addressLocality: "Edinburgh", postalCode: "EH8 9JG" },
    geo: { latitude: "55.9449", longitude: "-3.1822" },
  };
  assert.deepEqual(addressFromLocation(loc), {
    venueName: "Queen's Hall",
    address: "85-89 Clerk St, Edinburgh, EH8 9JG",
    city: "Edinburgh",
    lat: 55.9449,
    lng: -3.1822,
  });
  assert.deepEqual(addressFromLocation(null), { venueName: null, address: null, city: null, lat: null, lng: null });
});

test("extractJsonLdBlocks + iterJsonObjects find nested objects", () => {
  const html = `<script type="application/ld+json">{"@graph":[{"@type":"Event","name":"A"}]}</script><script type="text/javascript">x</script>`;
  const blocks = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 1);
  const names = [...iterJsonObjects(JSON.parse(blocks[0]))].map((o) => o.name).filter(Boolean);
  assert.deepEqual(names, ["A"]);
});

const NOW = new Date("2026-10-01T12:00:00Z");
const ctx = { provider: "luma", pageUrl: "https://lu.ma/edinburgh", destination: "Edinburgh, Scotland, United Kingdom", now: NOW };
const fixture = {
  "@type": "MusicEvent",
  name: "  Walter Trout  ",
  startDate: "2026-10-10T19:00:00",
  endDate: "2026-10-10T22:00:00",
  url: "/walter-trout?utm=1",
  image: ["https://img.example/a.jpg"],
  location: {
    name: "Queen's Hall",
    address: { streetAddress: "85-89 Clerk St", addressLocality: "Edinburgh", postalCode: "EH8 9JG" },
    geo: { latitude: 55.9449, longitude: -3.1822 },
  },
  offers: { price: "25", priceCurrency: "GBP" },
};

test("mapJsonLdEvent: maps a MusicEvent fixture to the events row shape", () => {
  const { row, reason } = mapJsonLdEvent(fixture, ctx);
  assert.equal(reason, null);
  assert.equal(row.provider, "luma");
  assert.equal(row.provider_event_id, "https://lu.ma/walter-trout");
  assert.equal(row.ticket_url, "https://lu.ma/walter-trout?utm=1");
  assert.equal(row.name, "Walter Trout");
  assert.equal(row.category, "music");
  assert.equal(row.image_url, "https://img.example/a.jpg");
  assert.equal(row.starts_at, "2026-10-10T18:00:00.000Z");
  assert.equal(row.ends_at, "2026-10-10T21:00:00.000Z");
  assert.equal(row.venue_name, "Queen's Hall");
  assert.equal(row.city, "Edinburgh");
  assert.equal(row.lat, 55.9449);
  assert.equal(row.is_free, false);
  assert.equal(row.price_from, 25);
  assert.equal(row.currency, "GBP");
  assert.equal(row.country, "GB");
  assert.equal(row.source, "api");
  assert.equal(row.fetched_at, NOW.toISOString());
});

test("mapJsonLdEvent: skip reasons", () => {
  assert.equal(mapJsonLdEvent({ ...fixture, name: "" }, ctx).reason, "no-name");
  assert.equal(mapJsonLdEvent({ ...fixture, startDate: undefined }, ctx).reason, "no-start-date");
  assert.equal(mapJsonLdEvent({ ...fixture, startDate: "2026-09-01T19:00:00", endDate: "2026-09-01T22:00:00" }, ctx).reason, "past");
  assert.equal(mapJsonLdEvent({ ...fixture, "@type": "Place" }, ctx).reason, "not-an-event-type");
});
