"use client";

/**
 * Freshness for repeat visitors, without reshuffling the time-ordered feed.
 *
 * NEW BADGE. The first time a visitor opens Fomo in a session we remember the
 * previous visit's time as this session's cutoff (sessionStorage, so the badges
 * don't vanish while they move between Home and /whats-on), then record "now"
 * as the last visit (localStorage). A card whose row was created after the
 * cutoff is new to them. A first-ever visit has no cutoff, so nothing is
 * badged: everything would be. A long absence is clamped to MAX_LOOKBACK_MS so
 * a visitor back after two months doesn't see every card marked new.
 *
 * DAILY ROTATION. "Any day" cards have no natural order (they're on every
 * day), so the same few topped the section on every visit. `rotateDaily`
 * orders them by a hash of (London date, card id): stable all day and for
 * everyone, different tomorrow, and a card's place relative to the others
 * doesn't move when an unrelated card is added or removed.
 *
 * Storage is wrapped in try/catch throughout; with storage blocked there are
 * simply no badges.
 */
import { useSyncExternalStore } from "react";
import type { FeedCardData } from "@/lib/happenings/feed-types";

const LAST_VISIT_KEY = "fomo:last-visit";
const SESSION_CUTOFF_KEY = "fomo:new-since";
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure: this session's cutoff from the stored last visit (ms), or null on a first visit. */
export function cutoffFromLastVisit(lastVisit: number | null, now: number): number | null {
  if (lastVisit == null || !Number.isFinite(lastVisit) || lastVisit <= 0 || lastVisit > now) return null;
  return Math.max(lastVisit, now - MAX_LOOKBACK_MS);
}

let cached: number | null | undefined;

function readCutoff(): number | null {
  if (cached !== undefined) return cached;
  if (typeof window === "undefined") return null;
  cached = null;
  try {
    const session = window.sessionStorage.getItem(SESSION_CUTOFF_KEY);
    if (session !== null) {
      cached = session === "" ? null : Number(session);
    } else {
      const stored = window.localStorage.getItem(LAST_VISIT_KEY);
      cached = cutoffFromLastVisit(stored ? Number(stored) : null, Date.now());
      window.sessionStorage.setItem(SESSION_CUTOFF_KEY, cached == null ? "" : String(cached));
    }
    window.localStorage.setItem(LAST_VISIT_KEY, String(Date.now()));
  } catch {
    // Private mode / storage blocked: no badges this session.
  }
  return cached;
}

const subscribe = () => () => {};

/** This session's "new since" cutoff in ms, or null (server render, first visit, storage blocked). */
export function useNewSinceCutoff(): number | null {
  return useSyncExternalStore(subscribe, readCutoff, () => null);
}

/** When the card's underlying row was first added. Series and recurring cards go by their lead. */
export function cardCreatedAt(card: FeedCardData): string | null {
  if (card.kind === "happening") return card.happening.created_at ?? null;
  if (card.kind === "event") return card.event.created_at ?? null;
  if (card.kind === "series") return card.lead.created_at ?? null;
  return card.lead.kind === "happening" ? card.lead.happening.created_at ?? null : card.lead.event.created_at ?? null;
}

export function isNewSince(card: FeedCardData, cutoff: number | null): boolean {
  if (cutoff == null) return false;
  const created = cardCreatedAt(card);
  if (!created) return false;
  const t = Date.parse(created);
  return Number.isFinite(t) && t > cutoff;
}

/** Stable identity for a feed card, shared by list keys and the daily rotation. */
export function feedCardKey(card: FeedCardData): string {
  if (card.kind === "happening") return `happening-${card.happening.id}`;
  if (card.kind === "series") return `series-${card.key}`;
  if (card.kind === "recurring") return `recurring-${card.key}`;
  return `event-${card.event.id}`;
}

/** 32-bit FNV-1a: tiny, deterministic, well spread for short keys. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Today's date in Edinburgh as YYYY-MM-DD, the rotation's seed. */
export function londonDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Same set of cards, in an order that is fixed for `dayKey` and changes the next day. */
export function rotateDaily<T extends FeedCardData>(cards: readonly T[], dayKey: string): T[] {
  return cards
    .map((card) => ({ card, rank: fnv1a(`${dayKey}:${feedCardKey(card)}`) }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.card);
}
