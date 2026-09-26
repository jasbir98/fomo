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
import { mkdir, writeFile } from "node:fs/promises";
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

// --- tiny hyperscript so slide markup reads like JSX without a JSX build step ---
function h(type, props, ...children) {
  const flatChildren = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
  return { type, props: { ...props, children: flatChildren.length === 1 ? flatChildren[0] : flatChildren } };
}

function truncate(text, max) {
  if (!text || text.length <= max) return text ?? "";
  return `${text.slice(0, max - 1).trimEnd()}…`;
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
        fontFamily: "sans-serif",
        padding: 72,
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

function pickSlide(item, index, total) {
  return baseSlide([
    wordmark(),
    h(
      "div",
      { style: { display: "flex", position: "absolute", top: 56, right: 72, fontSize: 24, color: "#8b93a3" } },
      `${index + 1} / ${total}`
    ),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", flex: 1, justifyContent: "center" } },
      item.price
        ? h(
        "div",
        {
          style: {
            display: "flex",
            alignSelf: "flex-start",
            background: item.price === "FREE" ? "#1e7d4c" : ACCENT,
            color: WHITE,
            fontSize: 40,
            fontWeight: 800,
            padding: "14px 32px",
            borderRadius: 999,
            marginBottom: 40,
          },
        },
        item.price
      )
        : null,
      h(
        "div",
        { style: { fontSize: 64, fontWeight: 800, lineHeight: 1.12, display: "flex", flexWrap: "wrap" } },
        truncate(item.title, 70)
      ),
      item.when
        ? h("div", { style: { display: "flex", fontSize: 34, color: "#c7d2e3", marginTop: 28 } }, item.when)
        : null,
      item.venue
        ? h("div", { style: { display: "flex", fontSize: 30, color: "#8b93a3", marginTop: 10 } }, truncate(item.venue, 46))
        : null
    ),
  ]);
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

async function renderSlide(element) {
  const res = new ImageResponse(element, { width: WIDTH, height: HEIGHT });
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const { picks } = await getWeeklyPicks({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY });

  if (picks.length === 0) {
    console.error("[ig-carousel] No picks found for the window — nothing to render.");
    process.exit(1);
  }

  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  const outDir = path.join(process.cwd(), "scripts", "out", `ig-${todayIso}`);
  await mkdir(outDir, { recursive: true });

  const slides = [coverSlide(), ...picks.map((p, i) => pickSlide(p, i, picks.length)), ctaSlide()];

  const files = [];
  for (let i = 0; i < slides.length; i++) {
    const buf = await renderSlide(slides[i]);
    const fileName = `${String(i).padStart(2, "0")}.png`;
    const filePath = path.join(outDir, fileName);
    await writeFile(filePath, buf);
    files.push(filePath);
    console.log(`[ig-carousel] Wrote ${filePath} (${buf.length} bytes)`);
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
