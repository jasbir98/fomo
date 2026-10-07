import type { Metadata } from "next";
import { SITE_NAME } from "./site";

/** Meta descriptions over ~160 characters get cut off in results. */
const DESCRIPTION_MAX = 160;

/** Joins non-empty parts with " · " and trims to a result-snippet-sized string, cutting at a word boundary. */
export function describe(parts: (string | null | undefined | false)[], max: number = DESCRIPTION_MAX): string | undefined {
  const text = parts
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .join(" · ");
  if (!text) return undefined;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s·,;:.-]+$/, "")}…`;
}

export interface PageMetadataInput {
  /** Omit on the home page so the root default title is used. Shown as "<title> · Ask Fomo". */
  title?: string;
  description: string;
  /** Site-relative path, used for the canonical and og:url ("/weekend"). */
  path: string;
  /**
   * Share-card images. Default: the branded default card. Pass `false` to name none, for a
   * route that has its own opengraph-image file (app/(shell)/weekend/).
   */
  images?: string[] | false;
  /** og:type. Detail pages use "article". */
  type?: "website" | "article";
  /** Keep the page out of the index (an ended deal or event). */
  noindex?: boolean;
}

/**
 * Title, description, canonical, Open Graph and Twitter for one page.
 *
 * Setting `openGraph` or `twitter` on a page REPLACES the root layout's
 * object rather than merging with it, so everything that must survive
 * (site name, locale, type, the default card image) is restated here.
 */
export function pageMetadata({
  title,
  description,
  path,
  images = ["/opengraph-image"],
  type = "website",
  noindex = false,
}: PageMetadataInput): Metadata {
  const socialTitle = title ? `${title} · ${SITE_NAME}` : undefined;
  return {
    ...(title ? { title } : {}),
    description,
    alternates: { canonical: path },
    ...(noindex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type,
      siteName: SITE_NAME,
      locale: "en_GB",
      url: path,
      ...(socialTitle ? { title: socialTitle } : {}),
      description,
      ...(images ? { images } : {}),
    },
    twitter: {
      card: "summary_large_image",
      ...(socialTitle ? { title: socialTitle } : {}),
      description,
      ...(images ? { images: images.map((i) => (i === "/opengraph-image" ? "/twitter-image" : i)) } : {}),
    },
  };
}
