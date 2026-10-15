import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EventDetail } from "@/components/detail/EventDetail";
import { JsonLd } from "@/components/seo/JsonLd";
import { getEvent } from "@/lib/db/events";
import { supabaseAnon } from "@/lib/supabase/anon";
import { breadcrumbJsonLd, LIST_PAGES } from "@/lib/seo/breadcrumbs";
import { pageMetadata } from "@/lib/seo/metadata";
import { eventSeo } from "@/lib/seo/detail";
import { SITE_DESCRIPTION } from "@/lib/seo/site";
import type { EventItem } from "@/lib/types";

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
 * `events` is readable by anon under RLS, so this uses the cookie-less client
 * and the page stays cacheable. `cache()` shares the one lookup between
 * generateMetadata and the page. `undefined` means the lookup itself failed
 * (not that the event is missing): the page then renders the client
 * component's own loading path rather than a false 404.
 */
const loadEvent = cache(async (id: string): Promise<EventItem | null | undefined> => {
  try {
    return await getEvent(supabaseAnon(), id);
  } catch (err) {
    console.error("[event page] lookup failed", err);
    return undefined;
  }
});

/**
 * Server-side title, description and share card for an event: what Google
 * shows in results and what WhatsApp/Instagram/iMessage show for a shared
 * link. Falls back to the root metadata when the lookup fails.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const event = await loadEvent(id);
  if (!event) return {};
  const seo = eventSeo(event);
  return pageMetadata({
    title: event.name,
    description: seo.description ?? SITE_DESCRIPTION,
    path: `/event/${id}`,
    // Always a concrete image: the event's own photo, or the branded default
    // card (an explicit `openGraph.images` replaces the file-convention default).
    images: [event.image_url || "/opengraph-image"],
    type: "article",
    noindex: seo.noindex,
  });
}

/**
 * Event detail route. The whole page lives in components/detail/EventDetail.tsx
 * so the desktop overlay (components/detail/DetailOverlayProvider.tsx) can
 * render the same thing as a modal. This server component hands it the row so
 * the first HTML holds the real title, price, date and venue instead of a spinner.
 */
export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await loadEvent(id);
  if (event === null) notFound();
  const jsonLd = event ? eventSeo(event).jsonLd : null;
  return (
    <>
      {jsonLd ? <JsonLd data={jsonLd} /> : null}
      {event ? <JsonLd data={breadcrumbJsonLd(LIST_PAGES.whatsOn, event.name, `/event/${id}`)} /> : null}
      <EventDetail id={id} initialEvent={event} />
    </>
  );
}
