// Run with `npx tsx --test lib/seo/seo.test.ts` (same as the repo's other *.test.ts files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe } from "./metadata";
import { pageMetadata } from "./metadata";
import { serializeJsonLd } from "./jsonld";
import { eventSeo, happeningSeo } from "./detail";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";

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

test("happeningSeo gives a standing deal no Event JSON-LD", () => {
  const seo = happeningSeo(happening({ recurrence: { type: "always" }, kind: "deal", starts_at: null }), NOW);
  assert.equal(seo.jsonLd, null);
  assert.ok(seo.description?.includes("Every day"));
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
