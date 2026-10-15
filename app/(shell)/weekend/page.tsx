import type { Metadata } from "next";
import { weekendDates } from "@/lib/happenings/format";
import { JsonLd } from "@/components/seo/JsonLd";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { countDeals, weekendCards, type WeekendInitial } from "@/lib/happenings/weekend";
import { feedCardEntry, itemListJsonLd } from "@/lib/seo/list";
import { pageMetadata } from "@/lib/seo/metadata";
import { WeekendClient } from "./WeekendClient";

const TITLE = "This weekend in Edinburgh";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: "Free, cheap and discounted things to do in Edinburgh this weekend. Events, student deals and offers.",
  path: "/weekend",
  // This route has its own opengraph-image.tsx.
  images: false,
});

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

/** This weekend. A server component so the HTML lists the real events; see WeekendClient for the interactive page. */
export default async function WeekendPage() {
  const [now, later] = await Promise.all([loadFeedForPage("now"), loadFeedForPage("coming_up")]);
  let initial: WeekendInitial | null = null;
  if (now && later) {
    const { saturday, sunday } = weekendDates();
    initial = {
      saturday,
      sunday,
      cards: weekendCards(now, later, saturday, sunday),
      dealCount: countDeals(later.deals),
    };
  }
  const itemList = initial ? itemListJsonLd(TITLE, "/weekend", initial.cards.map(feedCardEntry)) : null;
  return (
    <>
      {itemList ? <JsonLd data={itemList} /> : null}
      <WeekendClient initial={initial} />
    </>
  );
}
