/**
 * Fomo Happenings — "Book early" ranking, tiering and labels.
 *
 * Pure and deterministic (same testability rationale as
 * lib/happenings/format.ts's module doc) so it can be exercised by a
 * throwaway fixture script without a live Supabase instance. Consumed by
 * app/api/feed/route.ts, which owns picking the CANDIDATE set (which
 * happenings/events are even eligible for the section) — this module only
 * ranks/labels whatever candidates it's given.
 *
 * RANKING (locked by the coordinator's mid-build update — supersedes the
 * original task brief's simpler "booking opens within 14 days first, then
 * sellout_risk" order): the section exists to catch things that sell out
 * fast the moment tickets go on sale, so recency of an already-opened sale
 * outranks a still-future one.
 *
 *   Tier 0 "Just on sale"   — booking_opens_at in the past 7 days AND
 *                              sellout_risk high|medium.
 *   Tier 1 "Tickets open …" — booking_opens_at in the next 14 days.
 *   Tier 2 "On sale now"    — other sellout_risk high|medium items already
 *                              on sale (booking_opens_at null or opened more
 *                              than 7 days ago).
 *   Tier 3                  — everything else that qualified as a candidate.
 *
 * Within a tier, soonest occurrence date first (the task's original
 * secondary sort, still correct once the tiering above has run).
 */
import type { EventItem } from "@/lib/types";
import type { Happening, Occurrence, SelloutRisk } from "@/lib/happenings/types";
import { occurrenceDateLabel } from "@/lib/happenings/format";

export type BookEarlyTier = 0 | 1 | 2 | 3;

export interface BookEarlyBookingFields {
  booking_opens_at: string | null;
  sellout_risk: SelloutRisk | null;
}

const DAY_MS = 86_400_000;

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

function isHighOrMediumRisk(risk: SelloutRisk | null): boolean {
  return risk === "high" || risk === "medium";
}

/**
 * Tiers a single candidate. EventItem rows (Skiddle/Ticketmaster) have
 * neither `booking_opens_at` nor `sellout_risk` in their schema, so they
 * always land in tier 3 ("the rest") via the all-null default — see
 * `bookEarlyTierForEvent`, a thin wrapper documenting that.
 */
export function bookEarlyTier(h: BookEarlyBookingFields, now: Date = new Date()): BookEarlyTier {
  const opensAt = h.booking_opens_at ? new Date(h.booking_opens_at) : null;
  const highOrMed = isHighOrMediumRisk(h.sellout_risk);

  if (opensAt && !Number.isNaN(opensAt.getTime())) {
    const daysSinceOpen = daysBetween(opensAt, now); // positive once opensAt is in the past
    if (daysSinceOpen >= 0 && daysSinceOpen <= 7 && highOrMed) return 0;
    const daysUntilOpen = -daysSinceOpen;
    if (daysUntilOpen > 0 && daysUntilOpen <= 14) return 1;
    if (daysSinceOpen > 7 && highOrMed) return 2;
    return 3;
  }

  // No booking_opens_at at all — "already on sale" by the schema's own
  // convention (see Happening.booking_opens_at's doc comment).
  if (highOrMed) return 2;
  return 3;
}

/** EventItem has no booking metadata — always tier 3. A named wrapper rather than inlining `3` at every call site so a future schema addition (e.g. a Ticketmaster on-sale date) has one place to start reading from. */
export function bookEarlyTierForEvent(_event: EventItem): BookEarlyTier {
  void _event;
  return 3;
}

function formatRelativePast(days: number): string {
  const whole = Math.floor(days);
  if (whole <= 0) return "today";
  if (whole === 1) return "yesterday";
  return `${whole} days ago`;
}

/** "1 Oct" / "1 Oct, 6pm" — time only shown when it isn't midnight, per the coordinator's update. */
function formatOpensAt(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const dateLabel = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(d);
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayPeriod = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase().replace(/\./g, "");
  // Midnight prints as hour "12" + dayPeriod "am" in this formatter's 12-hour
  // output — that's the one case a time-of-day is not worth showing.
  const isMidnight = minute === "00" && hour === "12" && dayPeriod === "am";
  return isMidnight ? dateLabel : `${dateLabel}, ${hour}:${minute}${dayPeriod}`;
}

export interface BookEarlyLabel {
  label: string;
  sublabel: string | null;
}

/**
 * `sublabel` is a short structured fact ONLY — "Opened 2 days ago" — never
 * the source's own free-text `sellout_note` sentence ("Beltane Fire Society
 * board minutes record that the festival sold out of the 4160 tickets…").
 * That sentence is real, useful copy (kept in full on the happening detail
 * page), just not card copy — see the Home card-density pass. The card's own
 * urgency signal is `bookEarlyTier`'s "Just on sale"/"On sale now" label
 * (BookEarlyCard renders a small "Sells fast" badge alongside it for a
 * `sellout_risk: "high"` item instead of the raw note).
 */
export function bookEarlyLabelFor(
  h: BookEarlyBookingFields,
  tier: BookEarlyTier,
  now: Date = new Date(),
  timeZone: string = "Europe/London"
): BookEarlyLabel {
  if (tier === 0 && h.booking_opens_at) {
    const days = daysBetween(new Date(h.booking_opens_at), now);
    return { label: "Just on sale", sublabel: `Opened ${formatRelativePast(days)}` };
  }
  if (tier === 1 && h.booking_opens_at) {
    return { label: `Tickets open ${formatOpensAt(h.booking_opens_at, timeZone)}`, sublabel: null };
  }
  return { label: "On sale now", sublabel: null };
}

// ---------------------------------------------------------------------------
// Unified card data + ranking
// ---------------------------------------------------------------------------

export interface BookEarlyHappeningCard {
  kind: "happening";
  happening: Happening;
  occurrence: Occurrence;
  tier: BookEarlyTier;
  label: string;
  sublabel: string | null;
  dateLabel: string;
}

export interface BookEarlyEventCard {
  kind: "event";
  event: EventItem;
  tier: BookEarlyTier;
  label: string;
  sublabel: string | null;
  dateLabel: string;
}

export type BookEarlyCardData = BookEarlyHappeningCard | BookEarlyEventCard;

export function buildBookEarlyHappeningCard(
  happening: Happening,
  occurrence: Occurrence,
  now: Date = new Date(),
  timeZone: string = "Europe/London"
): BookEarlyHappeningCard {
  const tier = bookEarlyTier(happening, now);
  const { label, sublabel } = bookEarlyLabelFor(happening, tier, now, timeZone);
  return { kind: "happening", happening, occurrence, tier, label, sublabel, dateLabel: occurrenceDateLabel(occurrence.dayDate) };
}

export function buildBookEarlyEventCard(event: EventItem): BookEarlyEventCard {
  const tier = bookEarlyTierForEvent(event);
  return {
    kind: "event",
    event,
    tier,
    label: "On sale now",
    sublabel: null,
    dateLabel: occurrenceDateLabelForEvent(event.starts_at),
  };
}

function occurrenceDateLabelForEvent(startsAt: string): string {
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d);
}

function startInstant(card: BookEarlyCardData): number {
  if (card.kind === "happening") {
    return card.occurrence.startsAt ? new Date(card.occurrence.startsAt).getTime() : new Date(`${card.occurrence.dayDate}T00:00:00Z`).getTime();
  }
  return new Date(card.event.starts_at).getTime();
}

/** Tier first, soonest occurrence second — see the module doc for why tier order changed. */
export function rankBookEarly(cards: BookEarlyCardData[]): BookEarlyCardData[] {
  return [...cards].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return startInstant(a) - startInstant(b);
  });
}

// ---------------------------------------------------------------------------
// "Notify me" — wired to real web push (supabase/add_push_alerts.sql,
// lib/push/client.ts, components/happenings/BookEarlyCard.tsx). Gated on
// NEXT_PUBLIC_VAPID_PUBLIC_KEY being set rather than a hardcoded boolean:
// the affordance is meaningless before a VAPID keypair exists (subscribing
// would have nothing to encrypt push payloads against), and this way it
// turns itself on the moment docs/push-notifications.md's setup steps are
// followed, in every environment, with no code change. NEXT_PUBLIC_ vars are
// inlined at build time, so this is a real, static (per-deploy) flag, not a
// runtime read — safe to reference at module scope like the old boolean.
// ---------------------------------------------------------------------------
export const NOTIFY_ME_ENABLED = Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
