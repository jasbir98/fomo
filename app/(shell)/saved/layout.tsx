import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = pageMetadata({
  title: "Saved",
  description: "Your saved things to do in Edinburgh.",
  path: "/saved",
  noindex: true,
});

export default function SavedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
