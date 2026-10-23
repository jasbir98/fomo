import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { APP_ENV } from "@/lib/analytics/exceptions";
import { ErrorsClient } from "./ErrorsClient";

export const metadata: Metadata = { title: "Exception test", robots: { index: false, follow: false } };

export const dynamic = "force-dynamic";

/**
 * Throws test exceptions on purpose, to check what lands in PostHog (see
 * docs/analytics.md, "Exceptions"). 404 on production; works on previews and
 * locally (`next start`, or `next dev` with NEXT_PUBLIC_POSTHOG_DEBUG=1).
 * `?throw=server` throws while rendering this server component.
 */
export default async function DebugErrorsPage({ searchParams }: { searchParams: Promise<{ throw?: string }> }) {
  if (APP_ENV === "production") notFound();
  if ((await searchParams).throw === "server") {
    throw new Error("Fomo test: server component exception");
  }
  return <ErrorsClient />;
}
