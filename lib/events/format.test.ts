// Run: npx tsx --test lib/events/format.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventIsInProgress } from "./format";
import { eventOnNowLabel } from "@/lib/happenings/format";

const TZ = "Europe/London";
// Wed 14 Oct 2026, 12:00 BST.
const NOW = new Date("2026-10-14T11:00:00Z");

// The live "Victoria Bar's Wednesday Quiz Night" row: a date-only span,
// 1 Sep – 30 Dec. Build-feed floors it into Today; its card read "Tue 1 Sep".
const SPAN = { starts_at: "2026-09-01T00:00:00+00:00", ends_at: "2026-12-30T23:59:59+00:00" };

test("eventIsInProgress: date-only span that started on an earlier day is on now", () => {
  assert.equal(eventIsInProgress(SPAN, NOW, TZ), true);
  assert.equal(eventOnNowLabel(SPAN.ends_at, NOW, TZ), "On now · until 30 Dec");
});

test("eventIsInProgress: date-only event on its own first day is not on now", () => {
  assert.equal(eventIsInProgress({ starts_at: "2026-10-14T00:00:00Z", ends_at: null }, NOW, TZ), false);
  assert.equal(
    eventIsInProgress({ starts_at: "2026-10-14T00:00:00Z", ends_at: "2026-10-20T00:00:00Z" }, NOW, TZ),
    false
  );
});

test("eventIsInProgress: date-only span that has ended or not started is not on now", () => {
  assert.equal(eventIsInProgress({ starts_at: "2026-09-01T00:00:00Z", ends_at: "2026-10-13T23:00:00Z" }, NOW, TZ), false);
  assert.equal(eventIsInProgress({ starts_at: "2026-10-20T00:00:00Z", ends_at: "2026-12-30T00:00:00Z" }, NOW, TZ), false);
});

test("eventIsInProgress: timed events unchanged", () => {
  assert.equal(eventIsInProgress({ starts_at: "2026-10-14T10:30:00Z", ends_at: null }, NOW, TZ), true);
  assert.equal(eventIsInProgress({ starts_at: "2026-10-14T18:30:00Z", ends_at: null }, NOW, TZ), false);
  assert.equal(eventIsInProgress({ starts_at: "2026-10-14T07:00:00Z", ends_at: null }, NOW, TZ), false);
});
