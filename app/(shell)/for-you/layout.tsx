import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = pageMetadata({
  title: "For you: Edinburgh's best steals this week",
  description:
    "This week's hand-picked steals in Edinburgh: free and cheap events and deals far better than their price. New every Friday.",
  path: "/for-you",
  // This route has its own opengraph-image.tsx.
  images: false,
});

/** Indexable (unlike /saved): the picks are public, the same for everyone, and the page the Instagram "Fomo Finds" posts point at. */
export default function ForYouLayout({ children }: { children: React.ReactNode }) {
  return children;
}
