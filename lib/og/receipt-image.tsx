/**
 * The share card for a weekend plan (askfomo.com/plan/<id>): the Instagram
 * "£0 weekend receipt" as a 1200x630 link preview. A paper receipt on the
 * left (day, name, price per line, TOTAL), the plan's headline and a photo
 * collage on the right. Built to be what a WhatsApp group sees.
 *
 * Fonts are bundled in lib/og/fonts (OFL) and read from disk, never fetched
 * at request time. Photos go through lib/og/fetch-image.ts (sharp), and the
 * finished PNG is re-encoded as JPEG: WhatsApp silently drops previews over
 * roughly 300 KB, and a photo-heavy PNG is well over that.
 */
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE, renderBrandOgImage } from "./brand-image";
import { ogPhoto, pngResponseToJpeg } from "./fetch-image";
import { dayCode, planSummary } from "@/lib/plans/format";
import { receiptMoney } from "@/lib/plans/price";
import type { Plan, PlanItem } from "@/lib/plans/types";

const NAVY = "#0b1a33";
const PAPER = "#fbfaf6";
const INK = "#0f1d33";
const MUTED = "#5b6982";
const ORANGE = "#fc8a40";

const COLLAGE_W = 470;
const COLLAGE_H = 330;
const GAP = 12;
/** Space Mono at 22px is ~13.2px a character; the receipt line fits ~37. */
const TITLE_CHARS = 24;

let fontsPromise: Promise<{ name: string; data: Buffer; weight: 400 | 700 | 800; style: "normal" }[]> | null = null;

function loadFonts() {
  fontsPromise ??= Promise.all([
    readFile(path.join(process.cwd(), "lib/og/fonts/SpaceMono-400.ttf")),
    readFile(path.join(process.cwd(), "lib/og/fonts/SpaceMono-700.ttf")),
    readFile(path.join(process.cwd(), "lib/og/fonts/PlusJakartaSans-800.ttf")),
  ]).then(([mono, monoBold, sans]) => [
    { name: "Space Mono", data: mono, weight: 400 as const, style: "normal" as const },
    { name: "Space Mono", data: monoBold, weight: 700 as const, style: "normal" as const },
    { name: "Plus Jakarta Sans", data: sans, weight: 800 as const, style: "normal" as const },
  ]);
  return fontsPromise;
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function linePrice(item: PlanItem): string {
  if (item.price.amount == null) return clip(item.price.label ?? "TBC", 8);
  return `${receiptMoney(item.price.amount)}${item.price.from ? "+" : ""}`;
}

/** Tile boxes for 1–4 photos in the collage: two columns; an odd last photo spans both. */
function tiles(n: number): { w: number; h: number }[] {
  const rows = Math.ceil(n / 2);
  const h = (COLLAGE_H - GAP * (rows - 1)) / rows;
  const half = (COLLAGE_W - GAP) / 2;
  return Array.from({ length: n }, (_, i) => ({ w: n % 2 === 1 && i === n - 1 ? COLLAGE_W : half, h }));
}

function Dashed() {
  return <div style={{ display: "flex", width: "100%", borderTop: "3px dashed #c9ccd3", margin: "14px 0" }} />;
}

export async function renderPlanReceiptImage(plan: Plan | null): Promise<Response> {
  if (!plan || plan.items.length === 0) return jpegResponse(renderBrandOgImage("A weekend in Edinburgh, for less"));

  const items = plan.items.slice(0, 4);
  const summary = planSummary(items);
  const { total } = summary;
  const free = total.amount === 0 && total.unknown === 0;
  const boxes = tiles(items.length);
  const [fonts, photos] = await Promise.all([
    loadFonts(),
    Promise.all(items.map((item, i) => ogPhoto(item.image, boxes[i].w * 1.5, boxes[i].h * 1.5))),
  ]);

  const png = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: NAVY,
          padding: "0 50px 0 60px",
        }}
      >
        {/* Receipt */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 560,
            background: PAPER,
            color: INK,
            fontFamily: "Space Mono",
            padding: "30px 34px 34px",
            borderRadius: 10,
            transform: "rotate(-2deg)",
            boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "center", fontSize: 34, fontWeight: 700, letterSpacing: 8 }}>ASKFOMO</div>
          <div style={{ display: "flex", justifyContent: "center", fontSize: 18, color: MUTED, letterSpacing: 2, marginTop: 4 }}>
            {`EDINBURGH · ${summary.range.toUpperCase()}`}
          </div>
          <Dashed />
          {items.map((item) => (
            <div key={`${item.kind}-${item.id}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 22, padding: "5px 0" }}>
              <div style={{ display: "flex" }}>
                <span style={{ fontWeight: 700, marginRight: 14 }}>{dayCode(item.day)}</span>
                <span>{clip(item.title, TITLE_CHARS)}</span>
              </div>
              <span>{linePrice(item)}</span>
            </div>
          ))}
          <Dashed />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: 2 }}>TOTAL</span>
            <span style={{ fontSize: 44, fontWeight: 700 }}>
              {total.unknown > 0 ? "TBC" : `${total.from ? "from " : ""}${receiptMoney(total.amount)}`}
            </span>
          </div>
          {total.unknown > 0 ? (
            <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 18, color: MUTED }}>
              {`${receiptMoney(total.amount)} known + ${total.unknown} price${total.unknown === 1 ? "" : "s"} to check`}
            </div>
          ) : null}
          <Dashed />
          <div style={{ display: "flex", justifyContent: "center", fontSize: 18, fontWeight: 700, letterSpacing: 4 }}>
            {free ? "THANK YOU FOR NOT SPENDING" : "CHEAP. CHEERFUL. SORTED."}
          </div>
        </div>

        {/* Headline + photos */}
        <div style={{ display: "flex", flexDirection: "column", width: COLLAGE_W }}>
          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <div style={{ display: "flex", fontFamily: "Plus Jakarta Sans", fontSize: 34, fontWeight: 800, color: "#ffffff", letterSpacing: -1.4, lineHeight: 1 }}>
              fom
            </div>
            <div style={{ display: "flex", width: 18, height: 18, borderRadius: 999, background: ORANGE, marginLeft: 2, marginBottom: 3 }} />
          </div>
          <div
            style={{
              display: "flex",
              fontFamily: "Plus Jakarta Sans",
              // Two lines at most: "A weekend in Edinburgh: 4 things, 2 free" is 40 characters.
              fontSize: summary.headline.length > 30 ? 36 : 42,
              fontWeight: 800,
              lineHeight: 1.1,
              letterSpacing: -1,
              color: "#ffffff",
              margin: "18px 0 22px",
            }}
          >
            {summary.headline}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", width: COLLAGE_W, gap: GAP }}>
            {items.map((item, i) => (
              <div
                key={`${item.kind}-${item.id}`}
                style={{
                  display: "flex",
                  position: "relative",
                  width: boxes[i].w,
                  height: boxes[i].h,
                  borderRadius: 16,
                  overflow: "hidden",
                  background: "#1d3256",
                }}
              >
                {photos[i] ? (
                  // Satori renders a plain <img> only, never next/image.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photos[i] as string} width={boxes[i].w} height={boxes[i].h} alt="" style={{ objectFit: "cover" }} />
                ) : null}
                <div
                  style={{
                    display: "flex",
                    position: "absolute",
                    left: 10,
                    bottom: 10,
                    background: ORANGE,
                    color: INK,
                    fontFamily: "Space Mono",
                    fontWeight: 700,
                    fontSize: 18,
                    padding: "2px 10px",
                    borderRadius: 999,
                  }}
                >
                  {`${dayCode(item.day)}${item.time ? ` ${item.time}` : ""}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...OG_IMAGE_SIZE, fonts }
  );

  return jpegResponse(png);
}

async function jpegResponse(png: Response): Promise<Response> {
  const jpeg = await pngResponseToJpeg(png);
  return new Response(new Uint8Array(jpeg), {
    headers: {
      "content-type": "image/jpeg",
      // A plan never changes once made.
      "cache-control": "public, max-age=86400, s-maxage=31536000, immutable",
    },
  });
}
