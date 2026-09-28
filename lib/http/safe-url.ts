/**
 * Validate an untrusted URL before using it as a navigation target
 * (`window.open`, `location.href =`, an `<a href>` built from pipeline
 * data) or embedding it anywhere else that could execute it.
 *
 * Event/happening/place/deal records come from scrapers and third-party
 * APIs (`booking_url`, `source_url`, `ticket_url`, `url`, `website`,
 * image URLs, ...) and are never sanitized at the source. A `javascript:`
 * or `data:` URL stored in one of those fields would execute when handed
 * to `window.open(...)` or `location.href = ...` — React 19 blocks
 * `javascript:` in JSX `href` attributes, but nothing blocks it once the
 * string reaches an imperative navigation call, so every such call site
 * must validate first.
 *
 * Only `http:`/`https:` URLs are accepted. Everything else — relative
 * paths, `javascript:`, `data:`, `vbscript:`, malformed strings, non-string
 * input — returns `null` so the caller can hide the CTA / render no link
 * instead of crashing or navigating somewhere unsafe.
 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return trimmed;
}
