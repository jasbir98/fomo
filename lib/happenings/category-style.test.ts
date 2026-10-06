import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultImageFor } from "@/lib/happenings/category-style";
import type { HappeningCategory } from "@/lib/happenings/types";

const theme = (t: string) => `/defaults/themes/${t}.webp`;

const THEMED: Array<[string, string | null, string]> = [
  ["Edinburgh Castle £1 Young Scot Entry", null, "castle"],
  ["Edinburgh Zoo Student Concession Ticket", null, "zoo"],
  ["SCO £6 Tickets for Under-26s & Students", null, "classical"],
  ["Scottish Opera £15 Under-26 Tickets", "Festival Theatre Edinburgh", "classical"],
  ["RSNO £6 Tickets for Under-26s & Students", null, "classical"],
  ["Capital Theatres 25 & Under £10 Tickets", null, "theatre"],
  ["Traverse £1 Tickets for Under-25s", null, "theatre"],
  ["16-25 Railcard (1/3 Off Rail Fares)", null, "train"],
  ["Lothian & Trams Student Ridacard", null, "bus"],
  ["Alien Rock Student Concession", null, "climbing"],
  ["Height Club 10% Off Group Climb", null, "climbing"],
  ["PureGym Student Membership (Up to 30% Off)", null, "gym"],
  ["Edinburgh Leisure Student Membership Discounts", null, "swim"],
  ["Charlie Miller 25% Off Student Cuts", null, "hair"],
  ["Cheynes 25% Off Cut & Colour", null, "hair"],
  ["Superdrug 10% Student Discount (In-store)", null, "shopping"],
  ["The Body Shop 10% Student Discount (In-store)", null, "shopping"],
];

for (const [title, venue, expected] of THEMED) {
  test(`defaultImageFor: "${title}" -> ${expected}`, () => {
    assert.equal(defaultImageFor({ category: "other", title, venue_name: venue }), theme(expected));
  });
}

const FALLBACKS: Array<[string, HappeningCategory, string]> = [
  ["ASK Italian 30% Off Food (Sun-Fri)", "food", "/defaults/happenings/food.webp"],
  ["Pottery workshop", "arts", "/defaults/happenings/arts.webp"],
  ["Morningside School of Music 10% First Lesson", "music", "/defaults/happenings/music.webp"],
];

for (const [title, category, expected] of FALLBACKS) {
  test(`defaultImageFor: "${title}" falls back to the ${category} default`, () => {
    assert.equal(defaultImageFor({ category, title }), expected);
  });
}

test("defaultImageFor: missing title and category falls back to the other default", () => {
  assert.equal(defaultImageFor({}), "/defaults/happenings/other.webp");
});

test("defaultImageFor: a pop gig at the Usher Hall keeps the music default, not the orchestra", () => {
  assert.equal(defaultImageFor({ category: "music", title: "Idlewild at Usher Hall", venue_name: "Usher Hall" }), "/defaults/happenings/music.webp");
});
