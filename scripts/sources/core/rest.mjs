/**
 * Tiny PostgREST helper for the lifecycle modules (retire, runs, health,
 * image-existing lookup). Service-role key, no supabase-js (see the note in
 * scripts/daily-sources.mjs). Never throws on HTTP errors: returns
 * { ok, status, data, error, contentRange }.
 */

import { SUPABASE_URL, SERVICE_ROLE_KEY } from "./config.mjs";

export function hasSupabase() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

export async function rest(pathAndQuery, { method = "GET", body, prefer, range } = {}) {
  const headers = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  if (range) {
    headers.Range = range;
    headers["Range-Unit"] = "items";
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data: null, error: data, contentRange: null };
    }
    return { ok: true, status: res.status, data, error: null, contentRange: res.headers.get("content-range") };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: { message: err.message }, contentRange: null };
  }
}

/** True when a PostgREST error means "that column/table isn't in the DB yet" (SQL migration not applied). */
export function isMissingSchemaError(error) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const msg = String(error.message ?? error ?? "");
  return (
    code === "42703" || // undefined_column
    code === "42P01" || // undefined_table
    code === "PGRST204" || // column not found in schema cache (insert/update body)
    code === "PGRST205" || // table not found in schema cache
    /does not exist|could not find the .* (column|table)/i.test(msg)
  );
}

/** Parse "0-9/123" -> 123 (or null when unknown / "*"). */
export function totalFromContentRange(contentRange) {
  const m = String(contentRange ?? "").match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** GET every row of a query, paging with Range. `path` must already hold select/filters (no limit). */
export async function restGetAll(path, { pageSize = 1000, maxRows = 50_000 } = {}) {
  const rows = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const res = await rest(path, { range: `${from}-${from + pageSize - 1}` });
    if (!res.ok) return { ok: false, error: res.error, status: res.status, rows };
    const page = Array.isArray(res.data) ? res.data : [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { ok: true, rows };
}
