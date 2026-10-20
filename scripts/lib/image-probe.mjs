/**
 * image-probe.mjs — read an image's type and pixel size from its first bytes
 * (JPEG, PNG, WebP), and judge whether it looks like a photo of a place
 * rather than a logo or icon. Pure, no I/O, so it runs under `node --test`.
 * Used by scripts/place-og-images.mjs.
 */

export const MIN_PHOTO_WIDTH = 600;
export const MIN_PHOTO_HEIGHT = 300;
// Share images are usually ~1.9:1; a wide banner or a tall phone shot still
// passes. Logos tend to be tiny, square-ish on a small canvas, or a strip.
const MIN_ASPECT = 0.6;
const MAX_ASPECT = 2.6;
const MIN_BYTES = 15_000;

/** { type, width, height } from an image's leading bytes, or null if unrecognised. */
export function imageSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 30) return null;
  // PNG: signature, then IHDR width/height big-endian at 16/20.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: "png", width: readU32BE(b, 16), height: readU32BE(b, 20) };
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X chunk.
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8X") return { type: "webp", width: 1 + readU24LE(b, 24), height: 1 + readU24LE(b, 27) };
    if (chunk === "VP8 ") return { type: "webp", width: readU16LE(b, 26) & 0x3fff, height: readU16LE(b, 28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG: walk segments to the first SOFn marker.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { type: "jpeg", height: readU16BE(b, i + 5), width: readU16BE(b, i + 7) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + readU16BE(b, i + 2);
    }
    return null;
  }
  return null;
}

/** Why an image isn't usable as a place photo, or null when it is. */
export function photoRejection(probe, byteLength) {
  if (!probe) return "not a JPEG/PNG/WebP";
  if (byteLength < MIN_BYTES) return `too small a file (${Math.round(byteLength / 1000)}KB)`;
  if (probe.width < MIN_PHOTO_WIDTH || probe.height < MIN_PHOTO_HEIGHT) return `too small (${probe.width}x${probe.height})`;
  const aspect = probe.width / probe.height;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return `odd shape (${probe.width}x${probe.height})`;
  return null;
}

function ascii(b, at, n) {
  return String.fromCharCode(...b.slice(at, at + n));
}
function readU16BE(b, at) {
  return (b[at] << 8) | b[at + 1];
}
function readU16LE(b, at) {
  return b[at] | (b[at + 1] << 8);
}
function readU24LE(b, at) {
  return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
}
function readU32BE(b, at) {
  return ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
}
