import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Book early in Edinburgh",
  description: "Big Edinburgh dates worth booking before they sell out.",
  // Setting openGraph replaces the root's, so the default card image has to be named again.
  openGraph: {
    images: ["/opengraph-image"],
    title: "Book early in Edinburgh · Fomo",
    description: "Big Edinburgh dates worth booking before they sell out.",
  },
  twitter: { card: "summary_large_image", images: ["/twitter-image"] },
};

export default function BookEarlyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
