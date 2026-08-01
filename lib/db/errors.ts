/**
 * A PostgrestError (or a plain network Error) doesn't always survive
 * console.error's default object formatting — some loggers (including the
 * Next.js dev overlay) render it as `{}`, since Error.prototype.message
 * isn't an own-enumerable property and a PostgrestError's fields can come
 * back undefined. Same trap already documented at app/api/places/route.ts's
 * cache-upsert error log. Interpolating the known fields into one string
 * survives every logger.
 */
export function describeSupabaseError(err: unknown): string {
  const e = err as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!e || typeof e !== "object") return String(err);
  return (
    `code=${e.code ?? "<none>"} message=${e.message ?? "<none>"} ` +
    `details=${e.details ?? "<none>"} hint=${e.hint ?? "<none>"}`
  );
}
