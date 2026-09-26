import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tip us off",
  description: "Know a free event or a deal in Edinburgh we're missing? Tell us.",
};

export default function TipLayout({ children }: { children: React.ReactNode }) {
  return children;
}
