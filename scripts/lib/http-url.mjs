/**
 * httpUrlOrNull.mjs — .mjs-safe twin of lib/http/safe-url.ts's
 * safeHttpUrl(). Scripts under scripts/ can't import a .ts module, so this
 * is a small standalone copy: same contract (only http:/https: survives,
 * everything else — javascript:, data:, relative, malformed, non-string —
 * becomes null), kept here so every ingest script that writes a
 * scraper/API-sourced URL column (ticket_url, booking_url, source_url,
 * image_url, ...) can drop a hostile value before it ever reaches the DB.
 */
export function httpUrlOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return trimmed;
}
