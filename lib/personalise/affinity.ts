"use client";

/**
 * Implicit interest learning (task brief, section 3) — a save or share
 * nudges a small localStorage-only per-interest counter, which
 * lib/personalise/score.ts's `personalBoost` reads back as a small capped
 * bonus on top of the visitor's explicit "Into…" picks. No server writes —
 * this never touches user_metadata, so it works for signed-out visitors too
 * and never contradicts (or duplicates) a deliberate interest pick, it only
 * ever adds a small amount on top of one.
 */
import type { InterestKey } from "./interests";

const STORAGE_KEY = "fomo:affinity";

/** The most `affinityBonus` will ever add to a card's score — small next to
 *  `personalBoost`'s explicit-interest match, so implicit learning nudges
 *  rather than dominates. Counting stops mattering once a interest is saved
 *  this many times. */
const CAP_PER_INTEREST = 2;

type AffinityMap = Partial<Record<InterestKey, number>>;

function read(): AffinityMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as AffinityMap;
  } catch {
    return {};
  }
}

function write(map: AffinityMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Private mode / storage full — the counter just doesn't persist;
    // never worth surfacing to the visitor over.
  }
}

/** Bump one interest's counter — call from a save or share action. Silent no-op off-browser, for an unmapped card (`interest: null`), or on storage failure. */
export function recordAffinity(interest: InterestKey | null): void {
  if (!interest) return;
  const map = read();
  map[interest] = Math.min((map[interest] ?? 0) + 1, CAP_PER_INTEREST + 1);
  write(map);
}

/** `personalBoost`'s own small bonus for `interest`, capped at `CAP_PER_INTEREST`. Pass an already-read `map` (from `readAffinity`) when scoring a whole list, so each card doesn't re-read localStorage. */
export function affinityBonus(interest: InterestKey | null, map?: AffinityMap): number {
  if (!interest) return 0;
  const source = map ?? read();
  return Math.min(source[interest] ?? 0, CAP_PER_INTEREST);
}

export function readAffinity(): AffinityMap {
  return read();
}
