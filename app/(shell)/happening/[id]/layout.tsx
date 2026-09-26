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
    const description = [happening.saving_label, happening.summary].filter(Boolean).join(" — ") || undefined;
    const images = happening.image_url ? [happening.image_url] : undefined;
    return {
      title: happening.title,
      description,
      openGraph: { title: happening.title, description, images, type: "article" },
      twitter: { card: images ? "summary_large_image" : "summary", title: happening.title, description, images },
    };
  } catch {
    return {};
  }
}

export default function HappeningLayout({ children }: { children: React.ReactNode }) {
  return children;
}
