import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Explore Edinburgh on the map",
  description: "Free and cheap things, deals and events around Edinburgh on one map.",
  // Setting openGraph replaces the root's, so the default card image has to be named again.
  openGraph: {
    images: ["/opengraph-image"],
    title: "Explore Edinburgh on the map · Fomo",
    description: "Free and cheap things, deals and events around Edinburgh on one map.",
  },
  twitter: { card: "summary_large_image", images: ["/twitter-image"] },
};

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  return children;
}
