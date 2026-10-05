import type { Metadata } from "next";
import { supabaseServer } from "@/lib/supabase/server";
import { getPlace } from "@/lib/db/places";

/**
 * Server-side link preview for a place. The page itself is a client
 * component, so this layout is where shared links (WhatsApp, Instagram DMs,
 * iMessage) get their title, blurb and photo. Places are `read_all` to
 * anon under RLS, so this works signed out. Any lookup failure falls back to
 * the root metadata rather than failing the page.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  try {
    const place = await getPlace(await supabaseServer(), id);
    if (!place) return {};
    // "Park in Morningside, Edinburgh · on Fomo"
    const kind = place.category ? place.category.charAt(0).toUpperCase() + place.category.slice(1) : "Place";
    const area = place.city || place.destination;
    const description = `${kind} in ${area && area !== "Edinburgh" ? `${area}, Edinburgh` : "Edinburgh"} · free and cheap things nearby on Fomo`;
    // Always a concrete image: the place's own photo, or the branded
    // default OG image (app/opengraph-image.tsx) rather than leaving
    // `images` undefined — an explicit `openGraph.images` here REPLACES
    // rather than merges with the parent/file-convention default (see the
    // /weekend layout's own doc comment for the same Next metadata quirk),
    // so a place with no photo would otherwise share with no image at
    // all instead of falling back to it.
    const images = [(place.image_url || "/opengraph-image") as string];
    const titleStr = place.name || undefined;
    return {
      title: titleStr,
      description,
      openGraph: { title: titleStr, description, images, type: "article" },
      twitter: { card: "summary_large_image", title: titleStr, description, images },
    };
  } catch {
    return {};
  }
}

export default function PlaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
