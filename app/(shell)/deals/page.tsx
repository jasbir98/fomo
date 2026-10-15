import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/JsonLd";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { dealsEntries, itemListJsonLd } from "@/lib/seo/list";
import { pageMetadata } from "@/lib/seo/metadata";
import { DealsClient } from "./DealsClient";

const TITLE = "Student & local deals in Edinburgh";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description:
    "Discounts, promo codes and concessions around Edinburgh: student, EH-resident, under-26 and over-60 deals, updated daily.",
  path: "/deals",
});

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

/** Deals. A server component so the HTML lists the real deals; see DealsClient for the interactive page. */
export default async function DealsPage() {
  const feed = await loadFeedForPage("now");
  const itemList = feed ? itemListJsonLd(TITLE, "/deals", dealsEntries(feed.deals)) : null;
  return (
    <>
      {itemList ? <JsonLd data={itemList} /> : null}
      <DealsClient initialDeals={feed?.deals ?? null} />
    </>
  );
}
