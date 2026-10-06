import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Free things to do in Edinburgh",
  description: "Museums, galleries, parks, viewpoints and more with £0 admission in Edinburgh.",
  // Setting openGraph replaces the root's, so the default card image has to be named again.
  openGraph: {
    images: ["/opengraph-image"],
    title: "Free things to do in Edinburgh · Fomo",
    description: "Museums, galleries, parks, viewpoints and more with £0 admission in Edinburgh.",
  },
  twitter: { card: "summary_large_image", images: ["/twitter-image"] },
};

export default function FreeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
