/**
 * Which list page a detail page belongs under: the "More in …" link on the
 * page and its BreadcrumbList structured data both read from here, so the
 * visible link and the breadcrumb Google shows never disagree.
 *
 * Mirrors where the feed actually lists each thing (lib/happenings/
 * build-feed.ts): `kind: "deal"` rows are Deals; anything with dates is What's
 * on; an "always" row is Free any time when free, else a standing deal.
 *
 * Pure and not `server-only`, so the client detail components can use it.
 */
import { normalizeRecurrence } from "@/lib/happenings/occurrence";
import type { Happening } from "@/lib/happenings/types";
import { absoluteUrl } from "./site";

export interface ListPage {
  /** As the page itself is titled ("What's on"). */
  name: string;
  path: string;
}

export const LIST_PAGES = {
  whatsOn: { name: "What's on", path: "/whats-on" },
  deals: { name: "Deals", path: "/deals" },
  free: { name: "Free", path: "/free" },
  explore: { name: "Explore", path: "/explore" },
} satisfies Record<string, ListPage>;

export function listPageForHappening(h: Pick<Happening, "kind" | "is_free" | "recurrence">): ListPage {
  if (h.kind === "deal") return LIST_PAGES.deals;
  if (normalizeRecurrence(h.recurrence).type !== "always") return LIST_PAGES.whatsOn;
  return h.is_free ? LIST_PAGES.free : LIST_PAGES.deals;
}

/** Home › list page › this page, as schema.org BreadcrumbList. `path` is the detail page's own. */
export function breadcrumbJsonLd(list: ListPage, name: string, path: string): Record<string, unknown> {
  const crumbs = [
    { name: "Home", path: "/" },
    list,
    { name, path },
  ];
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path),
    })),
  };
}
