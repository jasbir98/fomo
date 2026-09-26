#!/usr/bin/env node
/**
 * ig-carousel.mjs — renders the same weekly picks scripts/lib/weekly-picks.mjs
 * builds for scripts/fomo-friday.mjs as a 1080x1350 Instagram carousel: a
 * cover slide, one slide per pick, and a CTA slide.
 *
 * ZERO EXTRA DEPENDENCIES. `next/og`'s `ImageResponse` (satori + resvg,
 * already bundled inside the `next` package this repo already depends on —
 * verified working standalone under plain Node 20, no Next.js request
 * context needed) renders each slide straight to a PNG buffer. No need for
 * a separate `satori`/`@resvg/resvg-js` devDependency pair.
 *
 * Always read-only / local-write only — writes PNGs and a caption file
 * under scripts/out/, never touches the DB.
 *
 * Usage:
 *   node --env-file=.env.local scripts/ig-carousel.mjs
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read-only
 * — same weekly-picks query scripts/fomo-friday.mjs uses).
 */
import { ImageResponse } from "next/og.js";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { getWeeklyPicks } from "./lib/weekly-picks.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node --env-file=.env.local scripts/ig-carousel.mjs

Renders the weekly picks as a 1080x1350 Instagram carousel (cover + one
slide per pick + CTA slide) to scripts/out/ig-<date>/NN.png, plus a
caption.txt with a ready-to-paste caption and hashtags. Read-only against
the DB; writes only to scripts/out/.
`);
  process.exit(0);
}

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "[ig-carousel] Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. " +
      "Run with: node --env-file=.env.local scripts/ig-carousel.mjs"
  );
  process.exit(1);
}

const WIDTH = 1080;
const HEIGHT = 1350;
const NAVY = "#1b365d";
const ACCENT = "#fc8a40"; // the brand's own orange dot/underline accent (components/ui/FomoLogo.tsx)
const WHITE = "#ffffff";

// --- font loading with caching ---
async function loadFonts() {
  const fontCacheDir = path.join(process.cwd(), "scripts", "out", ".fonts");
  await mkdir(fontCacheDir, { recursive: true });

  const fonts = [];
  const variants = [
    { weight: 400, file: "PlusJakartaSans-400.ttf" },
    { weight: 800, file: "PlusJakartaSans-800.ttf" },
  ];

  for (const variant of variants) {
    const fontPath = path.join(fontCacheDir, variant.file);
    let fontData;

    try {
      // Try to read cached font
      fontData = await readFile(fontPath);
    } catch {
      // Fetch from Google Fonts
      try {
        console.log(`[ig-carousel] Fetching ${variant.file}...`);
        const cssRes = await fetch(
          `https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@${variant.weight}`,
          { headers: { "User-Agent": "node" } }
        );
        if (!cssRes.ok) throw new Error(`CSS fetch failed: ${cssRes.status}`);
        const css = await cssRes.text();

        // Extract TTF URL from CSS (format: url(https://...ttf))
        const urlMatch = css.match(/url\((https:\/\/[^)]+\.ttf)\)/);
        if (!urlMatch) throw new Error("No TTF URL found in CSS");

        const ttfRes = await fetch(urlMatch[1]);
        if (!ttfRes.ok) throw new Error(`TTF fetch failed: ${ttfRes.status}`);
        fontData = Buffer.from(await ttfRes.arrayBuffer());

        // Cache it
        await writeFile(fontPath, fontData);
        console.log(`[ig-carousel] Cached ${variant.file}`);
      } catch (err) {
        console.warn(`[ig-carousel] Font fetch failed for weight ${variant.weight}:`, err.message);
        return null; // Fall back to default
      }
    }

    fonts.push({
      name: "Plus Jakarta Sans",
      data: fontData,
      weight: variant.weight,
    });
  }

  return fonts;
}

// --- tiny hyperscript so slide markup reads like JSX without a JSX build step ---
function h(type, props, ...children) {
  const flatChildren = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
  return { type, props: { ...props, children: flatChildren.length === 1 ? flatChildren[0] : flatChildren } };
}

function truncate(text, max) {
  if (!text || text.length <= max) return text ?? "";
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Clamp title to 3 lines (roughly 70 chars per line for the font size used). */
function clampTitle(text, maxChars = 70) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  // Truncate at maxChars with ellipsis
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Fetch and inline an image as a data URL, or return null if it fails. */
async function imageToDataUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    // Sniff the bytes rather than trust content-type: satori decodes only
    // PNG/JPEG/GIF, and a WebP/AVIF (or an HTML error page) crashes the render.
    const type =
      buffer[0] === 0x89 && buffer[1] === 0x50 ? "image/png"
      : buffer[0] === 0xff && buffer[1] === 0xd8 ? "image/jpeg"
      : buffer.subarray(0, 3).toString() === "GIF" ? "image/gif"
      : null;
    if (!type) return null;
    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch (err) {
    console.warn(`[ig-carousel] Image fetch failed for ${url}:`, err.message);
    return null;
  }
}

function baseSlide(children) {
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: NAVY,
        color: WHITE,
        fontFamily: "Plus Jakarta Sans",
        padding: "72px",
        position: "relative",
      },
    },
    children
  );
}

function wordmark() {
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", position: "absolute", top: 56, left: 72 } },
    h("div", { style: { display: "flex", width: 14, height: 14, borderRadius: 999, background: ACCENT, marginRight: 10 } }),
    h("div", { style: { fontSize: 30, fontWeight: 800, letterSpacing: 2, display: "flex" } }, "FOMO")
  );
}

function coverSlide() {
  return baseSlide([
    wordmark(),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" } },
      h(
        "div",
        { style: { fontSize: 88, fontWeight: 800, lineHeight: 1.05, display: "flex", flexWrap: "wrap" } },
        "This weekend in Edinburgh"
      ),
      h(
        "div",
        { style: { fontSize: 56, fontWeight: 700, color: ACCENT, marginTop: 24, display: "flex" } },
        "Free & cheap"
      )
    ),
    h(
      "div",
      { style: { display: "flex", fontSize: 30, color: "#c7d2e3" } },
      "Swipe for this weekend's picks →"
    ),
  ]);
}

function pickSlide(item, index, total, imageDataUrl) {
  const hasImage = !!imageDataUrl;
  const imageHeight = Math.round(HEIGHT * 0.55); // ~55% for image
  const panelHeight = HEIGHT - imageHeight;

  if (hasImage) {
    return h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: NAVY,
          color: WHITE,
          fontFamily: "Plus Jakarta Sans",
          position: "relative",
        },
      },
      // Image top section (using backgroundImage since img tags have rendering issues)
      h("img", {
        src: imageDataUrl,
        width: WIDTH,
        height: imageHeight,
        style: { width: WIDTH, height: imageHeight, objectFit: "cover" },
      }),
      // Navy panel bottom section
      h(
        "div",
        {
          style: {
            width: "100%",
            height: panelHeight,
            display: "flex",
            flexDirection: "column",
            padding: "40px 56px",
            justifyContent: "space-between",
            boxSizing: "border-box",
            paddingBottom: 56,
          },
        },
        // Middle: title + price pill inline
        h(
          "div",
          { style: { display: "flex", flexDirection: "column" } },
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 20, marginBottom: 16 } },
            h(
              "div",
              { style: { fontSize: 56, fontWeight: 800, lineHeight: 1.15, flex: 1, minWidth: 0, flexWrap: "wrap", display: "flex" } },
              clampTitle(item.title, 70)
            ),
            item.price
              ? h(
                "div",
                {
                  style: {
                    display: "flex",
                    background: item.price === "FREE" ? "#1e7d4c" : ACCENT,
                    color: WHITE,
                    fontSize: 32,
                    fontWeight: 800,
                    padding: "10px 24px",
                    borderRadius: 999,
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  },
                },
                item.price
              )
              : null
          ),
          item.when
            ? h("div", { style: { display: "flex", fontSize: 28, color: "#c7d2e3", marginBottom: 8 } }, item.when)
            : null,
          item.venue
            ? h("div", { style: { display: "flex", fontSize: 24, color: "#8b93a3" } }, truncate(item.venue, 46))
            : null
        )
      ),
      // Slide counter: top-right with semi-transparent dark pill
      h(
        "div",
        {
          style: {
            display: "flex",
            position: "absolute",
            top: 56,
            right: 72,
            fontSize: 32,
            fontWeight: 800,
            color: WHITE,
            background: "rgba(0, 0, 0, 0.5)",
            padding: "12px 24px",
            borderRadius: 999,
          },
        },
        `${index + 1} / ${total}`
      ),
      // Wordmark
      wordmark()
    );
  }

  // Fallback: all-navy layout (no image)
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: NAVY,
        color: WHITE,
        fontFamily: "Plus Jakarta Sans",
        padding: "72px",
        position: "relative",
      },
    },
    wordmark(),
    // Slide counter: top-right with semi-transparent dark pill
    h(
      "div",
      {
        style: {
          display: "flex",
          position: "absolute",
          top: 56,
          right: 72,
          fontSize: 32,
          fontWeight: 800,
          color: WHITE,
          background: "rgba(0, 0, 0, 0.5)",
          padding: "12px 24px",
          borderRadius: 999,
        },
      },
      `${index + 1} / ${total}`
    ),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: 20, marginBottom: 24 } },
        h(
          "div",
          { style: { fontSize: 64, fontWeight: 800, lineHeight: 1.12, flex: 1, minWidth: 0, flexWrap: "wrap", display: "flex" } },
          clampTitle(item.title, 70)
        ),
        item.price
          ? h(
            "div",
            {
              style: {
                display: "flex",
                background: item.price === "FREE" ? "#1e7d4c" : ACCENT,
                color: WHITE,
                fontSize: 40,
                fontWeight: 800,
                padding: "14px 32px",
                borderRadius: 999,
                flexShrink: 0,
                whiteSpace: "nowrap",
              },
            },
            item.price
          )
          : null
      ),
      item.when
        ? h("div", { style: { display: "flex", fontSize: 34, color: "#c7d2e3", marginBottom: 8 } }, item.when)
        : null,
      item.venue
        ? h("div", { style: { display: "flex", fontSize: 30, color: "#8b93a3" } }, truncate(item.venue, 46))
        : null
    )
  );
}

function ctaSlide() {
  return baseSlide([
    wordmark(),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", flex: 1, justifyContent: "center", alignItems: "flex-start" } },
      h("div", { style: { fontSize: 60, fontWeight: 800, lineHeight: 1.1, display: "flex", flexWrap: "wrap" } }, "Full list:"),
      h(
        "div",
        { style: { fontSize: 60, fontWeight: 800, color: ACCENT, marginTop: 12, display: "flex" } },
        "askfomo.com/weekend"
      ),
      h(
        "div",
        { style: { fontSize: 30, color: "#c7d2e3", marginTop: 36, display: "flex" } },
        "Free, cheap & deals — Edinburgh, every weekend."
      )
    ),
  ]);
}

const HASHTAGS = [
  "#edinburgh",
  "#edinburghstudents",
  "#thingstodoinedinburgh",
  "#edinburghlife",
  "#edinburghuni",
  "#freethingstodo",
  "#edinburghevents",
  "#scotstudent",
  "#visitscotland",
  "#edinburghscotland",
  "#budgettravel",
  "#studentlife",
  "#whatsoninedinburgh",
];

function buildCaption(picks) {
  const lines = [];
  lines.push("This weekend in Edinburgh 👀");
  lines.push("");
  for (const p of picks) {
    lines.push(`${p.price === "FREE" ? "🆓" : p.price ? "💷" : "📍"} ${p.title}${p.when ? ` — ${p.when}` : ""}`);
  }
  lines.push("");
  lines.push("Full list + more free/cheap things every week: askfomo.com/weekend");
  lines.push("");
  lines.push(HASHTAGS.join(" "));
  return lines.join("\n");
}

async function renderSlide(element, fonts) {
  const options = { width: WIDTH, height: HEIGHT };
  if (fonts) {
    options.fonts = fonts;
  }
  const res = new ImageResponse(element, options);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const { picks } = await getWeeklyPicks({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY });

  if (picks.length === 0) {
    console.error("[ig-carousel] No picks found for the window — nothing to render.");
    process.exit(1);
  }

  // Plus Jakarta Sans 400/800 (the app's brand face). Without it satori's
  // built-in font has no bold weight, so every title rendered thin.
  let fonts = null;
  try {
    fonts = await loadFonts();
  } catch (err) {
    console.warn("[ig-carousel] Font loading error, using the default font:", err.message);
  }

  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  const outDir = path.join(process.cwd(), "scripts", "out", `ig-${todayIso}`);
  // Same-day reruns reuse this folder: clear old slides so a stale 11.png
  // from a longer run can't end up in the post.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const imageDataUrls = await Promise.all(picks.map((p) => imageToDataUrl(p.image_url)));

  // Build slides with image data
  const totalSlides = picks.length + 2; // cover + picks + CTA
  const slides = [
    coverSlide(),
    ...picks.map((p, i) => pickSlide(p, i + 1, totalSlides, imageDataUrls[i])),
    ctaSlide(),
  ];

  const files = [];
  for (let i = 0; i < slides.length; i++) {
    try {
      console.log(`[ig-carousel] Rendering slide ${i}...`);
      const buf = await renderSlide(slides[i], fonts);
      const fileName = `${String(i).padStart(2, "0")}.png`;
      const filePath = path.join(outDir, fileName);
      await writeFile(filePath, buf);
      files.push(filePath);
      console.log(`[ig-carousel] Wrote ${filePath} (${buf.length} bytes)`);
    } catch (err) {
      console.error(`[ig-carousel] Failed to render slide ${i}:`, err.message);
      throw err;
    }
  }

  const captionPath = path.join(outDir, "caption.txt");
  await writeFile(captionPath, buildCaption(picks), "utf8");
  console.log(`[ig-carousel] Wrote ${captionPath}`);
  console.log(`[ig-carousel] ${files.length} slides total (1 cover + ${picks.length} picks + 1 CTA).`);
}

main().catch((err) => {
  console.error("[ig-carousel] FAILED:", err.stack || err);
  process.exit(1);
});
