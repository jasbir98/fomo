import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = pageMetadata({
  title: "What's on in Edinburgh",
  description: "Free and cheap gigs, comedy, cinema, food and days out in Edinburgh, by date.",
  path: "/whats-on",
});

export default function WhatsOnLayout({ children }: { children: React.ReactNode }) {
  return children;
}
