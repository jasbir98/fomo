import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HappeningDetail } from "@/components/detail/HappeningDetail";
import { JsonLd } from "@/components/seo/JsonLd";
import { loadHappeningDetail, type HappeningDetailData } from "@/lib/happenings/detail";
import { supabaseAnon } from "@/lib/supabase/anon";
import { breadcrumbJsonLd, listPageForHappening } from "@/lib/seo/breadcrumbs";
import { pageMetadata } from "@/lib/seo/metadata";
import { happeningSeo } from "@/lib/seo/detail";
import { SITE_DESCRIPTION } from "@/lib/seo/site";

/**
 * Prerender nothing at build time. Exporting this (even empty) is what lets
 * Next cache each page on first request and re-build it on the timer below,
 * instead of rendering it fresh for every visitor.
 */
export function generateStaticParams() {
  return [];
}

/** Re-built at most every five minutes; a deal's row changes rarely and the client refreshes its own copy on load. */
export const revalidate = 300;

/**
 * Uses the cookie-less anon client and the page stays cacheable.
 * loadHappeningDetail reads the requested row itself through the service role
 * (the public RLS read is live-only, supabase/live_only_public_read.sql, and
 * an ended deal's link must still open); the anon client here only serves its
 * live-only sibling and place lookups. `cache()` shares the one lookup
 * between generateMetadata and the page. Null means the lookup itself
 * failed (not that the deal is missing): the page then renders the client
 * component's own loading path rather than a false 404.
 */
const loadHappening = cache(async (id: string): Promise<HappeningDetailData | null> => {
  try {
    return await loadHappeningDetail(supabaseAnon(), id);
  } catch (err) {
    console.error("[happening page] lookup failed", err);
    return null;
  }
});

/**
 * Server-side title, description and share card for a happening: what Google
 * shows in results and what WhatsApp/Instagram/iMessage show for a shared
 * link. Falls back to the root metadata when the lookup fails.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const happening = (await loadHappening(id))?.happening;
  if (!happening) return {};
  const seo = happeningSeo(happening);
  return pageMetadata({
    title: happening.title,
    description: seo.description ?? SITE_DESCRIPTION,
    path: `/happening/${id}`,
    // Always a concrete image: the happening's own photo, or the branded
    // default card, rather than leaving `images` unset (an explicit
    // `openGraph.images` replaces the file-convention default).
    images: [happening.image_url || "/opengraph-image"],
    type: "article",
    noindex: seo.noindex,
  });
}

/**
 * Happening detail route. The whole page lives in components/detail/
 * HappeningDetail.tsx so the desktop overlay (components/detail/
 * DetailOverlayProvider.tsx) can render the same thing as a modal. This
 * server component hands it the row so the first HTML holds the real
 * title, price, date and venue instead of a spinner.
 */
export default async function HappeningDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadHappening(id);
  if (data && !data.happening) notFound();
  const happening = data?.happening;
  const jsonLd = happening ? happeningSeo(happening, new Date(), data.venueWebsite).jsonLd : null;
  return (
    <>
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
      {happening ? <JsonLd data={breadcrumbJsonLd(listPageForHappening(happening), happening.title, `/happening/${id}`)} /> : null}
      <HappeningDetail id={id} initialData={data ?? undefined} />
    </>
  );
}
