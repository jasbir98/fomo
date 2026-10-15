"use client";

/**
 * The plan being built: up to four picks kept in localStorage (`fomo_plan`)
 * so it survives moving between /weekend and detail pages, and syncs across
 * tabs through the `storage` event. No account and no server state until the
 * visitor taps "Make link" (POST /api/plans).
 *
 * The prices here are only for the bar's running total; the plan the link
 * shows is rebuilt from the database by the API.
 */
import { useSyncExternalStore } from "react";
import { eventDayDate } from "@/lib/events/format";
import { eventImageFor } from "@/lib/events/image";
import { defaultImageFor } from "@/lib/happenings/category-style";
import { cardOnDay } from "@/lib/happenings/card-days";
import type { FeedCardData } from "@/lib/happenings/feed-types";
import { addDays, endOfLocalDay, localDayDate, nextOccurrence } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import { priceForEvent, priceForHappening } from "./price";
import { PLAN_MAX_ITEMS, type PlanPrice, type PlanRef } from "./types";

export interface BasketItem extends PlanRef {
  title: string;
  image: string;
  price: PlanPrice;
}

const KEY = "fomo_plan";
const EMPTY: BasketItem[] = [];
const listeners = new Set<() => void>();

let cachedRaw: string | null = null;
let cachedItems: BasketItem[] = EMPTY;

function read(): BasketItem[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return EMPTY;
  }
  if (raw === cachedRaw) return cachedItems;
  cachedRaw = raw;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cachedItems = Array.isArray(parsed) ? (parsed as BasketItem[]).slice(0, PLAN_MAX_ITEMS) : EMPTY;
  } catch {
    cachedItems = EMPTY;
  }
  return cachedItems;
}

function write(items: BasketItem[]) {
  try {
    if (items.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Private window / blocked storage: the basket just won't persist.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current picks; empty during SSR and the hydration pass. */
export function usePlanBasket(): BasketItem[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function inBasket(items: BasketItem[], kind: PlanRef["kind"], id: string): boolean {
  return items.some((i) => i.kind === kind && i.id === id);
}

/** "added", or "full" when there are already four picks. Adding an existing pick is a no-op "added". */
export function addToBasket(item: BasketItem): "added" | "full" {
  const items = read();
  if (inBasket(items, item.kind, item.id)) return "added";
  if (items.length >= PLAN_MAX_ITEMS) return "full";
  write([...items, item]);
  return "added";
}

export function removeFromBasket(kind: PlanRef["kind"], id: string) {
  write(read().filter((i) => !(i.kind === kind && i.id === id)));
}

export function clearBasket() {
  write([]);
}

// --- building a pick from what a surface already has ----------------------

export function basketItemForHappening(h: Happening, day?: string | null): BasketItem {
  let pickedDay = day ?? null;
  if (!pickedDay) {
    const today = localDayDate(new Date());
    const next = nextOccurrence(h, new Date(), endOfLocalDay(addDays(today, 60)))?.dayDate ?? null;
    // A multi-day run (an exhibition since June) is on today, not on its first day.
    pickedDay = next && next < today ? today : next;
  }
  return {
    kind: "happening",
    id: h.id,
    day: pickedDay,
    title: h.title,
    image: h.image_url || defaultImageFor(h),
    price: priceForHappening(h),
  };
}

export function basketItemForEvent(e: EventItem): BasketItem {
  const today = localDayDate(new Date());
  const start = eventDayDate(e.starts_at) || null;
  return {
    kind: "event",
    id: e.id,
    day: start && start < today ? today : start,
    title: e.name,
    image: eventImageFor(e),
    price: priceForEvent(e),
  };
}

/**
 * A feed card's pick: series and recurring cards add their lead. The day is
 * the first of `days` the card is on (/weekend passes its Saturday and
 * Sunday, so an exhibition running since June is picked for Saturday), else
 * the card's own occurrence day, never earlier than today.
 */
export function basketItemForCard(card: FeedCardData, days: string[] = []): BasketItem {
  const onDay = days.find((d) => cardOnDay(card, d)) ?? null;
  if (card.kind === "event") {
    const item = basketItemForEvent(card.event);
    return onDay ? { ...item, day: onDay } : item;
  }
  if (card.kind === "recurring") return basketItemForCard(card.lead, days);
  const happening = card.kind === "series" ? card.lead : card.happening;
  const today = localDayDate(new Date());
  const own = card.occurrence.dayDate < today ? today : card.occurrence.dayDate;
  return basketItemForHappening(happening, onDay ?? own);
}
