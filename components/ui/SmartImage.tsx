"use client";

import { useState } from "react";
import Image from "next/image";
import { cdnResize, isKnownImageHost, isOptimizableRemote, toHttpsUrl } from "@/lib/image/cdn";
import { Icon } from "./Icon";

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

/** Generic broken/missing-image tile — same treatment PhotoCarousel already
 *  uses for its own zero-photos state, reused here so every SmartImage
 *  caller that doesn't supply its own `fallback` still degrades to a neutral
 *  box instead of the browser's broken-image icon. Sized purely by the
 *  caller's own `className` (the same Tailwind sizing classes that would
 *  otherwise size the `<img>`) rather than inline width/height, so it fills
 *  whatever box the caller already laid out instead of a fixed pixel size. */
function DefaultFallback({ width, height, className }: { width: number; height: number; className: string }) {
  const iconSize = Math.max(16, Math.min(width, height, 40));
  return (
    <div className={`flex items-center justify-center bg-surface-container ${className}`}>
      <Icon name="image" size={iconSize} className="text-outline" />
    </div>
  );
}

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
 * Before any of that, a plain `http://` `src` is upgraded to `https://`
 * (`toHttpsUrl`, lib/image/cdn.ts) — this app's CSP `img-src` only allows
 * `https:`/`data:`/`blob:`, so an un-rewritten `http://` URL (scraped source
 * data sometimes stores one even though the host serves https) is silently
 * dropped by the browser rather than fetched at all.
 *
 * `fallback` replaces the image when `src` is missing, or after a load
 * error — callers that already manage their own error state (swapping `src`
 * to a default image, or conditionally unmounting this component entirely)
 * keep working unchanged, since this component still calls their `onError`
 * either way. Callers that pass no `fallback` still get a neutral
 * placeholder tile instead of a broken-image box (`DefaultFallback` below) —
 * most callers across the app don't currently pass one.
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

  if (!src) return <>{fallback ?? <DefaultFallback width={width} height={height} className={className} />}</>;
  if (errored) return <>{fallback ?? <DefaultFallback width={width} height={height} className={className} />}</>;

  // Upgrade a plain http:// src before it's ever handed to cdnResize/
  // next/image/a plain <img> — see toHttpsUrl's own doc comment.
  const httpsSrc = toHttpsUrl(src);

  const targetWidth = Math.min(width * 2, MAX_WIDTH);
  const retina = cdnResize(httpsSrc, { width: targetWidth, quality: QUALITY });

  if (retina) {
    const standard = cdnResize(httpsSrc, { width, quality: QUALITY }) ?? retina;
    const srcSet = `${standard} 1x, ${retina} 2x`;
    const isGoogleImage = httpsSrc.includes(".googleusercontent.com");
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
        referrerPolicy={isGoogleImage ? "no-referrer" : undefined}
        onError={handleError}
      />
    );
  }

  // Our own raster files under /public (e.g. the category default photos,
  // shipped at 1600px): let next/image resize them per placement and serve
  // AVIF/WebP, so a 64px thumbnail never downloads the full banner.
  if (httpsSrc.startsWith("/") && !httpsSrc.startsWith("//") && !httpsSrc.endsWith(".svg")) {
    return (
      <Image
        src={httpsSrc}
        alt={alt}
        width={width}
        height={height}
        sizes={sizes}
        quality={QUALITY}
        priority={priority}
        className={className}
        onError={handleError}
      />
    );
  }

  if (isOptimizableRemote(httpsSrc)) {
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
      knownHost = isKnownImageHost(new URL(httpsSrc).hostname);
    } catch {
      knownHost = false;
    }
    return (
      <Image
        src={httpsSrc}
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

  const isGoogleImage = httpsSrc.includes(".googleusercontent.com");
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={httpsSrc}
      alt={alt}
      width={width}
      height={height}
      className={className}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      referrerPolicy={isGoogleImage ? "no-referrer" : undefined}
      onError={handleError}
    />
  );
}

export default SmartImage;
