/**
 * Pure helpers for POST /api/tips (app/api/tips/route.ts).
 *
 * The tip form's Link field is free text: people paste "www.thestand.co.uk",
 * "instagram.com/venue" or "@venue on Instagram". A tip is never rejected for
 * its link. `normaliseTipLink` turns what it can into a real http(s) URL and
 * hands back the rest as `leftover`, which `buildTipDetails` folds into
 * `details` (the `tips` table has no column for it, nor for the location).
 */

export const DEFAULT_MAX_DETAILS_LENGTH = 2000;

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
// Looks like a bare domain/path: a dot in the host part, no spaces, no "@"
// before the first "/" (so "@venue.co" and emails aren't treated as domains).
const BARE_DOMAIN_RE = /^[^\s@/]+\.[^\s@/]+(?:[/?#]\S*)?$/;

/**
 * Normalise the raw Link field. `url` is a valid http(s) URL or null;
 * `leftover` is the trimmed raw text when it couldn't be made into a URL.
 */
export function normaliseTipLink(raw: string | null | undefined): { url: string | null; leftover: string | null } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { url: null, leftover: null };

  const candidate = !HAS_SCHEME_RE.test(text) && BARE_DOMAIN_RE.test(text) ? `https://${text}` : text;
  if (isValidUrl(candidate)) return { url: candidate, leftover: null };
  return { url: null, leftover: text };
}

/**
 * Combine the location, any unusable link text and the user's own details into
 * the single `details` string, capped at `maxLength`. Layout:
 *
 *   Where: <location>
 *   Link: <leftover>
 *
 *   <details>
 */
export function buildTipDetails({
  location,
  leftoverLink,
  details,
  maxLength = DEFAULT_MAX_DETAILS_LENGTH,
}: {
  location?: string | null;
  leftoverLink?: string | null;
  details?: string | null;
  maxLength?: number;
}): string | null {
  const lines: string[] = [];
  const where = location?.trim();
  const link = leftoverLink?.trim();
  if (where) lines.push(`Where: ${where}`);
  if (link) lines.push(`Link: ${link}`);

  const user = details?.trim();
  const head = lines.join("\n");
  const combined = head && user ? `${head}\n\n${user}` : head || user || "";

  const capped = combined.slice(0, maxLength).trim();
  return capped || null;
}
