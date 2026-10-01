"use client";

import { useState } from "react";
import { SmartImage } from "@/components/ui";
import { categoryDefaultImage } from "@/lib/happenings/category-style";
import type { HappeningCategory } from "@/lib/happenings/types";

export interface DealPhotoProps {
  /** Photo candidates in priority order (a deal's own image, its place's photo...); nullish entries are skipped. The category default photo is always appended last, so a card never ends on a glyph tile. */
  sources: (string | null | undefined)[];
  category: HappeningCategory | null | undefined;
  width: number;
  height: number;
  className?: string;
}

/** Photo for a deal card. Walks `sources`, moving to the next on a load error, and ends on the category's default PHOTO (a bundled local raster, so it can't 404 for a remote-host reason). */
export function DealPhoto({ sources, category, width, height, className }: DealPhotoProps) {
  const [failed, setFailed] = useState(0);
  const chain = [...sources.filter((s): s is string => !!s), categoryDefaultImage(category)];
  const src = chain[Math.min(failed, chain.length - 1)];
  return <SmartImage src={src} alt="" width={width} height={height} className={className} onError={() => setFailed((n) => n + 1)} />;
}

export default DealPhoto;
