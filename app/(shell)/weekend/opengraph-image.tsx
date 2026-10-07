import { renderBrandOgImage, OG_IMAGE_SIZE } from "@/lib/og/brand-image";

export const runtime = "nodejs";

export const alt = "Fomo · This weekend in Edinburgh";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

/**
 * /weekend's own OG/Twitter image. Needed because this segment's page
 * (./page.tsx) sets its own `openGraph` — Next metadata objects REPLACE the
 * parent's `openGraph` wholesale rather than merging field-by-field, so
 * without a same-segment image file this route silently lost the branded
 * image (and siteName) the root layout otherwise provides. A segment-level
 * opengraph-image.tsx is picked up automatically and combined with that
 * metadata object, so it doesn't have this problem.
 */
export default async function Image() {
  return renderBrandOgImage("This weekend in Edinburgh");
}
