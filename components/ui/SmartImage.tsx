"use client";

import { useState } from "react";
import Image from "next/image";
import { cdnResize, isKnownImageHost, isOptimizableRemote } from "@/lib/image/cdn";

export type SmartImageProps = {
  src: string | null | undefined;
  alt: string;
  /** Rendered CSS width in px at the largest breakpoint — drives the transform width. */
  width: number;
  height: number;
  className?: string;
  /** true for above-the-fold hero images: eager + fetchPriority high + no lazy. */
  priority?: boolean;
  sizes?: string;
  /** Rendered when `src` is missing or fails to load. */
  fallback?: React.ReactNode;
  onError?: () => void;
};

// Small cards, not full-bleed photography — 70 keeps them visually
// indistinguishable from the originals while cutting file size substantially.
const QUALITY = 70;
// Matches lib/image/cdn.ts's own clamp so a huge `width` prop can't request
// an oversized transform from either the CDN or next/image.
const MAX_WIDTH = 2048;

/**
 * The single `<img>` primitive for the app. Three render paths, in order:
 *
 * 1. `cdnResize()` recognises the host (Unsplash, Supabase Storage, Google
 *    Places/googleusercontent, GetYourGuide, Wikimedia Commons) → a plain
 *    `<img>` pointing at the upstream CDN's own resized variant, with a
 *    1x/2x `srcSet`. Free, and one less hop than Next's optimizer.
 * 2. Unrecognised host, but a genuine remote http(s) URL → `next/image`,
 *    which still gets AVIF/WebP + resizing from Vercel (billed, but the
 *    only option for hosts with no public resize API, e.g. Ticketmaster).
 * 3. Anything else (local `/public` paths, `data:`/`blob:` URIs, malformed
 *    URLs) → a plain `<img>` with no rewriting — nothing left to optimize,
 *    or nothing safe to touch.
 *
 * `fallback` only ever replaces the image when `src` is missing, or after a
 * load error IF `fallback` was supplied — callers that already manage their
 * own error state (swapping `src` to a default image, or conditionally
 * unmounting this component entirely) keep working unchanged, since this
 * component still calls their `onError` either way.
 */
export function SmartImage({
  src,
  alt,
  width,
  height,
  className = "",
  priority = false,
  sizes,
  fallback,
  onError,
}: SmartImageProps) {
  const [errored, setErrored] = useState(false);
  // A new `src` (e.g. a caller swapping to its own default-image fallback
  // after an error) deserves a fresh attempt, not a permanently-stuck
  // fallback — reset during render rather than in an effect (React's
  // "adjusting state when a prop changes" pattern) to avoid an extra
  // cascading render.
  const [prevSrc, setPrevSrc] = useState(src);
  if (src !== prevSrc) {
    setPrevSrc(src);
    setErrored(false);
  }

  function handleError() {
    setErrored(true);
    onError?.();
  }

  if (!src) return <>{fallback ?? null}</>;
  if (errored && fallback) return <>{fallback}</>;

  const targetWidth = Math.min(width * 2, MAX_WIDTH);
  const retina = cdnResize(src, { width: targetWidth, quality: QUALITY });

  if (retina) {
    const standard = cdnResize(src, { width, quality: QUALITY }) ?? retina;
    const srcSet = `${standard} 1x, ${retina} 2x`;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={retina}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        width={width}
        height={height}
        className={className}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
        onError={handleError}
      />
    );
  }

  if (isOptimizableRemote(src)) {
    // `unoptimized` defaults to `true` (i.e. "assume NOT configured") unless
    // `isKnownImageHost` positively confirms the hostname matches one of
    // `REMOTE_IMAGE_HOSTNAMES` — never the other way around. Both a parse
    // failure here (shouldn't happen; `isOptimizableRemote` above already
    // parsed `src` successfully) and any future drift in the matcher fail
    // *closed* onto the safe side: an unoptimized image (heavier, no AVIF/
    // WebP) instead of next/image's real hostname check throwing "Invalid
    // src prop ... hostname is not configured" mid-render and crashing the
    // whole page. Cheap insurance on top of `isKnownImageHost` itself now
    // matching next/image's real (picomatch-backed) semantics exactly.
    let knownHost = false;
    try {
      knownHost = isKnownImageHost(new URL(src).hostname);
    } catch {
      knownHost = false;
    }
    return (
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        quality={QUALITY}
        priority={priority}
        className={className}
        unoptimized={!knownHost}
        onError={handleError}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      onError={handleError}
    />
  );
}

export default SmartImage;
