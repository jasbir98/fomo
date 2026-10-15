// Run: npx tsx --test lib/happenings/weekly-span.test.ts
//
// Weekday-named date-only runs ("Victoria Bar's Wednesday Quiz Night",
// 1 Sep – 30 Dec) only happen on that weekday: lib/events/format.ts's
// `weeklySpanOf` and everything the feed builds on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventItem } from "@/lib/types";
import type { FeedCardData, HappeningCardData } from "@/lib/happenings/feed-types";
import type { Happening } from "@/lib/happenings/types";
import { eventDateLabel, eventIsInProgress, eventNextDay, weeklySpanOf } from "@/lib/events/format";
import { cardOnDay } from "./card-days";
import { mergeProviderEventsIntoCards } from "./merge-events";

const TZ = "Europe/London";
// Thu 15 Oct 2026, 12:00 BST.
const THURSDAY = new Date("2026-10-15T11:00:00Z");
// Wed 21 Oct 2026, 12:00 BST.
const WEDNESDAY = new Date("2026-10-21T11:00:00Z");

function ev(over: Partial<EventItem> & Pick<EventItem, "name" | "starts_at">): EventItem {
  return {
    id: "e1",
    provider: "edinburgh_guide",
    provider_event_id: "e1",
    description: null,
    category: "nightlife",
    image_url: null,
    ticket_url: "https://example.com/quiz",
    ends_at: null,
    venue_name: "Victoria Bar",
    address: null,
    lat: null,
    lng: null,
    city: "Edinburgh",
    country: "GB",
    is_free: true,
    price_from: null,
    currency: null,
    destination: null,
    place_id: null,
    source: null,
    fetched_at: null,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  } as EventItem;
}

// The live rows.
const QUIZ = ev({
  name: "Victoria Bar’s Wednesday Quiz Night",
  starts_at: "2026-09-01T00:00:00+00:00",
  ends_at: "2026-12-30T23:59:59+00:00",
});
const EASY_SUNDAYS = ev({
  name: "Easy Sundays",
  starts_at: "2026-09-13T00:00:00+00:00",
  ends_at: "2026-11-29T23:59:59+00:00",
  venue_name: "Scottish Storytelling Centre",
});

test("weeklySpanOf: one named weekday on a date-only run", () => {
  assert.deepEqual(weeklySpanOf(QUIZ), { weekday: 3, firstDay: "2026-09-01", lastDay: "2026-12-30" });
  assert.equal(weeklySpanOf(EASY_SUNDAYS)?.weekday, 0);
  // Repeating the same day is still one weekday.
  assert.equal(
    weeklySpanOf(ev({ name: "BROKE! FRIDAYS | Friday Night", starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T23:59:59Z" }))
      ?.weekday,
    5
  );
});

test("weeklySpanOf: not a weekly span", () => {
  const run = { starts_at: "2026-09-01T00:00:00Z", ends_at: "2026-12-30T23:59:59Z" };
  // No weekday, or two of them.
  assert.equal(weeklySpanOf(ev({ ...run, name: "Catherine Opie: To Be Seen" })), null);
  assert.equal(weeklySpanOf(ev({ ...run, name: "Bao Bun workshop - Every Saturday & Sunday" })), null);
  // Named one-off days.
  assert.equal(weeklySpanOf(ev({ ...run, name: "Black Friday Deals" })), null);
  // Timed start, one-day row, no end.
  assert.equal(weeklySpanOf(ev({ ...run, starts_at: "2026-09-01T19:30:00Z", name: "Wednesday Quiz" })), null);
  assert.equal(
    weeklySpanOf(ev({ name: "Sunday Roast Club", starts_at: "2026-10-18T00:00:00Z", ends_at: "2026-10-18T23:59:59Z" })),
    null
  );
  assert.equal(weeklySpanOf(ev({ name: "Sunday Roast Club", starts_at: "2026-10-18T00:00:00Z", ends_at: null })), null);
  // Mon 12 – Fri 16 Oct never touches a Sunday: the title's day isn't its schedule.
  assert.equal(
    weeklySpanOf(ev({ name: "Sunday Times Book Week", starts_at: "2026-10-12T00:00:00Z", ends_at: "2026-10-16T23:59:59Z" })),
    null
  );
});

test("eventNextDay: weekly span is on its next matching weekday", () => {
  assert.equal(eventNextDay(QUIZ, "2026-10-15", TZ), "2026-10-21");
  assert.equal(eventNextDay(QUIZ, "2026-10-21", TZ), "2026-10-21");
  assert.equal(eventNextDay(EASY_SUNDAYS, "2026-10-15", TZ), "2026-10-18");
  // Past its last matching day -> none left.
  assert.equal(eventNextDay(EASY_SUNDAYS, "2026-11-30", TZ), null);
  const broke = ev({ name: "BROKE! FRIDAYS", starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T23:59:59Z" });
  assert.equal(eventNextDay(broke, "2026-10-17", TZ), null);
});

test("eventNextDay: other events floor a running span to today, keep a future day", () => {
  const opie = ev({ name: "Catherine Opie: To Be Seen", starts_at: "2026-08-08T00:00:00Z", ends_at: "2026-11-01T23:59:59Z" });
  assert.equal(eventNextDay(opie, "2026-10-15", TZ), "2026-10-15");
  assert.equal(eventNextDay(ev({ name: "Gig", starts_at: "2026-10-20T19:30:00Z" }), "2026-10-15", TZ), "2026-10-20");
});

test("eventIsInProgress: weekly span is on now only on its weekday", () => {
  assert.equal(eventIsInProgress(QUIZ, THURSDAY, TZ), false);
  assert.equal(eventIsInProgress(QUIZ, WEDNESDAY, TZ), true);
  // Without a name it's an ordinary span, as before.
  assert.equal(eventIsInProgress({ starts_at: QUIZ.starts_at, ends_at: QUIZ.ends_at }, THURSDAY, TZ), true);
});

test("eventDateLabel: weekly span reads as its next day, not its first", () => {
  assert.equal(eventDateLabel(QUIZ, THURSDAY, TZ), "Wed 21 Oct");
  assert.equal(eventDateLabel(QUIZ, new Date("2026-10-20T11:00:00Z"), TZ), "Tomorrow");
  assert.equal(eventDateLabel(EASY_SUNDAYS, THURSDAY, TZ), "Sun 18 Oct");
});

test("cardOnDay: weekly span matches its weekdays inside the run", () => {
  const card: FeedCardData = { kind: "event", event: EASY_SUNDAYS };
  assert.equal(cardOnDay(card, "2026-10-18"), true); // Sunday
  assert.equal(cardOnDay(card, "2026-10-17"), false); // Saturday
  assert.equal(cardOnDay(card, "2026-12-06"), false); // Sunday after the run
});

function happeningCard(title: string, dayDate: string, venue: string | null): HappeningCardData {
  return {
    kind: "happening",
    happening: { id: "h1", title, venue_name: venue, booking_url: null } as unknown as Happening,
    occurrence: { happeningId: "h1", dayDate, startsAt: null, endsAt: null, lastDayDate: dayDate } as HappeningCardData["occurrence"],
  };
}

test("mergeProviderEventsIntoCards: weekly span pairs with the curated weekly card", () => {
  const curated = happeningCard("Wednesday Quiz Night at Victoria Bar", "2026-10-21", "Victoria Bar");
  const { cards, unmatchedEvents } = mergeProviderEventsIntoCards([curated], [QUIZ], TZ);
  assert.equal(unmatchedEvents.length, 0);
  assert.equal((cards[0] as HappeningCardData).happening.booking_url, "https://example.com/quiz");
});

test("mergeProviderEventsIntoCards: weekly span doesn't pair on the wrong weekday or venue", () => {
  const thursday = happeningCard("Wednesday Quiz Night at Victoria Bar", "2026-10-22", "Victoria Bar");
  assert.equal(mergeProviderEventsIntoCards([thursday], [QUIZ], TZ).unmatchedEvents.length, 1);
  const elsewhere = happeningCard("Wednesday Quiz Night at Victoria Bar", "2026-10-21", "The Stand");
  assert.equal(mergeProviderEventsIntoCards([elsewhere], [QUIZ], TZ).unmatchedEvents.length, 1);
  const noVenue = happeningCard("Wednesday Quiz Night at Victoria Bar", "2026-10-21", null);
  assert.equal(mergeProviderEventsIntoCards([noVenue], [QUIZ], TZ).unmatchedEvents.length, 1);
  const otherNight = happeningCard("Wednesday Open Mic at Victoria Bar", "2026-10-21", "Victoria Bar");
  assert.equal(mergeProviderEventsIntoCards([otherNight], [QUIZ], TZ).unmatchedEvents.length, 1);
});
