// Run: npx tsx --test lib/happenings/near-now.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Happening, Occurrence } from "./types";
import type { DealCardData, FeedCardData, FeedResponse } from "./feed-types";
import type { EventItem } from "@/lib/types";
import { NEAR_LIMIT, nearNow, nearTimeLabel } from "./near-now";

// Tue 27 Oct 2026, 15:00 London (GMT, so London = UTC).
const now = new Date("2026-10-27T15:00:00Z");
const TODAY = "2026-10-27";
const TZ = "Europe/London";
// The Cowgate.
const here = { lat: 55.9485, lng: -3.188 };
/** ~111 m per 0.001° of latitude. */
const north = (km: number) => ({ lat: here.lat + km / 111.2, lng: here.lng });

function happening(id: string, over: Partial<Happening> = {}): Happening {
  return {
    id,
    title: id,
    kind: "event",
    status: "live",
    venue_name: id,
    place_id: null,
    time_note: null,
    eligibility: "anyone",
    starts_at: null,
    ends_at: null,
    recurrence: { type: "always" },
    lat: null,
    lng: null,
    ...over,
  } as unknown as Happening;
}

function occ(id: string, over: Partial<Occurrence> = {}): Occurrence {
  return { happeningId: id, dayDate: TODAY, lastDayDate: TODAY, startsAt: null, endsAt: null, seriesEndDayDate: null, exact: false, ...over };
}

function hCard(id: string, at: { lat: number; lng: number } | null, o: Partial<Occurrence> = {}): FeedCardData {
  return { kind: "happening", happening: happening(id, at ?? {}), occurrence: occ(id, o) };
}

function eCard(id: string, at: { lat: number; lng: number } | null, starts_at: string, ends_at: string | null = null): FeedCardData {
  const event = { id, name: id, starts_at, ends_at, lat: at?.lat ?? null, lng: at?.lng ?? null } as unknown as EventItem;
  return { kind: "event", event };
}

function deal(id: string, at: { lat: number; lng: number } | null, recurrence: Happening["recurrence"] = { type: "always" }): DealCardData {
  return {
    kind: "happening",
    happening: happening(id, { kind: "deal", recurrence, ...(at ?? {}) }),
    occurrence: occ(id),
    what: "food_drink",
    who: null,
  } as unknown as DealCardData;
}

function feed(cards: FeedCardData[], singles: DealCardData[] = [], grouped: DealCardData[] = []): Pick<FeedResponse, "whatsOn" | "anyDay" | "deals"> {
  return {
    whatsOn: [{ key: "today", title: "Today", meta: null, cards }] as unknown as FeedResponse["whatsOn"],
    anyDay: null,
    deals: {
      venueGroups: grouped.length ? [{ placeId: "p1", placeName: "P", placeImageUrl: null, district: null, offers: grouped }] : [],
      singles,
    },
  };
}

function ids(result: ReturnType<typeof nearNow>): string[] {
  return result.items.map((i) => (i.card.kind === "happening" ? i.card.happening.id : i.card.kind === "event" ? i.card.event.id : i.card.key));
}

test("sorts nearest first", () => {
  const r = nearNow(feed([hCard("far", north(1.2)), hCard("near", north(0.2)), hCard("mid", north(0.6))]), here, now, TZ);
  assert.equal(r.status, "ok");
  assert.deepEqual(ids(r), ["near", "mid", "far"]);
  assert.ok(r.items[0].distanceKm < r.items[1].distanceKm);
});

test("cuts at the radius and caps the list", () => {
  const r = nearNow(feed([hCard("in", north(1.4)), hCard("out", north(1.6))]), here, now, TZ);
  assert.deepEqual(ids(r), ["in"]);

  const many = Array.from({ length: 12 }, (_, i) => hCard(`c${i}`, north(0.05 * (i + 1))));
  assert.equal(nearNow(feed(many), here, now, TZ).items.length, NEAR_LIMIT);
});

test("includes today's deals, single and venue-grouped, and skips a deal not on today", () => {
  const r = nearNow(
    feed(
      [hCard("quiz", north(0.5))],
      [deal("single", north(0.3)), deal("mondays", north(0.1), { type: "weekly", days: [1] })],
      [deal("grouped", north(0.4))]
    ),
    here,
    now,
    TZ
  );
  assert.deepEqual(ids(r), ["single", "grouped", "quiz"]);
});

test("skips rows without coordinates", () => {
  const r = nearNow(feed([hCard("nowhere", null), eCard("ev", null, "2026-10-27T19:00:00Z")], [deal("d", null)]), here, now, TZ);
  assert.deepEqual(ids(r), []);
});

test("outside Edinburgh returns outside_city", () => {
  const glasgow = { lat: 55.8642, lng: -4.2518 };
  const r = nearNow(feed([hCard("x", north(0.1))]), glasgow, now, TZ);
  assert.equal(r.status, "outside_city");
  assert.deepEqual(r.items, []);
});

test("time labels come from the card's own times", () => {
  const r = nearNow(
    feed([
      eCard("later", north(0.1), "2026-10-27T19:00:00Z"),
      hCard("running", north(0.2), { exact: true, startsAt: "2026-10-27T10:00:00Z", endsAt: "2026-10-27T22:00:00Z" }),
      eCard("dateonly", north(0.3), "2026-10-27T00:00:00Z"),
      hCard("rule", north(0.4)),
      eCard("over", north(0.5), "2026-10-27T11:00:00Z", "2026-10-27T13:00:00Z"),
    ]),
    here,
    now,
    TZ
  );
  assert.deepEqual(
    r.items.map((i) => i.timeLabel),
    ["starts 19:00", "on until 22:00", "on today", "on today"]
  );
  assert.match(r.items[0].reason, /^\d+ m · \d+ min walk · starts 19:00$/);
});

test("nearTimeLabel: a start past the 2h default with no end is over; tomorrow's or a 23:59 end isn't 'on until'", () => {
  const ms = (iso: string) => new Date(iso).getTime();
  assert.equal(nearTimeLabel({ startMs: ms("2026-10-27T12:00:00Z"), endMs: null }, now, TZ), null);
  assert.equal(nearTimeLabel({ startMs: ms("2026-10-27T14:00:00Z"), endMs: null }, now, TZ), "on today");
  assert.equal(nearTimeLabel({ startMs: null, endMs: ms("2026-10-28T02:00:00Z") }, now, TZ), "on today");
  assert.equal(nearTimeLabel({ startMs: null, endMs: ms("2026-10-27T23:59:00Z") }, now, TZ), "on today");
});

test("BST: start label is London wall-clock time", () => {
  const summer = new Date("2026-07-14T12:00:00Z");
  assert.equal(nearTimeLabel({ startMs: new Date("2026-07-14T18:00:00Z").getTime(), endMs: null }, summer, TZ), "starts 19:00");
});
