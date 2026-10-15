import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/JsonLd";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { feedCardEntry, itemListJsonLd } from "@/lib/seo/list";
import { pageMetadata } from "@/lib/seo/metadata";
import { WhatsOnClient, type WhatsOnInitial } from "./WhatsOnClient";

const TITLE = "What's on in Edinburgh";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: "Free and cheap gigs, comedy, cinema, food and days out in Edinburgh, by date.",
  path: "/whats-on",
});

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

/** What's on. A server component so the HTML lists the real events; see WhatsOnClient for the interactive page. */
export default async function WhatsOnPage() {
  const [now, later] = await Promise.all([loadFeedForPage("now"), loadFeedForPage("coming_up")]);
  // Only the slice the page reads, and only Today (see WhatsOnInitial).
  const initial: WhatsOnInitial | null = now ? { now: { whatsOn: now.whatsOn, anyDay: now.anyDay ?? null } } : null;
  // Today's list then what's coming up: the order a visitor scrolls through
  // the two tabs. Coming up feeds only this capped list, not the page data.
  const itemList = itemListJsonLd(
    TITLE,
    "/whats-on",
    [...(now?.whatsOn[0]?.cards ?? []), ...(later?.whatsOn[0]?.cards ?? [])].map(feedCardEntry)
  );
  return (
    <>
      {itemList ? <JsonLd data={itemList} /> : null}
      <WhatsOnClient initial={initial} />
    </>
  );
}
