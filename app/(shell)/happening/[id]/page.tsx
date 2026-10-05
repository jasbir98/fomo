"use client";

import { use } from "react";
import { HappeningDetail } from "@/components/detail/HappeningDetail";

/**
 * Happening detail route. The whole page lives in components/detail/
 * HappeningDetail.tsx so the desktop overlay (components/detail/
 * DetailOverlayProvider.tsx) can render the same thing as a modal.
 */
export default function HappeningDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <HappeningDetail id={id} />;
}
