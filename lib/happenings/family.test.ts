// Run with `npx tsx --test lib/happenings/family.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  familyFitForCard,
  familyFitForEvent,
  familyFitForHappening,
  familyFitForPlace,
  isKidFriendly,
} from "@/lib/happenings/family";
import type { EventCardData, HappeningCardData, RecurringCardData, SeriesCardData } from "@/lib/happenings/feed-types";
import type { Happening, Occurrence } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import { event, happening } from "@/lib/finds/fixtures.test-util";

const occurrence: Occurrence = {
  happeningId: "x",
  dayDate: "2026-10-17",
  startsAt: null,
  endsAt: null,
  lastDayDate: "2026-10-17",
  seriesEndDayDate: null,
  exact: false,
};

const hCard = (h: Happening): HappeningCardData => ({ kind: "happening", happening: h, occurrence });
const eCard = (e: EventItem): EventCardData => ({ kind: "event", event: e });
const seriesCard = (lead: Happening): SeriesCardData => ({
  kind: "series",
  key: "k",
  title: "Series",
  lead,
  locationCount: 3,
  occurrence,
});
const recurringCard = (lead: HappeningCardData | EventCardData): RecurringCardData => ({
  kind: "recurring",
  key: "k",
  title: "Recurring",
  lead,
  dates: ["2026-10-17", "2026-10-24"],
});

test("happening: explicit family_fit wins, including over a category/eligibility fallback", () => {
  assert.equal(familyFitForHappening(happening({ id: "a", family_fit: "all_ages", category: "family" })), "all_ages");
  assert.equal(familyFitForHappening(happening({ id: "b", family_fit: "kids", category: "food" })), "kids");
});

test("happening: category family falls back to kids", () => {
  assert.equal(familyFitForHappening(happening({ id: "a", category: "family" })), "kids");
});

test("happening: eligibility family falls back to kids", () => {
  assert.equal(familyFitForHappening(happening({ id: "a", category: "food", eligibility: "family" })), "kids");
});

test("happening: explicit null / absent with no fallback signal is null", () => {
  assert.equal(familyFitForHappening(happening({ id: "a", family_fit: null })), null);
  assert.equal(familyFitForHappening(happening({ id: "b" })), null);
  assert.equal(familyFitForHappening(happening({ id: "c", category: "museum" })), null);
});

test("event: explicit value, category fallback, null", () => {
  assert.equal(familyFitForEvent(event({ id: "a", family_fit: "all_ages" })), "all_ages");
  assert.equal(familyFitForEvent(event({ id: "b", category: "family" })), "kids");
  assert.equal(familyFitForEvent(event({ id: "c", category: "family", family_fit: "all_ages" })), "all_ages");
  assert.equal(familyFitForEvent(event({ id: "d", family_fit: null })), null);
  assert.equal(familyFitForEvent(event({ id: "e" })), null);
});

test("place: stored value only", () => {
  assert.equal(familyFitForPlace({ family_fit: "kids" }), "kids");
  assert.equal(familyFitForPlace({ family_fit: "all_ages" }), "all_ages");
  assert.equal(familyFitForPlace({ family_fit: null }), null);
  assert.equal(familyFitForPlace({}), null);
});

test("card: happening and event kinds", () => {
  assert.equal(familyFitForCard(hCard(happening({ id: "a", family_fit: "kids" }))), "kids");
  assert.equal(familyFitForCard(hCard(happening({ id: "b", category: "family" }))), "kids");
  assert.equal(familyFitForCard(hCard(happening({ id: "c" }))), null);
  assert.equal(familyFitForCard(eCard(event({ id: "d", family_fit: "all_ages" }))), "all_ages");
  assert.equal(familyFitForCard(eCard(event({ id: "e", category: "family" }))), "kids");
  assert.equal(familyFitForCard(eCard(event({ id: "f" }))), null);
});

test("card: series uses its lead", () => {
  assert.equal(familyFitForCard(seriesCard(happening({ id: "a", family_fit: "all_ages" }))), "all_ages");
  assert.equal(familyFitForCard(seriesCard(happening({ id: "b", eligibility: "family" }))), "kids");
  assert.equal(familyFitForCard(seriesCard(happening({ id: "c" }))), null);
});

test("card: recurring uses its lead, happening or event", () => {
  assert.equal(familyFitForCard(recurringCard(hCard(happening({ id: "a", family_fit: "kids" })))), "kids");
  assert.equal(familyFitForCard(recurringCard(hCard(happening({ id: "b" })))), null);
  assert.equal(familyFitForCard(recurringCard(eCard(event({ id: "c", category: "family" })))), "kids");
  assert.equal(familyFitForCard(recurringCard(eCard(event({ id: "d", family_fit: "all_ages" })))), "all_ages");
  assert.equal(familyFitForCard(recurringCard(eCard(event({ id: "e" })))), null);
});

test("isKidFriendly: true for kids and all_ages, false for null", () => {
  assert.equal(isKidFriendly(hCard(happening({ id: "a", family_fit: "kids" }))), true);
  assert.equal(isKidFriendly(hCard(happening({ id: "b", family_fit: "all_ages" }))), true);
  assert.equal(isKidFriendly(hCard(happening({ id: "c", family_fit: null }))), false);
  assert.equal(isKidFriendly(eCard(event({ id: "d" }))), false);
});

test("an explicit null beats the category/eligibility fallback once the column exists", () => {
  assert.equal(familyFitForHappening(happening({ id: "g", category: "family", family_fit: null })), null);
  assert.equal(familyFitForHappening(happening({ id: "h", eligibility: "family", family_fit: null })), null);
  assert.equal(familyFitForHappening(happening({ id: "i", category: "family" })), "kids");
  assert.equal(familyFitForEvent(event({ id: "j", category: "family", family_fit: null })), null);
  assert.equal(familyFitForEvent(event({ id: "k", category: "family" })), "kids");
});

test("category fallback skips adult-group concessions at family venues", () => {
  assert.equal(familyFitForHappening(happening({ id: "l", category: "family", eligibility: "student" })), null);
  assert.equal(familyFitForHappening(happening({ id: "m", category: "family", eligibility: "local_resident" })), null);
  assert.equal(familyFitForHappening(happening({ id: "n", category: "family", eligibility: "anyone" })), "kids");
});
