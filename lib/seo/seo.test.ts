// Run with `npx tsx --test lib/seo/seo.test.ts` (same as the repo's other *.test.ts files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe } from "./metadata";
import { pageMetadata } from "./metadata";
import { serializeJsonLd } from "./jsonld";
import { eventSeo, happeningSeo, labelledPrice, placeSchemaType, placeSeo } from "./detail";
import { breadcrumbJsonLd, LIST_PAGES, listPageForHappening } from "./breadcrumbs";
import { itemListJsonLd } from "./list";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem, Place } from "@/lib/types";

const NOW = new Date("2026-10-07T12:00:00Z");

test("describe joins non-empty parts and drops blanks", () => {
  assert.equal(describe(["Free", null, "", "Sat 11 Oct 2026", false, "National Museum"]), "Free · Sat 11 Oct 2026 · National Museum");
  assert.equal(describe([null, ""]), undefined);
});

test("describe cuts at a word boundary under 160 characters", () => {
  const long = describe(["Free", "word ".repeat(60)]);
  assert.ok(long);
  assert.ok(long.length <= 160, `length ${long.length}`);
  assert.ok(long.endsWith("…"));
  assert.ok(!long.includes("wor…"), "should not cut mid-word");
});

test("serializeJsonLd escapes < so a title cannot close the script tag", () => {
  const out = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
  assert.ok(!out.includes("<"));
  assert.deepEqual(JSON.parse(out), { name: "</script><script>alert(1)</script>" });
});

test("pageMetadata sets canonical and restates site name and locale on openGraph", () => {
  const m = pageMetadata({ title: "Free things", description: "d", path: "/free" });
  assert.equal(m.alternates?.canonical, "/free");
  assert.equal(m.title, "Free things");
  assert.equal((m.openGraph as { siteName?: string }).siteName, "Ask Fomo");
  assert.equal((m.openGraph as { locale?: string }).locale, "en_GB");
  assert.equal((m.openGraph as { title?: string }).title, "Free things · Ask Fomo");
});

test("pageMetadata without a title leaves the root default alone", () => {
  const m = pageMetadata({ description: "d", path: "/" });
  assert.equal(m.title, undefined);
});

test("pageMetadata can mark a page noindex", () => {
  assert.deepEqual(pageMetadata({ description: "d", path: "/x", noindex: true }).robots, { index: false, follow: true });
  assert.equal(pageMetadata({ description: "d", path: "/x" }).robots, undefined);
});

function event(overrides: Partial<EventItem>): EventItem {
  return {
    id: "e1",
    provider: "skiddle",
    provider_event_id: "1",
    name: "Comedy night",
    description: "A very funny night.",
    category: "comedy",
    image_url: null,
    ticket_url: "https://example.com/tickets",
    starts_at: "2026-10-11T18:30:00Z",
    ends_at: null,
    venue_name: "The Stand",
    address: "5 York Place",
    lat: 55.95,
    lng: -3.19,
    city: "Edinburgh",
    country: "GB",
    is_free: false,
    price_from: 8,
    currency: "GBP",
    destination: "Edinburgh",
    place_id: null,
    source: null,
    fetched_at: null,
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

test("eventSeo describes price, date and venue with an absolute date", () => {
  const seo = eventSeo(event({}), NOW);
  assert.equal(seo.noindex, false);
  assert.ok(seo.description?.startsWith("From £8 · Sun 11 Oct 2026"), seo.description);
  assert.ok(seo.description?.includes("The Stand"));
  assert.ok(!/today|tonight/i.test(seo.description ?? ""));
});

test("eventSeo emits Event JSON-LD for a future event with a venue, and noindexes a past one", () => {
  const future = eventSeo(event({}), NOW);
  assert.equal((future.jsonLd as { "@type"?: string })["@type"], "Event");
  const past = eventSeo(event({ starts_at: "2026-09-01T18:30:00Z" }), NOW);
  assert.equal(past.noindex, true);
  assert.equal(past.jsonLd, null);
});

test("eventSeo names the venue as organizer and falls back to its photo and the meta description", () => {
  const ld = eventSeo(
    event({
      description: null,
      place: { image_url: "https://img.example/venue.jpg", name: "The Stand Comedy Club", website: "https://thestand.co.uk" },
    }),
    NOW,
  ).jsonLd as Record<string, unknown>;
  assert.deepEqual(ld.organizer, { "@type": "Organization", name: "The Stand Comedy Club", url: "https://thestand.co.uk" });
  assert.deepEqual(ld.image, ["https://img.example/venue.jpg"]);
  assert.ok(typeof ld.description === "string" && (ld.description as string).includes("The Stand"));
});

function happening(overrides: Partial<Happening>): Happening {
  return {
    id: "h1",
    slug: "h1",
    title: "Free museum day",
    summary: "Entry is free all day.",
    kind: "event",
    category: "museum",
    scope: "venue",
    editorial_tag: null,
    saving_label: null,
    saving_amount: null,
    currency: null,
    is_free: true,
    promo_code: null,
    redemption_note: null,
    eligibility: "anyone",
    eligibility_note: null,
    allowance_note: null,
    starts_at: "2026-10-11T00:00:00Z",
    ends_at: null,
    recurrence: { type: "once" },
    time_note: null,
    booking_opens_at: null,
    sellout_risk: null,
    sellout_note: null,
    venue_name: "National Museum of Scotland",
    address: "Chambers Street",
    district: null,
    city: "Edinburgh",
    region: null,
    country_code: "GB",
    lat: null,
    lng: null,
    place_id: null,
    image_url: null,
    image_quality: null,
    booking_url: null,
    cta_label: null,
    source_name: "test",
    source_url: "https://example.com",
    status: "live",
    ...overrides,
  } as Happening;
}

test("happeningSeo describes a free dated happening", () => {
  const seo = happeningSeo(happening({}), NOW);
  assert.equal(seo.noindex, false);
  assert.ok(seo.description?.startsWith("Free · Sun 11 Oct 2026 · National Museum of Scotland"), seo.description);
});

test("happeningSeo noindexes a retired happening", () => {
  assert.equal(happeningSeo(happening({ status: "retired" }), NOW).noindex, true);
});

test("happeningSeo gives a standing deal an Offer, not an Event", () => {
  const seo = happeningSeo(
    happening({ recurrence: { type: "always" }, kind: "deal", starts_at: null, is_free: false, saving_label: "£4 tickets", place_id: "p1" }),
    NOW
  );
  const ld = seo.jsonLd as Record<string, unknown>;
  assert.equal(ld["@type"], "Offer");
  assert.equal(ld.price, 4);
  assert.equal(ld.url, "https://askfomo.com/happening/h1");
  assert.deepEqual(ld.offeredBy, { "@type": "Organization", name: "National Museum of Scotland", url: "https://askfomo.com/place/p1" });
  assert.ok(seo.description?.includes("Every day"));
});

test("a dated paid happening's Event carries an Offer, with a price only when the label names one", () => {
  const priced = happeningSeo(happening({ is_free: false, saving_label: "£5 student tickets" }), NOW).jsonLd as Record<string, unknown>;
  assert.equal((priced.offers as { price?: number }).price, 5);
  assert.equal((priced.offers as { description?: string }).description, "£5 student tickets");
  const saving = happeningSeo(happening({ is_free: false, saving_label: "£5 off entry", saving_amount: 5 }), NOW).jsonLd as Record<string, unknown>;
  assert.equal((saving.offers as { price?: number }).price, undefined);
  assert.equal((saving.offers as { "@type"?: string })["@type"], "Offer");
});

test("labelledPrice reads a named price and ignores savings", () => {
  assert.equal(labelledPrice("£21.95 student ticket"), 21.95);
  assert.equal(labelledPrice("£5 off"), undefined);
  assert.equal(labelledPrice("20% off"), undefined);
  assert.equal(labelledPrice("2 for £10"), undefined);
  assert.equal(labelledPrice(null), undefined);
});

function place(overrides: Partial<Place>): Place {
  return {
    id: "p1",
    name: "The Stand",
    category: "live music venue",
    description: "Comedy club.",
    image_url: null,
    address: "5 York Place",
    lat: 55.95,
    lng: -3.19,
    city: "Edinburgh",
    destination: "Edinburgh",
    phone: null,
    website: "https://thestand.co.uk",
    price_range: null,
    opening_hours: [{ day: 1, open: "19:00", close: "01:00" }],
    business_status: "OPERATIONAL",
    ...overrides,
  } as Place;
}

test("placeSeo picks a schema type from the category and fills address, hours and offers", () => {
  const seo = placeSeo({ place: place({}), offers: [happening({ id: "h9", place_id: "p1" })], events: [] });
  const ld = seo.jsonLd as Record<string, unknown>;
  assert.equal(ld["@type"], "EventVenue");
  assert.equal(ld.url, "https://askfomo.com/place/p1");
  assert.deepEqual(ld.sameAs, ["https://thestand.co.uk"]);
  assert.equal((ld.openingHoursSpecification as { dayOfWeek: string }[])[0].dayOfWeek, "https://schema.org/Monday");
  assert.equal((ld.makesOffer as { url: string }[])[0].url, "https://askfomo.com/happening/h9");
  assert.ok(seo.description?.startsWith("Live music venue in Edinburgh · 1 offer"), seo.description);
  assert.equal(seo.noindex, false);
});

test("placeSchemaType falls back to TouristAttraction and pairs civic types with it", () => {
  assert.equal(placeSchemaType("viewpoint"), "TouristAttraction");
  assert.equal(placeSchemaType("pub"), "BarOrPub");
  assert.deepEqual(placeSchemaType("nature-reserve"), "TouristAttraction");
  assert.deepEqual(placeSchemaType("museum"), ["Museum", "TouristAttraction"]);
  assert.equal(placeSchemaType(null), "TouristAttraction");
});

test("placeSeo noindexes a permanently closed place", () => {
  const seo = placeSeo({ place: place({ business_status: "CLOSED_PERMANENTLY" }), offers: [], events: [] });
  assert.equal(seo.noindex, true);
  assert.equal(seo.jsonLd, null);
});

test("listPageForHappening matches where the feed lists it", () => {
  assert.equal(listPageForHappening(happening({ kind: "deal" })).path, "/deals");
  assert.equal(listPageForHappening(happening({})).path, "/whats-on");
  assert.equal(listPageForHappening(happening({ kind: "free_access", recurrence: { type: "always" } })).path, "/free");
  assert.equal(listPageForHappening(happening({ kind: "activity", is_free: false, recurrence: { type: "always" } })).path, "/deals");
});

test("breadcrumbJsonLd lists Home, the list page and the item with absolute URLs", () => {
  const ld = breadcrumbJsonLd(LIST_PAGES.whatsOn, "Comedy night", "/event/e1") as { itemListElement: { position: number; item: string; name: string }[] };
  assert.deepEqual(
    ld.itemListElement.map((c) => [c.position, c.name, c.item]),
    [
      [1, "Home", "https://askfomo.com/"],
      [2, "What's on", "https://askfomo.com/whats-on"],
      [3, "Comedy night", "https://askfomo.com/event/e1"],
    ]
  );
});

test("itemListJsonLd dedupes, numbers and caps the list, and is null when empty", () => {
  const ld = itemListJsonLd("What's on", "/whats-on", [
    { name: "A", path: "/event/a" },
    { name: "A again", path: "/event/a" },
    { name: "B", path: "/happening/b" },
  ]) as { numberOfItems: number; itemListElement: { position: number; url: string }[] };
  assert.equal(ld.numberOfItems, 2);
  assert.deepEqual(ld.itemListElement.map((i) => [i.position, i.url]), [
    [1, "https://askfomo.com/event/a"],
    [2, "https://askfomo.com/happening/b"],
  ]);
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `${i}`, path: `/event/${i}` }));
  assert.equal((itemListJsonLd("x", "/x", many) as { numberOfItems: number }).numberOfItems, 30);
  assert.equal(itemListJsonLd("x", "/x", []), null);
});

test("happeningSeo names the venue as organizer and dates the free offer from booking opening", () => {
  const ld = happeningSeo(happening({ booking_opens_at: "2026-10-08T09:00:00Z" }), NOW).jsonLd as Record<string, unknown>;
  assert.deepEqual(ld.organizer, { "@type": "Organization", name: "National Museum of Scotland" });
  assert.equal((ld.offers as { validFrom?: string }).validFrom, "2026-10-08T09:00:00Z");
});

test("organizer.url is the venue's website, else its page here, else left out", () => {
  const withSite = happeningSeo(happening({ place_id: "p1" }), NOW, "https://www.nms.ac.uk").jsonLd as Record<string, unknown>;
  assert.equal((withSite.organizer as { url?: string }).url, "https://www.nms.ac.uk");
  const linked = eventSeo(event({ place_id: "p2" }), NOW).jsonLd as Record<string, unknown>;
  assert.equal((linked.organizer as { url?: string }).url, "https://askfomo.com/place/p2");
  const unlinked = eventSeo(event({}), NOW).jsonLd as Record<string, unknown>;
  assert.equal((unlinked.organizer as { url?: string }).url, undefined);
});
