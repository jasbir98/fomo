/**
 * Page-change ledger (table `source_pages`, created by
 * supabase/add_deal_source_columns.sql): remembers a sha256 of each page's
 * normalised text so a source can skip re-processing a page that has not
 * changed. Talks to PostgREST directly with the service-role key (same
 * reasoning as core/upsert.mjs).
 *
 * Reads work in dry-run too (they only need the service key); writes happen
 * only when `write` is true (ctx.write from scripts/daily-sources.mjs).
 *
 * If the table is missing (migration not applied yet) this warns ONCE and
 * degrades: every page reads as "changed" and recordPages is a no-op.
 *
 * EVENTS CAVEAT. Skipping an unchanged page means emitting no rows for it,
 * which would later look like the events vanished. So adapters must re-emit the
 * page's previous rows instead: `fetchProviderRows()` reads the provider's
 * existing `events` rows (standard columns only) and `reemitRow()` refreshes
 * their fetched_at so they pass through the pipeline exactly like fresh rows.
 */

import { createHash } from "node:crypto";
import { SUPABASE_URL, SERVICE_ROLE_KEY } from "./config.mjs";

/** Columns of the standard adapter row (see mapJsonLdEvent) — what re-emitted rows are restricted to. */
export const ROW_COLUMNS = [
  "provider", "provider_event_id", "name", "description", "category", "image_url", "ticket_url",
  "starts_at", "ends_at", "venue_name", "address", "lat", "lng", "city", "country",
  "is_free", "price_from", "currency", "destination", "source", "fetched_at",
];

const ledger = new Map(); // url -> { source_id, content_hash, last_fetched_at, last_changed_at, last_status }
const loadedSources = new Set();
let tableMissing = false;
let warned = false;

function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn(`  [page-ledger] ${msg}`);
}

function configured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

function headers(extra = {}) {
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, ...extra };
}

/** True when the ledger is unusable (no DB creds, or table missing). Adapters can use this to know every page counts as changed. */
export function ledgerUnavailable() {
  return tableMissing || !configured();
}

/** sha256 hex of already-normalised text (callers normalise: strip volatile markup, collapse whitespace). */
export function hashText(normalisedText) {
  return createHash("sha256").update(String(normalisedText ?? ""), "utf8").digest("hex");
}

/** Load every ledger row for `sourceId` into memory. Returns the Map for that source (url -> row). Never throws. */
export async function loadLedger(sourceId) {
  const out = new Map();
  if (!configured()) {
    warnOnce("Supabase env not set — treating every page as changed.");
    return out;
  }
  if (tableMissing) return out;
  try {
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/source_pages?source_id=eq.${encodeURIComponent(sourceId)}&select=url,source_id,content_hash,last_fetched_at,last_changed_at,last_status&order=url&limit=${pageSize}&offset=${offset}`,
        { headers: headers() }
      );
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 404 || /PGRST205|42P01|does not exist|schema cache/i.test(body)) {
          tableMissing = true;
          warnOnce("table source_pages not found (run supabase/add_deal_source_columns.sql) — treating every page as changed.");
        } else {
          warnOnce(`ledger read failed (HTTP ${res.status}) — treating every page as changed.`);
        }
        return out;
      }
      const rows = await res.json();
      for (const r of rows) {
        ledger.set(r.url, r);
        out.set(r.url, r);
      }
      if (rows.length < pageSize) break;
    }
    loadedSources.add(sourceId);
  } catch (err) {
    warnOnce(`ledger read error (${err.message}) — treating every page as changed.`);
  }
  return out;
}

/** True only when the ledger holds this url with exactly this hash. Missing table / unknown url / different hash => false. */
export function isUnchanged(url, hash) {
  if (tableMissing) return false;
  const prev = ledger.get(url);
  return Boolean(prev && prev.content_hash === hash);
}

/**
 * Upsert ledger entries: [{ url, source_id, content_hash, status }]. No-op unless `write` is true.
 * last_changed_at is set to now only when the hash is new/different; for unchanged pages the
 * field is omitted so the stored value survives the merge-upsert.
 */
export async function recordPages(entries, { write = false, now = new Date() } = {}) {
  if (!write || entries.length === 0) return { ok: 0, failed: 0 };
  if (!configured() || tableMissing) {
    warnOnce("not recording pages (no DB creds or table missing).");
    return { ok: 0, failed: 0 };
  }
  const nowIso = now.toISOString();
  const bodies = entries.map((e) => {
    const row = {
      url: e.url,
      source_id: e.source_id,
      content_hash: e.content_hash,
      last_fetched_at: nowIso,
      last_status: e.status ?? null,
    };
    if (!isUnchanged(e.url, e.content_hash)) row.last_changed_at = nowIso;
    return row;
  });
  // PostgREST bulk upsert requires uniform keys: split into the two shapes.
  const groups = [bodies.filter((r) => "last_changed_at" in r), bodies.filter((r) => !("last_changed_at" in r))];
  let ok = 0;
  let failed = 0;
  for (const batch of groups) {
    if (batch.length === 0) continue;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/source_pages?on_conflict=url`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      ok += batch.length;
      for (const r of batch) ledger.set(r.url, { ...(ledger.get(r.url) ?? {}), ...r });
    } catch (err) {
      failed += batch.length;
      console.error(`  [page-ledger] record failed (${batch.length} page(s)): ${err.message}`);
    }
  }
  return { ok, failed };
}

/**
 * GET the provider's existing `events` rows (standard columns only) with starts_at/ends_at not yet over.
 * Returns an array (possibly empty; empty also on any failure — callers then simply fetch the pages).
 */
export async function fetchProviderRows(provider, now = new Date()) {
  if (!configured()) return [];
  const rows = [];
  try {
    const pageSize = 1000;
    // Keep rows that have not finished yet. ends_at may be null, so filter on starts_at >= (now - 1 day) OR ends_at >= now.
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    const or = `or=(starts_at.gte.${since},ends_at.gte.${now.toISOString()})`;
    for (let offset = 0; ; offset += pageSize) {
      const url = `${SUPABASE_URL}/rest/v1/events?provider=eq.${encodeURIComponent(provider)}&${or}&select=${ROW_COLUMNS.join(",")}&order=provider_event_id&limit=${pageSize}&offset=${offset}`;
      const res = await fetch(url, { headers: headers() });
      if (!res.ok) {
        warnOnce(`could not read existing ${provider} rows (HTTP ${res.status}) — fetching every page.`);
        return [];
      }
      const page = await res.json();
      rows.push(...page);
      if (page.length < pageSize) break;
    }
  } catch (err) {
    warnOnce(`could not read existing ${provider} rows (${err.message}) — fetching every page.`);
    return [];
  }
  return rows;
}

/** A previously stored row re-emitted unchanged except fetched_at (so it refreshes like a freshly seen row). */
export function reemitRow(storedRow, now = new Date()) {
  const row = {};
  for (const k of ROW_COLUMNS) row[k] = storedRow[k] ?? null;
  row.fetched_at = now.toISOString();
  return row;
}
