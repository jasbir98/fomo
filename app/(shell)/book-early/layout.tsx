import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = pageMetadata({
  title: "Book early in Edinburgh",
  description: "Big Edinburgh dates worth booking before they sell out.",
  path: "/book-early",
});

export default function BookEarlyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
