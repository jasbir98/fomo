import { renderBrandOgImage, OG_IMAGE_SIZE } from "@/lib/og/brand-image";

// Node runtime pinned explicitly (the mascot is embedded, so no fs access is needed).
export const runtime = "nodejs";

export const alt = "Fomo · Free & cheap in Edinburgh";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

/**
 * Branded default link-preview image (WhatsApp/iMessage/Slack/Twitter when a
 * page doesn't define its own openGraph.images or opengraph-image file —
 * every route without a more specific one inherits this via Next's file
 * convention, replacing the old static /icons/icon-512.png default that
 * used to live in app/layout.tsx's metadata).
 */
export default async function Image() {
  return renderBrandOgImage("Free & cheap in Edinburgh");
}
