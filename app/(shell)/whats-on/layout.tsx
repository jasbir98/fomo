import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "What's on in Edinburgh",
  description: "Free and cheap gigs, comedy, cinema, food and days out in Edinburgh, by date.",
  // Setting openGraph replaces the root's, so the default card image has to be named again.
  openGraph: {
    images: ["/opengraph-image"],
    title: "What's on in Edinburgh · Fomo",
    description: "Free and cheap gigs, comedy, cinema, food and days out in Edinburgh, by date.",
  },
  twitter: { card: "summary_large_image", images: ["/twitter-image"] },
};

export default function WhatsOnLayout({ children }: { children: React.ReactNode }) {
  return children;
}
