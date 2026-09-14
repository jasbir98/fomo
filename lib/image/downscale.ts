/**
 * Client-side image downscaling for the Translator's photo capture flow.
 *
 * Vercel Hobby serverless functions reject request bodies over ~4.5 MB, and
 * base64 inflates an image's decoded byte size by ~4/3. A full-resolution
 * phone camera photo (often 3-8+ MB) would blow past that on its own, so we
 * downscale + recompress in the browser before it's base64-encoded and
 * POSTed to /api/translate.
 *
 * Browser-only (canvas/Image/createImageBitmap) — only ever import this from
 * client components.
 */

const MAX_LONGEST_SIDE = 1600;
/** Soft target — comfortably under app/api/translate/route.ts's server-side cap. */
const TARGET_BYTES = 1.5 * 1024 * 1024;

const ATTEMPTS: Array<{ maxSide: number; quality: number }> = [
  { maxSide: MAX_LONGEST_SIDE, quality: 0.82 },
  { maxSide: MAX_LONGEST_SIDE, quality: 0.7 },
  { maxSide: 1200, quality: 0.7 },
];

/** Thrown when the browser can't decode the source file at all (e.g. HEIC
 * without a native decoder). Callers should show a friendly message rather
 * than a generic failure. */
export class UnsupportedImageError extends Error {
  constructor(message = "This photo format isn't supported by your browser.") {
    super(message);
    this.name = "UnsupportedImageError";
  }
}

export interface DownscaledImage {
  /** Raw base64 image data — no `data:` prefix. */
  base64: string;
  /** Full data URL, for thumbnails. */
  dataUrl: string;
  /** Output MIME type — "image/jpeg" or "image/png". */
  mediaType: string;
  /** Output dimensions after downscaling. */
  width: number;
  height: number;
  /** Decoded byte size of the output (before base64 inflation). */
  bytes: number;
}

async function decodeToBitmapSource(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to <img> — some browsers can't createImageBitmap certain
      // formats (notably HEIC) even though <img> can display them via a
      // native/OS decoder, or vice versa.
    }
  }

  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new UnsupportedImageError());
    };
    img.src = url;
  });
}

function sourceDimensions(src: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  if (src instanceof HTMLImageElement) {
    return { width: src.naturalWidth, height: src.naturalHeight };
  }
  return { width: src.width, height: src.height };
}

function targetDimensions(
  width: number,
  height: number,
  maxSide: number
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height }; // never upscale
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas export failed"))),
      type,
      quality
    );
  });
}

/** Cheap alpha-channel scan — at most ~2.5M pixels post-downscale. */
function hasTransparency(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode, downscale (longest side <= 1600px, never upscaled) and recompress
 * `file` for upload. Retries at lower quality / smaller size until under
 * ~1.5 MB or out of attempts (the last attempt's result is returned
 * regardless of size — best effort). PNG sources with real transparency are
 * kept as PNG on the first attempt when small enough; everything else
 * (including a too-large transparent PNG, flattened onto white) becomes
 * JPEG.
 *
 * Throws `UnsupportedImageError` for formats the browser can't decode at all
 * (e.g. HEIC on a browser without a built-in decoder) — callers should show
 * a friendly "try a JPEG or screenshot" message rather than a generic one.
 */
export async function downscaleImage(file: File): Promise<DownscaledImage> {
  let src: ImageBitmap | HTMLImageElement;
  try {
    src = await decodeToBitmapSource(file);
  } catch (err) {
    if (err instanceof UnsupportedImageError) throw err;
    throw new UnsupportedImageError();
  }

  const { width: srcWidth, height: srcHeight } = sourceDimensions(src);
  if (!srcWidth || !srcHeight) throw new UnsupportedImageError();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const isPng = file.type === "image/png";
  let lastBlob: Blob | null = null;
  let lastDims = { width: srcWidth, height: srcHeight };

  for (let i = 0; i < ATTEMPTS.length; i++) {
    const { maxSide, quality } = ATTEMPTS[i];
    const dims = targetDimensions(srcWidth, srcHeight, maxSide);
    lastDims = dims;
    canvas.width = dims.width;
    canvas.height = dims.height;
    ctx.clearRect(0, 0, dims.width, dims.height);
    ctx.drawImage(src, 0, 0, dims.width, dims.height);

    let outType = "image/jpeg";
    if (isPng && i === 0 && hasTransparency(ctx, dims.width, dims.height)) {
      outType = "image/png";
    } else {
      // Flatten onto white before JPEG export — JPEG has no alpha channel,
      // and leaving transparent pixels un-flattened composites onto black
      // in some decoders.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, dims.width, dims.height);
      ctx.globalCompositeOperation = "source-over";
    }

    const blob = await canvasToBlob(canvas, outType, outType === "image/jpeg" ? quality : undefined);
    lastBlob = blob;

    if (blob.size <= TARGET_BYTES) break;
  }

  if (!lastBlob) throw new Error("Failed to encode image");

  const dataUrl = await blobToDataUrl(lastBlob);
  const commaIndex = dataUrl.indexOf(",");
  const base64 = commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);

  if (src instanceof ImageBitmap) src.close();

  return {
    base64,
    dataUrl,
    mediaType: lastBlob.type || "image/jpeg",
    width: lastDims.width,
    height: lastDims.height,
    bytes: lastBlob.size,
  };
}
