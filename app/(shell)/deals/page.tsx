import type { Metadata } from "next";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { pageMetadata } from "@/lib/seo/metadata";
import { DealsClient } from "./DealsClient";

export const metadata: Metadata = pageMetadata({
  title: "Student & local deals in Edinburgh",
  description:
    "Discounts, promo codes and concessions around Edinburgh: student, EH-resident, under-26 and over-60 deals, updated daily.",
  path: "/deals",
});

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

/** Deals. A server component so the HTML lists the real deals; see DealsClient for the interactive page. */
export default async function DealsPage() {
  const feed = await loadFeedForPage("now");
  return <DealsClient initialDeals={feed?.deals ?? null} />;
}
