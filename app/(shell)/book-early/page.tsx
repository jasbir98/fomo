import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/JsonLd";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { bookEarlyCardEntry, itemListJsonLd } from "@/lib/seo/list";
import { pageMetadata } from "@/lib/seo/metadata";
import { BookEarlyClient } from "./BookEarlyClient";

const TITLE = "Book early in Edinburgh";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: "Big Edinburgh dates worth booking before they sell out.",
  path: "/book-early",
});

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

/** Book early. A server component so the HTML lists the real dates; see BookEarlyClient for the interactive page. */
export default async function BookEarlyPage() {
  const cards = (await loadFeedForPage("now"))?.bookEarly ?? null;
  const itemList = cards ? itemListJsonLd(TITLE, "/book-early", cards.map(bookEarlyCardEntry)) : null;
  return (
    <>
      {itemList ? <JsonLd data={itemList} /> : null}
      <BookEarlyClient initialCards={cards} />
    </>
  );
}
