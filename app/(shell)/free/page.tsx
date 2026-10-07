import type { Metadata } from "next";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { pageMetadata } from "@/lib/seo/metadata";
import { FreeClient } from "./FreeClient";

export const metadata: Metadata = pageMetadata({
  title: "Free things to do in Edinburgh",
  description: "Museums, galleries, parks, viewpoints and more with £0 admission in Edinburgh.",
  path: "/free",
});

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

/** Free any time. A server component so the HTML lists the real places; see FreeClient for the interactive page. */
export default async function FreePage() {
  const feed = await loadFeedForPage("now");
  return <FreeClient initialItems={feed?.freeAnyTime ?? null} />;
}
