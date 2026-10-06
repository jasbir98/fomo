"use client";

import { useState } from "react";
import { SmartImage } from "@/components/ui";
import { defaultImageFor } from "@/lib/happenings/category-style";
import type { HappeningCategory } from "@/lib/happenings/types";

export interface DealPhotoProps {
  /** Photo candidates in priority order (a deal's own image, its place's photo...); nullish entries are skipped. The themed/category default photo is always appended last, so a card never ends on a glyph tile. */
  sources: (string | null | undefined)[];
  category: HappeningCategory | null | undefined;
  /** Title and venue name of the deal, so the fallback photo can be keyword-themed (see `defaultImageFor`) instead of one photo per category. */
  title?: string | null;
  venueName?: string | null;
  width: number;
  height: number;
  className?: string;
}

/** Photo for a deal card. Walks `sources`, moving to the next on a load error, and ends on the themed/category default PHOTO (a bundled local raster, so it can't 404 for a remote-host reason). */
export function DealPhoto({ sources, category, title, venueName, width, height, className }: DealPhotoProps) {
  const [failed, setFailed] = useState(0);
  const chain = [...sources.filter((s): s is string => !!s), defaultImageFor({ category, title, venue_name: venueName })];
  const src = chain[Math.min(failed, chain.length - 1)];
  return <SmartImage src={src} alt="" width={width} height={height} className={className} onError={() => setFailed((n) => n + 1)} />;
}

export default DealPhoto;
