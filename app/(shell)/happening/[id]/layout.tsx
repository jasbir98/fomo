import type { Metadata } from "next";
import { supabaseServer } from "@/lib/supabase/server";
import { getHappeningById } from "@/lib/db/happenings";

/**
 * Server-side link preview for a happening. The page itself is a client
 * component, so this layout is where shared links (WhatsApp, Instagram DMs,
 * iMessage) get their title, blurb and photo. Happenings are `read_all` to
 * anon under RLS, so this works signed out. Any lookup failure falls back to
 * the root metadata rather than failing the page.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  try {
    const happening = await getHappeningById(await supabaseServer(), id);
    if (!happening) return {};
    const description = [happening.saving_label, happening.summary].filter(Boolean).join(" · ") || undefined;
    // Always a concrete image: the happening's own photo, or the branded
    // default OG image (app/opengraph-image.tsx) rather than leaving
    // `images` undefined — an explicit `openGraph.images` here REPLACES
    // rather than merges with the parent/file-convention default (see the
    // /weekend layout's own doc comment for the same Next metadata quirk),
    // so a happening with no photo would otherwise share with no image at
    // all instead of falling back to it.
    const images = [happening.image_url || "/opengraph-image"];
    return {
      title: happening.title,
      description,
      openGraph: { title: happening.title, description, images, type: "article" },
      twitter: { card: "summary_large_image", title: happening.title, description, images },
    };
  } catch {
    return {};
  }
}

export default function HappeningLayout({ children }: { children: React.ReactNode }) {
  return children;
}
