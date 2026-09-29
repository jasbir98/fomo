import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "This weekend in Edinburgh",
  description: "Free, cheap and discounted things to do in Edinburgh this weekend. Events, student deals and offers.",
  openGraph: {
    title: "This weekend in Edinburgh · Fomo",
    description: "Free, cheap and discounted things to do in Edinburgh this weekend.",
  },
};

export default function WeekendLayout({ children }: { children: React.ReactNode }) {
  return children;
}
