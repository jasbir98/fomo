import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/JsonLd";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { freeAnyTimeEntry, itemListJsonLd } from "@/lib/seo/list";
import { pageMetadata } from "@/lib/seo/metadata";
import { FreeClient } from "./FreeClient";

const TITLE = "Free things to do in Edinburgh";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: "Museums, galleries, parks, viewpoints and more with £0 admission in Edinburgh.",
  path: "/free",
});

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

/** Free any time. A server component so the HTML lists the real places; see FreeClient for the interactive page. */
export default async function FreePage() {
  const feed = await loadFeedForPage("now");
  const itemList = feed ? itemListJsonLd(TITLE, "/free", feed.freeAnyTime.map(freeAnyTimeEntry)) : null;
  return (
    <>
      {itemList ? <JsonLd data={itemList} /> : null}
      <FreeClient initialItems={feed?.freeAnyTime ?? null} />
    </>
  );
}
