/**
 * Photos for OG images. Satori only decodes PNG/JPEG/GIF and a whole share
 * card is capped by what WhatsApp will preview, so every photo goes through
 * sharp: fetched (or read from public/ for the bundled /defaults tiles),
 * cropped to the size it's drawn at, and re-encoded as a small JPEG data URL.
 * Anything that fails returns null and the caller draws a plain tile.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const FETCH_TIMEOUT_MS = 3500;
const MAX_BYTES = 8 * 1024 * 1024;

async function sourceBytes(src: string): Promise<Buffer | null> {
  if (src.startsWith("/")) {
    // Only the bundled default tiles; never an arbitrary path.
    if (!src.startsWith("/defaults/") || src.includes("..")) return null;
    return readFile(path.join(process.cwd(), "public", src));
  }
  if (!/^https?:\/\//i.test(src)) return null;
  const res = await fetch(src.replace(/^http:\/\//i, "https://"), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; FomoOG/1.0; +https://askfomo.com)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.byteLength > MAX_BYTES ? null : buf;
}

/** A `width`x`height` cover-cropped JPEG data URL, or null. */
export async function ogPhoto(src: string | null | undefined, width: number, height: number): Promise<string | null> {
  if (!src) return null;
  try {
    const bytes = await sourceBytes(src);
    if (!bytes) return null;
    const jpeg = await sharp(bytes, { failOn: "none" })
      .rotate()
      .resize(Math.round(width), Math.round(height), { fit: "cover", position: "attention" })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch (err) {
    console.warn(`[og] photo failed for ${src}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Re-encodes an ImageResponse's PNG as a JPEG small enough for WhatsApp's link preview (~300 KB cap). */
export async function pngResponseToJpeg(png: Response, quality = 80): Promise<Buffer> {
  const buf = Buffer.from(await png.arrayBuffer());
  return sharp(buf).jpeg({ quality, mozjpeg: true }).toBuffer();
}
