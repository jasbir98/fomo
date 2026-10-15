import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlaceDetail } from "@/components/detail/PlaceDetail";
import { JsonLd } from "@/components/seo/JsonLd";
import { loadPlaceDetail, type PlaceDetailData } from "@/lib/places/detail";
import { supabaseAnon } from "@/lib/supabase/anon";
import { breadcrumbJsonLd, LIST_PAGES } from "@/lib/seo/breadcrumbs";
import { pageMetadata } from "@/lib/seo/metadata";
import { placeSeo } from "@/lib/seo/detail";
import { SITE_DESCRIPTION } from "@/lib/seo/site";

/**
 * Prerender nothing at build time. Exporting this (even empty) is what lets
 * Next cache each page on first request and re-build it on the timer below,
 * instead of rendering it fresh for every visitor.
 */
export function generateStaticParams() {
  return [];
}

/** Re-built at most every five minutes; the client refreshes its own copy on load. */
export const revalidate = 300;

/**
 * Places, offers and events are all `read_all` to anon under RLS, so this
 * uses the cookie-less client and the page stays cacheable. `cache()` shares
 * the one lookup between generateMetadata and the page. Null means the lookup
 * itself failed (not that the place is missing): the page then renders the
 * client component's own loading path rather than a false 404.
 */
const loadPlace = cache(async (id: string): Promise<PlaceDetailData | null> => {
  try {
    return await loadPlaceDetail(supabaseAnon(), id);
  } catch (err) {
    console.error("[place page] lookup failed", err);
    return null;
  }
});

/**
 * Server-side title, description and share card for a place: what Google
 * shows in results and what WhatsApp/Instagram/iMessage show for a shared
 * link. Falls back to the root metadata when the lookup fails.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const data = await loadPlace(id);
  if (!data?.place) return {};
  const seo = placeSeo({ place: data.place, offers: data.offers, events: data.events });
  return pageMetadata({
    title: data.place.name ?? undefined,
    description: seo.description ?? SITE_DESCRIPTION,
    path: `/place/${id}`,
    // Always a concrete image: the place's own photo (or its first carousel
    // photo), or the branded default card (an explicit `openGraph.images`
    // replaces the file-convention default).
    images: [data.place.image_url || data.photos[0]?.url || "/opengraph-image"],
    type: "article",
    noindex: seo.noindex,
  });
}

/**
 * Place detail route. The whole page lives in components/detail/PlaceDetail.tsx
 * so the desktop overlay (components/detail/DetailOverlayProvider.tsx) can
 * render the same thing as a modal. This server component hands it the rows
 * so the first HTML holds the real name, details, offers and events instead
 * of a spinner.
 */
export default async function PlaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadPlace(id);
  if (data && !data.place) notFound();
  const place = data?.place;
  const jsonLd = place && data ? placeSeo({ place, offers: data.offers, events: data.events }).jsonLd : null;
  return (
    <>
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
      {place?.name ? <JsonLd data={breadcrumbJsonLd(LIST_PAGES.explore, place.name, `/place/${id}`)} /> : null}
      <PlaceDetail id={id} initialData={data ?? undefined} />
    </>
  );
}
