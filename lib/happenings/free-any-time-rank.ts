/**
 * Fomo Happenings — ordering and gating for "Free any time".
 *
 * The zone is for things anyone can do whenever they like: free museums,
 * viewpoints, parks, standing free weekly events. On 11 Nov 2026 it led with
 * two tip-based walking tours (a tourist product), "Edinburgh Trams Free
 * Travel Over 60s", "National Galleries Free Entry for Under-18s" and a
 * one-off dated talk, which is not "any time" at all.
 *
 *  - A row naming a specific one-off date is left out (`isOneOffDated`): it
 *    belongs in What's on, on its day.
 *  - A tip-based tour or an age-restricted entitlement is marked down below
 *    everything genuinely free (`freeAnyTimePenalty`), never removed. The
 *    sort is stable, so the existing photo/mention ordering is kept inside each
 *    tier.
 *
 * Reuses the niche-audience rules (audience.ts) for the age-restricted ones.
 * Pure, no `server-only`.
 */
import { nicheAudience } from "@/lib/happenings/audience";
import type { FreeAnyTimeItem } from "@/lib/happenings/feed-types";

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_MONTH = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "i");
const MONTH_DAY = new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "i");
const NUMERIC_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;
/** A description mentioning a date in passing ("Open 1 April to 30 September", "closed 25 December") is not a one-off. */
const STANDING_WORDS = /\b(?:open|opens|opening|closed|closes|daily|every|weekly|monthly|until|season|seasonal|year[- ]round|from .{1,20} to)\b/i;

/** True when the name, or a description with no standing-hours wording, names a specific calendar date. */
export function isOneOffDated(name: string, description?: string | null): boolean {
  const hasDate = (t: string) => DAY_MONTH.test(t) || MONTH_DAY.test(t) || NUMERIC_DATE.test(t);
  if (hasDate(name)) return true;
  const d = description ?? "";
  return hasDate(d) && !STANDING_WORDS.test(d);
}

const TIP_BASED =
  /\btip[- ]based\b|\bpay[- ]what[- ](?:you[- ])?(?:want|like|wish|feel)\b|\bfree walking tours?\b|\bfree (?:city |old town )?tours?\b|\btips?\s+(?:only|welcome|appreciated|based)\b|\bname your own price\b|\bgratuity\b/i;

/** Marks an item down by this much (a bigger number sorts lower). */
export const FREE_ANY_TIME_PENALTY = 20;

/** 0 for something genuinely free anyone can do; `FREE_ANY_TIME_PENALTY` for a tip-based tour or an age-restricted entitlement. */
export function freeAnyTimePenalty(item: Pick<FreeAnyTimeItem, "name" | "description">): number {
  if (TIP_BASED.test(item.name) || TIP_BASED.test(item.description ?? "")) return FREE_ANY_TIME_PENALTY;
  // "older", "youth", "support"...: for a group, not for anyone.
  if (nicheAudience(item.name, item.description) !== null) return FREE_ANY_TIME_PENALTY;
  return 0;
}

/** `items` without one-off dated rows, genuinely-free-for-anyone first. Stable inside each tier. */
export function rankFreeAnyTime(items: readonly FreeAnyTimeItem[]): FreeAnyTimeItem[] {
  return items
    .filter((i) => !isOneOffDated(i.name, i.description))
    .map((item, index) => ({ item, index, penalty: freeAnyTimePenalty(item) }))
    .sort((a, b) => a.penalty - b.penalty || a.index - b.index)
    .map((x) => x.item);
}
