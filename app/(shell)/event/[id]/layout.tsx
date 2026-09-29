import type { Metadata } from "next";
import { supabaseServer } from "@/lib/supabase/server";
import { getEvent } from "@/lib/db/events";
import { formatEventPrice, formatEventWhen } from "@/lib/events/format";

/**
 * Server-side link preview for an event — mirrors
 * app/(shell)/happening/[id]/layout.tsx exactly (same rationale: the page
 * itself is a client component, so this is where a shared link gets its
 * title/blurb/photo; `events` is readable by anon under RLS, so this works
 * signed out; any lookup failure falls back to root metadata rather than
 * failing the page).
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  try {
    const event = await getEvent(await supabaseServer(), id);
    if (!event) return {};
    const description =
      [
        formatEventWhen(event.starts_at, event.ends_at),
        event.venue_name,
        formatEventPrice(event) || null,
        event.description,
      ]
        .filter(Boolean)
        .join(" · ") || undefined;
    // Always a concrete image — the event's own photo, or the branded
    // default OG image — same reasoning as the happening layout's own doc
    // comment: an explicit `openGraph.images` here replaces rather than
    // merges with the file-convention default.
    const images = [event.image_url || "/opengraph-image"];
    return {
      title: event.name,
      description,
      openGraph: { title: event.name, description, images, type: "article" },
      twitter: { card: "summary_large_image", title: event.name, description, images },
    };
  } catch {
    return {};
  }
}

export default function EventLayout({ children }: { children: React.ReactNode }) {
  return children;
}
