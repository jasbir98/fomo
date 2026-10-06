import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Student & local deals in Edinburgh",
  description: "Discounts, promo codes and concessions around Edinburgh: student, EH-resident, under-26 and over-60 deals, updated daily.",
  // Setting openGraph replaces the root's, so the default card image has to be named again.
  openGraph: {
    images: ["/opengraph-image"],
    title: "Student & local deals in Edinburgh · Fomo",
    description: "Discounts, promo codes and concessions around Edinburgh: student, EH-resident, under-26 and over-60 deals, updated daily.",
  },
  twitter: { card: "summary_large_image", images: ["/twitter-image"] },
};

export default function DealsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
