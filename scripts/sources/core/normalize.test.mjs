import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCategory, classifyFamilyFit, dedupeWithinSource, haversineKm, isEdinburghRow, isOffWedge } from "./normalize.mjs";

test("isEdinburghRow: within 15km of the centre by coordinates", () => {
  assert.equal(isEdinburghRow({ lat: 55.9486, lng: -3.1999 }), true); // the castle
  assert.equal(isEdinburghRow({ lat: 55.8642, lng: -4.2518, city: "Glasgow" }), false);
});

test("isEdinburghRow: locality keyword fallback only when coordinates are missing", () => {
  assert.equal(isEdinburghRow({ city: "Leith", address: null }), true);
  assert.equal(isEdinburghRow({ city: null, address: "12 Dalry Road" }), true);
  assert.equal(isEdinburghRow({ city: "London", address: "1 High St" }), false);
  assert.equal(isEdinburghRow({}), false);
  // Coordinates decide when present: an Edinburgh-sounding address or city doesn't rescue a far venue.
  assert.equal(isEdinburghRow({ lat: 51.5, lng: -0.12, address: "Edinburgh Road, London" }), false);
  assert.equal(isEdinburghRow({ lat: 57.4778, lng: -4.2247, city: "Edinburgh", address: "Bishop's Road, Inverness" }), false);
  // Without coordinates the address beats the city field.
  assert.equal(isEdinburghRow({ city: "Edinburgh", address: "1 Argyle St, Glasgow" }), false);
});

test("isEdinburghRow: localities match whole words only", () => {
  // "leith" inside "Innerleithen" / "Leithen Crescent" is not Leith.
  assert.equal(isEdinburghRow({ address: "Leithen Crescent, Innerleithen", city: "Innerleithen" }), false);
  assert.equal(isEdinburghRow({ address: "Leith Walk" }), true);
});

test("haversineKm: Edinburgh -> Glasgow is roughly 67km", () => {
  const d = haversineKm({ lat: 55.9533, lng: -3.1883 }, { lat: 55.8642, lng: -4.2518 });
  assert.ok(d > 60 && d < 75, `got ${d}`);
});

test("isOffWedge: excursion keywords", () => {
  assert.equal(isOffWedge({ name: "Isle of Skye Weekend Trip", description: "" }), true);
  assert.equal(isOffWedge({ name: "Day trip to Loch Ness", description: null }), true);
  assert.equal(isOffWedge({ name: "Friday Club Night", description: "Cheap pints" }), false);
});

test("isOffWedge: long + pricey span only", () => {
  const base = { name: "Festival pass", description: "", starts_at: "2026-10-10T10:00:00Z" };
  assert.equal(isOffWedge({ ...base, ends_at: "2026-10-14T10:00:00Z", price_from: 120 }), true);
  assert.equal(isOffWedge({ ...base, ends_at: "2026-10-14T10:00:00Z", price_from: 40 }), false);
  assert.equal(isOffWedge({ ...base, ends_at: "2026-10-11T10:00:00Z", price_from: 120 }), false);
  assert.equal(isOffWedge({ ...base, ends_at: null, price_from: 120 }), false);
});

test("classifyCategory: keeps a confident category, keywords fill 'other', first rule wins", () => {
  assert.equal(classifyCategory({ category: "music", name: "Stand-up night" }), "music");
  assert.equal(classifyCategory({ category: "other", name: "Stand-up Comedy Night" }), "comedy");
  assert.equal(classifyCategory({ category: "other", name: "Techno night at Cabaret" }), "nightlife");
  assert.equal(classifyCategory({ category: "other", name: "Mystery thing" }), "other");
});

test("dedupeWithinSource: first occurrence of a provider_event_id wins", () => {
  const out = dedupeWithinSource([
    { provider_event_id: "a", name: "first" },
    { provider_event_id: "b", name: "b" },
    { provider_event_id: "a", name: "second" },
  ]);
  assert.deepEqual(out.map((r) => r.name), ["first", "b"]);
});

test("classifyFamilyFit: true positives from real listings", () => {
  for (const name of [
    "Kids Halloween Party",
    "Kids Blues LIVE with Jed Potts and Nicole Smit",
    "Kids Christmas Party",
    "Witches and Wizards - Lauriston Castle Family Workshops",
    "Family Halloween Party with The Shiverin' Sheiks Band (Rock 'n' Roll)",
    "Home Alone | Family Films",
    "Bookbug at Central Library",
    "Toddler Tuesdays",
    "Half Term Bricks",
    "Family Workshop: Festive Felt",
    "Baby Sensory Class",
    "Messy Play for Under 5s",
    "Storytime for children aged 3-7",
    "Clay Club Ages 6-10",
  ]) {
    assert.equal(classifyFamilyFit({ name }), "kids", name);
  }
});

test("classifyFamilyFit: proper-noun and topic false positives stay null", () => {
  for (const name of [
    "Junkie Kid @ Liquid Room",
    "PRTY: JUNKIE KID, Edinburgh 23.10.26",
    "Kid Bookie at Sneaky Pete's, Edinburgh",
    "Bushbaby @ Liquid Room",
    "RARE Club // Bushbaby",
    "FeedbackOh RomanceSo BoringTomorrow KidVexations",
    "Sam Fern on Writing: How to Scare Children",
    "Supporting Children and Families Impacted by Poverty",
    "CONFERENCE - The Big Family Event - Being Well, Doing Well",
    "Dr Bell's Family Centre - Preparing for Baby",
    "Kids in Glass Houses live",
  ]) {
    assert.equal(classifyFamilyFit({ name }), null, name);
  }
});

test("classifyFamilyFit: signal and category", () => {
  assert.equal(classifyFamilyFit({ name: "Mystery show", signal: "kids" }), "kids");
  // A bare keyword-fallback "family" category is not enough (e.g. "Jill Andrews",
  // whose description mentions the band Hush Kids).
  assert.equal(classifyFamilyFit({ name: "Mystery show", category: "family" }), null);
  assert.equal(classifyFamilyFit({ name: "Jill Andrews", description: "Former singer of Hush Kids", category: "family" }), null);
  assert.equal(classifyFamilyFit({ name: "Mystery show", category: "music" }), null);
  // A family gig keeps its category; family_fit is separate.
  assert.equal(classifyFamilyFit({ name: "Kids Blues LIVE", category: "music" }), "kids");
});

test("classifyFamilyFit: adult guards beat keywords", () => {
  assert.equal(classifyFamilyFit({ name: "Kids Halloween Party", description: "Strictly 18+ only" }), null);
  assert.equal(classifyFamilyFit({ name: "Family Fun Club Night", category: "nightlife" }), null);
  assert.equal(classifyFamilyFit({ name: "Toddler Tuesdays", description: "Adults only after 9pm" }), null);
  assert.equal(classifyFamilyFit({ name: "Burlesque Family Show" }), null);
  assert.equal(classifyFamilyFit({ name: "Drag Brunch", category: "family" }), null);
  // "an adult over 18" in a kids listing is not an adult-only flag.
  assert.equal(classifyFamilyFit({ name: "Kids Craft Day", description: "Under 8s must be accompanied by an adult over 18." }), "kids");
});

test("classifyFamilyFit: description needs a specific phrase", () => {
  assert.equal(classifyFamilyFit({ name: "Sunday Session", description: "A family-friendly show with puppets." }), "kids");
  assert.equal(classifyFamilyFit({ name: "Sunday Session", description: "Suitable for children aged 4-8." }), "kids");
  assert.equal(classifyFamilyFit({ name: "Gig night", description: "Our family-friendly pub serves food all day." }), null);
  assert.equal(classifyFamilyFit({ name: "Panel", description: "Discussing poverty facing children and families." }), null);
  assert.equal(classifyFamilyFit({ name: "Gig", description: "Toddlers welcome", venueName: "Liquid Room" }), null);
});

test("classifyFamilyFit: age policies and youth schemes are not kids events", () => {
  const f = (name, description, category) => classifyFamilyFit({ name, description, category });
  assert.equal(f("The Shamrocks", "Under 8s not allowed."), null);
  assert.equal(f("League Two admission prices", "Under 12s admitted only with a paying adult."), null);
  assert.equal(f("Young Musician's Pass", "For young musicians aged 8-18 living in Scotland."), null);
  assert.equal(f("Castle entry", "Young Scot cardholders aged 11-25 get £1 entry."), null);
  assert.equal(f("Bus pass", "Anyone aged 5-21 can travel free."), null);
  assert.equal(f("Craft morning", "Great for children aged 3-8."), "kids");
  assert.equal(f("Soft play", "Sessions for under 5s on weekdays."), "kids");
});
