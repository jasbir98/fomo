// Run: npx tsx --test lib/happenings/hero.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening, Occurrence } from "./types";
import type { FeedCardData } from "./feed-types";
import type { EventItem } from "@/lib/types";
import { eventRecommendationScore, happeningRecommendationScore, heroEligibleEvent, heroEligibleHappening, isPhotoImage, leadWithPhotos } from "./hero";

// Wed 14 Oct 2026, midday London.
const now = new Date("2026-10-14T11:00:00Z");

function hap(id: string, image_url: string | null, is_free = true): Happening {
  return {
    id,
    title: id,
    kind: "deal",
    is_free,
    image_url,
    saving_amount: null,
    priority: 50,
    eligibility: "anyone",
    sellout_risk: null,
    verified_at: "2026-10-13T09:00:00Z",
    recurrence: { type: "once" },
  } as unknown as Happening;
}

// A one-day occurrence, so no "last chance" factor is in play.
function occ(dayDate: string): Occurrence {
  return { happeningId: "h", dayDate, startsAt: null, endsAt: null, lastDayDate: dayDate, seriesEndDayDate: null, exact: true };
}

function card(h: Happening, dayDate = "2026-10-14"): FeedCardData {
  return { kind: "happening", happening: h, occurrence: occ(dayDate) };
}

test("isPhotoImage: documents, defaults and missing images are not photos", () => {
  assert.equal(isPhotoImage("https://www.edinburghleisure.co.uk/wp-content/uploads/2026/02/EL-Coaching-Venues-Timetable.jpg"), false);
  assert.equal(isPhotoImage("https://example.com/a/poster-final.png?w=800"), false);
  assert.equal(isPhotoImage("https://example.com/menu.pdf"), false);
  assert.equal(isPhotoImage("/defaults/happenings/music.webp"), false);
  assert.equal(isPhotoImage(null), false);
  assert.equal(isPhotoImage(""), false);
});

test("isPhotoImage: real photos pass, folder names don't count", () => {
  assert.equal(isPhotoImage("https://www.edinburghleisure.co.uk/wp-content/uploads/2026/10/SwimToddler_1_2.jpg"), true);
  assert.equal(isPhotoImage("https://upload.wikimedia.org/wikipedia/commons/0/05/Princes_Street_Gardens.jpg"), true);
  assert.equal(isPhotoImage("https://example.com/timetable/crowd.jpg"), true);
  assert.equal(isPhotoImage("https://a1.imgix.net/2ykfxr9ch0gbrxb33tumjhectf6w"), true);
});

test("hero score: a timetable image scores like no image", () => {
  const today = occ("2026-10-14");
  const doc = happeningRecommendationScore(hap("doc", "https://x.com/Timetable.jpg"), today, now).score;
  const none = happeningRecommendationScore(hap("none", null), today, now).score;
  const photo = happeningRecommendationScore(hap("photo", "https://x.com/swim.jpg"), today, now).score;
  assert.equal(doc, none);
  assert.ok(photo > doc);
});

test("hero score: free and on this weekend beats free and weeks away", () => {
  const h = hap("free", "https://x.com/swim.jpg");
  const weekend = happeningRecommendationScore(h, occ("2026-10-17"), now).score;
  const later = happeningRecommendationScore(h, occ("2026-11-04"), now).score;
  assert.ok(weekend > later);
});

test("leadWithPhotos: photo-led cards lead, the rest keep their order", () => {
  const cards = [
    card(hap("doc", "https://x.com/Timetable.jpg")),
    card(hap("none", null)),
    card(hap("paid-photo", "https://x.com/a.jpg", false)),
    card(hap("free-photo", "https://x.com/b.jpg")),
  ];
  const ids = leadWithPhotos(cards, now).map((c) => (c.kind === "happening" ? c.happening.id : c.kind));
  assert.deepEqual(ids, ["free-photo", "paid-photo", "doc", "none"]);
});

test("leadWithPhotos: no photos leaves the list as it was", () => {
  const cards = [card(hap("a", null)), card(hap("b", "https://x.com/logo.png"))];
  assert.deepEqual(leadWithPhotos(cards, now), cards);
});

test("hero eligibility: kids-aimed happenings and events are out, all_ages and ordinary stay in", () => {
  const h = hap("x", "https://example.com/p.jpg");
  assert.equal(heroEligibleHappening(h), true);
  assert.equal(heroEligibleHappening({ ...h, family_fit: "kids" }), false);
  assert.equal(heroEligibleHappening({ ...h, family_fit: "all_ages" }), true);
  // fallbacks for rows pre-dating the family_fit column
  assert.equal(heroEligibleHappening({ ...h, category: "family" }), false);
  assert.equal(heroEligibleHappening({ ...h, eligibility: "family" }), false);
  assert.equal(heroEligibleEvent({ category: "music" }), true);
  assert.equal(heroEligibleEvent({ category: "family" }), false);
  assert.equal(heroEligibleEvent({ category: "family", family_fit: "all_ages" }), true);
  assert.equal(heroEligibleEvent({ category: "music", family_fit: "kids" }), false);
});

function ev(over: Partial<EventItem>): EventItem {
  return {
    id: "e",
    title: "e",
    is_free: false,
    price_from: null,
    currency: "GBP",
    image_url: "https://x.com/gig.jpg",
    category: "music",
    starts_at: "2026-10-14T19:00:00Z",
    ends_at: null,
    ...over,
  } as unknown as EventItem;
}

test("hero score: a free months-long event scores below a one-night £12 gig tonight", () => {
  const sociograss = ev({ is_free: true, starts_at: "2026-09-30T09:00:00Z", ends_at: "2027-01-27T17:00:00Z" });
  const gig = ev({ price_from: 12, starts_at: "2026-10-14T19:00:00Z", ends_at: "2026-10-14T23:00:00Z" });
  assert.ok(eventRecommendationScore(sociograss, now).score < eventRecommendationScore(gig, now).score);
});

test("hero score: a long event run ending tomorrow is not penalised", () => {
  const endingSoon = ev({ is_free: true, starts_at: "2026-09-30T09:00:00Z", ends_at: "2026-10-15T17:00:00Z" });
  const shortRun = ev({ is_free: true, starts_at: "2026-10-10T09:00:00Z", ends_at: "2026-10-15T17:00:00Z" });
  const longRun = ev({ is_free: true, starts_at: "2026-09-30T09:00:00Z", ends_at: "2026-11-30T17:00:00Z" });
  const ending = eventRecommendationScore(endingSoon, now).score;
  assert.equal(ending, eventRecommendationScore(shortRun, now).score);
  assert.equal(ending - eventRecommendationScore(longRun, now).score, 15);
});

test("hero score: a weekly happening instance gets no one-off bonus, a once single day does", () => {
  const once = hap("once", "https://x.com/a.jpg");
  const weekly = { ...once, recurrence: { type: "weekly", days: [3] } } as unknown as Happening;
  const dates = { ...once, recurrence: { type: "dates", dates: ["2026-10-14"] } } as unknown as Happening;
  const today = occ("2026-10-14");
  const onceScore = happeningRecommendationScore(once, today, now).score;
  assert.equal(onceScore - happeningRecommendationScore(weekly, today, now).score, 8);
  assert.equal(happeningRecommendationScore(dates, today, now).score, onceScore);
});

test("hero score: a long-running happening is marked down unless it ends within 2 days", () => {
  const h = hap("exhibition", "https://x.com/a.jpg");
  const span = (seriesEnd: string): Occurrence => ({ ...occ("2026-10-14"), lastDayDate: "2026-11-30", seriesEndDayDate: seriesEnd });
  const far = happeningRecommendationScore(h, span("2026-11-30"), now).score;
  const ending = happeningRecommendationScore(h, span("2026-10-15"), now).score;
  assert.ok(ending > far);
  assert.equal(far, happeningRecommendationScore(h, occ("2026-10-14"), now).score - 15 - 8);
});

test("hero score: a chain deal scores 10 below an identical local one", () => {
  const local = { ...hap("Student 2-for-1", "https://x.com/a.jpg"), venue_name: "Local Cafe" } as Happening;
  const chain = { ...local, venue_name: "Nando's" } as Happening;
  const today = occ("2026-10-14");
  assert.equal(
    happeningRecommendationScore(local, today, now).score - happeningRecommendationScore(chain, today, now).score,
    10
  );
});

test("hero score: a niche-audience listing scores 20 below the same listing for anyone", () => {
  const plain = ev({ name: "Activities at the Festival Theatre", is_free: true });
  const niche = ev({ name: "Festival Theatre's Dementia Friendly Activities", is_free: true });
  assert.equal(eventRecommendationScore(plain, now).score - eventRecommendationScore(niche, now).score, 20);

  const talk = { ...hap("Free talk", "https://x.com/a.jpg"), title: "Free talk" };
  const course = { ...talk, title: "Irish Language Classes" };
  const o = occ("2026-10-14");
  assert.equal(happeningRecommendationScore(talk, o, now).score - happeningRecommendationScore(course, o, now).score, 20);
});

test("hero score: an over-60s listing isn't niche for an over-60 visitor", () => {
  const seniors = ev({ name: "Seniors Tea Dance", is_free: true });
  const plain = ev({ name: "Tea Dance", is_free: true });
  assert.equal(eventRecommendationScore(seniors, now, undefined, ["over_60"]).score, eventRecommendationScore(plain, now).score);
  assert.ok(eventRecommendationScore(seniors, now).score < eventRecommendationScore(plain, now).score);
});

test("hero score: a parents' session isn't niche for a visitor with kids", () => {
  const talk = ev({ name: "Bilingualism Talk at the Pregnancy & Parents Centre", is_free: true });
  const plain = ev({ name: "Bilingualism Talk", is_free: true });
  assert.equal(eventRecommendationScore(talk, now, undefined, ["families"]).score, eventRecommendationScore(plain, now).score);
});

test("hero score: a happening already narrowed by eligibility isn't marked down twice", () => {
  const o = occ("2026-10-14");
  const anyone = { ...hap("x", "https://x.com/a.jpg"), title: "Free Travel" };
  const over60 = { ...anyone, title: "Free Travel Over 60s", eligibility: "over_60" } as Happening;
  // Only the eligibility markdown (10), not the niche one on top.
  assert.equal(happeningRecommendationScore(anyone, o, now).score - happeningRecommendationScore(over60, o, now).score, 10);
});
