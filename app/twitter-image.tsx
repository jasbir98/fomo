// Same image as opengraph-image.tsx, exposed under the twitter-image file
// convention too — Twitter/X doesn't always fall back to og:image, and the
// root layout sets `twitter.card = "summary_large_image"`. Route segment
// config (`runtime`) can't be re-exported, so it's declared here directly.
import { renderBrandOgImage, OG_IMAGE_SIZE } from "@/lib/og/brand-image";

export const runtime = "nodejs";

export const alt = "Fomo — free & cheap in Edinburgh";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default async function Image() {
  return renderBrandOgImage("Free & cheap in Edinburgh");
}
