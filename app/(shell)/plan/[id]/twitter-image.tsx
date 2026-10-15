import { renderPlanReceiptImage } from "@/lib/og/receipt-image";
import { OG_IMAGE_SIZE } from "@/lib/og/brand-image";
import { getPlan } from "@/lib/plans/db";

export const runtime = "nodejs";

export const alt = "A weekend plan on Fomo: the picks, their prices and the total";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/jpeg";

/**
 * Rendered once per plan on first request, then kept in Vercel's ISR cache
 * (shared by every region) instead of re-rendering per edge: a cold render
 * fetches up to four photos and can take seconds, longer than WhatsApp waits
 * for a link preview. POST /api/plans also requests it right after making the
 * plan, so it's ready before anyone pastes the link. A plan never changes.
 */
export function generateStaticParams() {
  return [];
}
export const revalidate = false;

/** Same receipt as ./opengraph-image.tsx (route config can't be re-exported, so it's restated). */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A failed lookup throws rather than caching the fallback card forever.
  const plan = await getPlan(id);
  return renderPlanReceiptImage(plan);
}
