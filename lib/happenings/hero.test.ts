// Run: npx tsx --test lib/happenings/hero.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening, Occurrence } from "./types";
import type { FeedCardData } from "./feed-types";
import { happeningRecommendationScore, isPhotoImage, leadWithPhotos } from "./hero";

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
