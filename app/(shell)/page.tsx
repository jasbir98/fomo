import type { Metadata } from "next";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { pageMetadata } from "@/lib/seo/metadata";
import { SITE_DESCRIPTION } from "@/lib/seo/site";
import { HomeClient } from "./HomeClient";

export const metadata: Metadata = pageMetadata({ description: SITE_DESCRIPTION, path: "/" });

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

/**
 * Home. The page itself is a server component so its HTML carries the real
 * list (Today's feed) instead of a skeleton; everything interactive lives in
 * HomeClient, which takes this as its starting content and then loads its
 * own copy exactly as before.
 */
export default async function HomePage() {
  const feed = await loadFeedForPage("now");
  // Home's Today tab never reads Book early from this response (that tab loads
  // its own window), so leave it out of the page payload.
  return <HomeClient initialFeed={feed ? { ...feed, bookEarly: [] } : null} />;
}
