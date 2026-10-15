/**
 * schema.org ItemList for the list pages (What's on, Book early, This
 * weekend, Deals, Free): the detail pages each list links to, in the order
 * the page shows them. Built on the server from the same feed the page's
 * first HTML renders, so the structured data and the visible list agree.
 */
import type { BookEarlyCardData } from "@/lib/happenings/book-early";
import type { DealsSection, FeedCardData, FreeAnyTimeItem } from "@/lib/happenings/feed-types";
import { absoluteUrl } from "./site";

/** Enough to describe the page; Google reads the first few, and the rest only bloats the HTML. */
const MAX_ITEMS = 30;

export interface ListEntry {
  name: string;
  path: string;
}

export function feedCardEntry(card: FeedCardData): ListEntry {
  switch (card.kind) {
    case "happening":
      return { name: card.happening.title, path: `/happening/${card.happening.id}` };
    case "event":
      return { name: card.event.name, path: `/event/${card.event.id}` };
    case "series":
      return { name: card.title, path: `/happening/${card.lead.id}` };
    case "recurring":
      return { ...feedCardEntry(card.lead), name: card.title };
  }
}

export function bookEarlyCardEntry(card: BookEarlyCardData): ListEntry {
  return card.kind === "happening"
    ? { name: card.happening.title, path: `/happening/${card.happening.id}` }
    : { name: card.event.name, path: `/event/${card.event.id}` };
}

/** Venue groups link to the venue's page (it lists every offer there), as their cards do; a group with no place falls back to its deals. */
export function dealsEntries(deals: DealsSection): ListEntry[] {
  const out: ListEntry[] = [];
  for (const group of deals.venueGroups) {
    if (group.placeId) out.push({ name: group.placeName, path: `/place/${group.placeId}` });
    else for (const d of group.offers) out.push({ name: d.happening.title, path: `/happening/${d.happening.id}` });
  }
  for (const d of deals.singles) out.push({ name: d.happening.title, path: `/happening/${d.happening.id}` });
  return out;
}

export function freeAnyTimeEntry(item: FreeAnyTimeItem): ListEntry {
  return { name: item.name, path: item.kind === "place" ? `/place/${item.id}` : `/happening/${item.id}` };
}

/** Null for an empty list, so the page renders no script at all. Duplicate URLs keep their first position. */
export function itemListJsonLd(name: string, path: string, entries: ListEntry[]): Record<string, unknown> | null {
  const seen = new Set<string>();
  const unique = entries.filter((e) => !seen.has(e.path) && seen.add(e.path)).slice(0, MAX_ITEMS);
  if (unique.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    url: absoluteUrl(path),
    numberOfItems: unique.length,
    itemListElement: unique.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: e.name,
      url: absoluteUrl(e.path),
    })),
  };
}
