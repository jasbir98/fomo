"use client";

import { useState } from "react";
import { Icon } from "./Icon";
import { SmartImage } from "./SmartImage";

export type CarouselPhoto = {
  url: string;
  alt?: string;
  credit?: string;
};

export type PhotoCarouselProps = {
  photos: CarouselPhoto[];
  className?: string;
};

/**
 * Full-bleed photo carousel for a place's detail-page hero. Renders one photo
 * at a time with tap-to-advance zones + dot indicators when there's more than
 * one photo; a single photo renders plain (no controls); zero photos renders
 * the existing placeholder icon so callers don't need their own empty state.
 */
export function PhotoCarousel({ photos, className = "" }: PhotoCarouselProps) {
  const [index, setIndex] = useState(0);

  if (photos.length === 0) {
    return (
      <div className={`flex h-full w-full items-center justify-center bg-surface-container ${className}`}>
        <Icon name="image" size={40} className="text-outline" />
      </div>
    );
  }

  const active = photos[Math.min(index, photos.length - 1)];
  const multi = photos.length > 1;

  function go(delta: number) {
    setIndex((i) => (i + delta + photos.length) % photos.length);
  }

  return (
    <div className={`relative h-full w-full overflow-hidden ${className}`}>
      <SmartImage
        src={active.url}
        alt={active.alt ?? ""}
        width={480}
        height={256}
        sizes="(min-width: 1024px) 720px, (max-width: 480px) 100vw, 480px"
        priority={index === 0}
        className="h-full w-full object-cover"
      />

      {multi ? (
        <>
          <button
            type="button"
            aria-label="Previous photo"
            onClick={() => go(-1)}
            className="absolute inset-y-0 left-0 z-10 w-1/3"
          />
          <button
            type="button"
            aria-label="Next photo"
            onClick={() => go(1)}
            className="absolute inset-y-0 right-0 z-10 w-1/3"
          />
          <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5">
            {photos.map((_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className={`h-1.5 rounded-full shadow-sm transition-all ${
                  i === index ? "w-4 bg-white" : "w-1.5 bg-white/60"
                }`}
              />
            ))}
          </div>
        </>
      ) : null}

      {active.credit ? (
        <span className="absolute bottom-3 right-3 z-20 rounded-full bg-black/50 px-2 py-0.5 text-label-sm font-medium text-white backdrop-blur-sm">
          {active.credit}
        </span>
      ) : null}
    </div>
  );
}

export default PhotoCarousel;
