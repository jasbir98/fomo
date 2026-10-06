import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Saved",
  description: "Your saved things to do in Edinburgh.",
  // Setting openGraph replaces the root's, so the default card image has to be named again.
  openGraph: {
    images: ["/opengraph-image"],
    title: "Saved · Fomo",
    description: "Your saved things to do in Edinburgh.",
  },
  robots: { index: false },
  twitter: { card: "summary_large_image", images: ["/twitter-image"] },
};

export default function SavedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
