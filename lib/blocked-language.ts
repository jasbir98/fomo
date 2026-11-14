/** Languages whose visitors get a 403 from proxy.ts (temporary owner decision). */
export const DEFAULT_BLOCKED_LANGUAGES: readonly string[] = ["zh-CN"];

function normalise(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Blocked tags from `BLOCKED_LANGUAGES` (comma separated). Unset uses the
 * default; set but empty disables blocking. Call per request, not at import.
 */
export function blockedLanguagesFromEnv(
  env: Record<string, string | undefined> = process.env
): string[] {
  const raw = env.BLOCKED_LANGUAGES;
  if (raw === undefined) return [...DEFAULT_BLOCKED_LANGUAGES];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * True when an Accept-Language entry with q > 0 exactly matches a blocked tag
 * (case-insensitive, `_` = `-`). Never throws; malformed input is not blocked.
 */
export function isBlockedLanguage(
  acceptLanguage: string | null | undefined,
  blocked: readonly string[] = DEFAULT_BLOCKED_LANGUAGES
): boolean {
  try {
    if (!acceptLanguage || blocked.length === 0) return false;
    const blockedSet = new Set(blocked.map(normalise).filter(Boolean));
    if (blockedSet.size === 0) return false;
    for (const part of acceptLanguage.split(",")) {
      const [rawTag, ...params] = part.split(";");
      const tag = normalise(rawTag ?? "");
      if (!tag || !blockedSet.has(tag)) continue;
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
        if (m) {
          const n = Number(m[1]);
          q = Number.isFinite(n) ? n : 0;
        }
      }
      if (q > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}
