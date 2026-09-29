// Run: npx tsx --test lib/events/description.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanEventDescription, buildEventFallbackDescription } from "./description";

test("nulls known placeholders", () => {
  for (const junk of [
    "summary of the event",
    "Summary of event",
    "  summary of the event.  ",
    "Description",
    "event description",
    "TBC",
    "tba",
    "Coming soon",
    "coming soon!",
    "More info to follow",
    "More information soon",
    "No description",
    "Lorem ipsum dolor sit amet, consectetur",
    "",
    "   ",
    "Hi",
  ]) {
    assert.equal(cleanEventDescription(junk), null, junk);
  }
});

test("nulls null/undefined", () => {
  assert.equal(cleanEventDescription(null), null);
  assert.equal(cleanEventDescription(undefined), null);
});

test("nulls a description that just repeats the name", () => {
  assert.equal(cleanEventDescription("Aid & Abet 10 Year Anniversary", "Aid & Abet 10 Year Anniversary"), null);
  assert.equal(cleanEventDescription("aid & abet 10 year anniversary!!", "Aid & Abet 10 Year Anniversary"), null);
});

test("keeps real short and long blurbs", () => {
  assert.equal(cleanEventDescription("Free entry, all welcome."), "Free entry, all welcome.");
  assert.equal(
    cleanEventDescription("  A night of drum & bass with three rooms.  "),
    "A night of drum & bass with three rooms."
  );
  const long = "Summary of the event: a full night of jazz from the quartet.";
  assert.equal(cleanEventDescription(long), long);
});

test("does not null a blurb that merely contains a placeholder word", () => {
  const s = "Event details and coming soon merch stall on the night, plus live sets.";
  assert.equal(cleanEventDescription(s), s);
});

test("fallback description uses only known fields", () => {
  const out = buildEventFallbackDescription({
    category: "music",
    venue_name: "Usher Hall",
    city: "Edinburgh",
    starts_at: "2030-10-03T18:30:00Z",
    is_free: false,
    price_from: 22,
    currency: "GBP",
    provider: "ticketmaster",
    ticket_url: "https://example.com",
  });
  assert.match(out, /^Live music at Usher Hall on Thu 3 Oct at 19:30\. Tickets from £22 via Ticketmaster\.$/);
});

test("fallback omits missing fields", () => {
  const out = buildEventFallbackDescription({
    category: null,
    venue_name: null,
    city: null,
    starts_at: "2030-10-03T00:00:00Z",
    is_free: null,
    price_from: null,
    currency: null,
    provider: "unknown",
    ticket_url: null,
  });
  assert.equal(out, "An event on Thu 3 Oct.");
});

test("fallback free event", () => {
  const out = buildEventFallbackDescription({
    category: "comedy",
    venue_name: "The Stand",
    city: null,
    starts_at: "2030-10-03T19:00:00Z",
    is_free: true,
    price_from: null,
    currency: null,
    provider: "skiddle",
    ticket_url: "https://x.y",
  });
  assert.equal(out, "Comedy at The Stand on Thu 3 Oct at 20:00. Free entry via Skiddle.");
});
