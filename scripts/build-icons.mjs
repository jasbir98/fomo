#!/usr/bin/env node
/**
 * build-icons.mjs — Regenerate raster app icons from a square SVG source.
 * Renders SVG to 192×192, 512×512, 180×180, and 1080×1080 PNG, plus maskable
 * variants. Flattens transparency to background colour for iOS.
 *
 * Usage:
 *   node scripts/build-icons.mjs [path/to/source.svg] [--bg=#031632]
 */

import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

// Parse CLI args
let sourcePath = path.join(repoRoot, "public", "icons", "icon.svg");
let bgColor = "#031632";

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--bg=")) {
    bgColor = arg.slice(5);
  } else if (!arg.startsWith("--")) {
    sourcePath = arg;
  }
}

// Ensure source path is absolute
if (!path.isAbsolute(sourcePath)) {
  sourcePath = path.join(repoRoot, sourcePath);
}

// Verify source exists and is readable
if (!fs.existsSync(sourcePath)) {
  console.error(`Error: source SVG not found: ${sourcePath}`);
  process.exit(1);
}

const svgBuffer = fs.readFileSync(sourcePath);

// Parse SVG to verify it's square
const svgStr = svgBuffer.toString("utf8");
const viewBoxMatch = svgStr.match(/viewBox\s*=\s*"([^"]+)"/);
if (!viewBoxMatch) {
  console.error("Error: source SVG has no viewBox");
  process.exit(1);
}

const [x, y, w, h] = viewBoxMatch[1].split(/\s+/).map(Number);
if (!Number.isFinite(w) || !Number.isFinite(h) || w !== h) {
  console.error(`Error: source SVG is not square (viewBox: ${w}×${h})`);
  process.exit(1);
}

const viewBoxSize = w;

// Define outputs: { path, size, maskable, flatten }
const outputs = [
  { path: path.join(repoRoot, "public", "icons", "icon-192.png"), size: 192, maskable: false, flatten: false },
  { path: path.join(repoRoot, "public", "icons", "icon-512.png"), size: 512, maskable: false, flatten: false },
  { path: path.join(repoRoot, "public", "icons", "icon-maskable-192.png"), size: 192, maskable: true, flatten: false },
  { path: path.join(repoRoot, "public", "icons", "icon-maskable-512.png"), size: 512, maskable: true, flatten: false },
  { path: path.join(repoRoot, "public", "icons", "apple-touch-icon-180.png"), size: 180, maskable: false, flatten: true },
  { path: path.join(repoRoot, "public", "brand", "fomo-instagram-icon.png"), size: 1080, maskable: false, flatten: false },
];

// Ensure output dirs exist
const dirsToCreate = new Set(outputs.map((o) => path.dirname(o.path)));
for (const dir of dirsToCreate) {
  fs.mkdirSync(dir, { recursive: true });
}

async function renderIcon(output) {
  let pipeline = sharp(svgBuffer, {
    density: Math.ceil((72 * output.size) / viewBoxSize * 2),
  });

  // For maskable icons: render at 80% size, center on bg
  if (output.maskable) {
    const scaledSize = Math.round(output.size * 0.8);
    const bgPipeline = sharp({
      create: {
        width: output.size,
        height: output.size,
        channels: 3,
        background: bgColor,
      },
    });

    pipeline = pipeline.resize(scaledSize, scaledSize, { fit: "contain", withoutEnlargement: false });

    // Composite scaled SVG centered on bg
    const svgPng = await pipeline.png().toBuffer();
    pipeline = bgPipeline.composite([
      {
        input: svgPng,
        left: Math.round((output.size - scaledSize) / 2),
        top: Math.round((output.size - scaledSize) / 2),
      },
    ]);
  } else if (output.flatten) {
    // Flatten transparency to bg color
    pipeline = pipeline.resize(output.size, output.size, { fit: "contain", withoutEnlargement: false });
    const pngBuffer = await pipeline.png().toBuffer();
    pipeline = sharp(pngBuffer).flatten({ background: bgColor });
  } else {
    // Standard render
    pipeline = pipeline.resize(output.size, output.size, { fit: "contain", withoutEnlargement: false });
  }

  await pipeline.png({ compressionLevel: 9 }).toFile(output.path);

  // Read back to get dimensions
  const metadata = await sharp(output.path).metadata();
  console.log(`✓ ${path.relative(repoRoot, output.path)} (${metadata.width}×${metadata.height})`);
}

async function main() {
  try {
    for (const output of outputs) {
      await renderIcon(output);
    }
    console.log("\nDone.");
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
