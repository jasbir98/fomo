import { test } from "node:test";
import assert from "node:assert/strict";
import { imageSize, photoRejection } from "./image-probe.mjs";

function png(width, height) {
  const b = new Uint8Array(40);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

function jpeg(width, height) {
  // SOI, an APP0 segment of length 16, then SOF0 with height/width.
  const b = new Uint8Array(64);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  const sof = 2 + 2 + 16;
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
  const dv = new DataView(b.buffer);
  dv.setUint16(sof + 5, height);
  dv.setUint16(sof + 7, width);
  return b;
}

function webpVp8x(width, height) {
  const b = new Uint8Array(40);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."WEBPVP8X"].map((c) => c.charCodeAt(0)), 8);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return b;
}

test("imageSize reads PNG, JPEG and WebP (VP8X) dimensions", () => {
  assert.deepEqual(imageSize(png(1200, 630)), { type: "png", width: 1200, height: 630 });
  assert.deepEqual(imageSize(jpeg(1600, 900)), { type: "jpeg", width: 1600, height: 900 });
  assert.deepEqual(imageSize(webpVp8x(1080, 1080)), { type: "webp", width: 1080, height: 1080 });
  assert.equal(imageSize(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")), null);
});

test("photoRejection keeps share-sized photos and drops logos", () => {
  assert.equal(photoRejection({ type: "jpeg", width: 1200, height: 630 }, 180_000), null);
  assert.equal(photoRejection({ type: "jpeg", width: 1080, height: 1350 }, 200_000), null);
  assert.match(photoRejection({ type: "png", width: 300, height: 300 }, 40_000), /too small/);
  assert.match(photoRejection({ type: "png", width: 1200, height: 200 }, 40_000), /too small|odd shape/);
  assert.match(photoRejection({ type: "png", width: 2400, height: 600 }, 90_000), /odd shape/);
  assert.match(photoRejection({ type: "png", width: 1200, height: 630 }, 6_000), /too small a file/);
  assert.match(photoRejection(null, 100_000), /not a JPEG/);
});
