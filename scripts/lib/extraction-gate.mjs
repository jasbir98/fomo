/**
 * Evidence gate for LLM-extracted happening fields (pure, unit-tested).
 *
 * A field proposal is { value, quote, url }. It is accepted only when:
 *   - value is a non-empty string (null value = "page doesn't say", skipped);
 *   - quote is non-empty and appears verbatim (after normalising) in the row's
 *     saved page text;
 *   - every money figure in value (GBP 12, 12.50, 12p) also appears in quote;
 *   - the (cleaned) value fits the field's length cap.
 * Em dashes are replaced with ", " rather than rejected.
 *
 * Same "visibly stated on the page" rule as docs/weekly-pipeline.md.
 */

export const FIELDS = [
  "price_text",
  "includes",
  "summary",
  "time_note",
  "redemption_note",
  "eligibility_note",
  "venue_name",
  "address",
];

export const MAX_LEN = {
  summary: 160,
  price_text: 60,
  includes: 160,
  time_note: 200,
  redemption_note: 200,
  eligibility_note: 200,
  venue_name: 200,
  address: 200,
};

/** A quote longer than this is not a quote, it is the page. */
export const MAX_QUOTE_LEN = 500;

/** Lowercase, unicode quotes/dashes to ascii, strip zero-width chars, collapse whitespace. */
export function normalise(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[​-‏⁠﻿­]/g, "")
    .replace(/[‘’‚‛′ʼ]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical money figures in a string: "£12" and "£12.00" both give "£12"; "50p" gives "50p". */
export function moneyFigures(text) {
  const out = new Set();
  const s = String(text ?? "").normalize("NFKC");
  for (const m of s.matchAll(/£\s?(\d[\d,]*(?:\.\d+)?)/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(`£${n}`);
  }
  for (const m of s.matchAll(/(?<![\w.£])(\d+(?:\.\d+)?)\s?p\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) out.add(`${n}p`);
  }
  return out;
}

/** Replace em dashes (with or without surrounding spaces) by ", ". */
export function cleanValue(value) {
  return String(value)
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Gate one field. `pageTextNorm` is normalise(page.text), computed once per page.
 * Returns {ok:true, value, quote, url} | {ok:false, reason} | {skipped:true}.
 */
export function gateField(field, proposal, pageTextNorm, pageUrl) {
  if (!FIELDS.includes(field)) return { ok: false, reason: "unknown field" };
  if (!proposal || proposal.value == null) return { skipped: true };
  if (typeof proposal.value !== "string") return { ok: false, reason: "value is not a string" };
  const value = cleanValue(proposal.value);
  if (!value) return { skipped: true };

  const quoteRaw = typeof proposal.quote === "string" ? proposal.quote.trim() : "";
  if (!quoteRaw) return { ok: false, reason: "no quote" };
  if (quoteRaw.length > MAX_QUOTE_LEN) return { ok: false, reason: `quote longer than ${MAX_QUOTE_LEN} chars` };
  const quoteNorm = normalise(quoteRaw);
  if (!quoteNorm) return { ok: false, reason: "no quote" };
  if (!pageTextNorm.includes(quoteNorm)) return { ok: false, reason: "quote not found in page text" };

  const wanted = moneyFigures(value);
  if (wanted.size > 0) {
    const have = moneyFigures(quoteRaw);
    for (const fig of wanted) {
      if (!have.has(fig)) return { ok: false, reason: `figure ${fig} not in quote` };
    }
  }

  const max = MAX_LEN[field];
  if (value.length > max) return { ok: false, reason: `too long (${value.length} > ${max})` };

  const url = typeof proposal.url === "string" && /^https?:\/\//i.test(proposal.url.trim()) ? proposal.url.trim() : pageUrl;
  return { ok: true, value, quote: quoteRaw, url: url ?? null };
}

/**
 * Gate every field of one extraction against its saved page record.
 * page: {status, text, final_url, url} or null.
 * Returns { accepted: {field: {value, quote, url}}, rejected: {field: {reason, value, quote}} }.
 */
export function gateExtraction(extraction, page) {
  const accepted = {};
  const rejected = {};
  const fields = extraction?.fields ?? {};
  const pageOk = page && page.status === "ok" && typeof page.text === "string";
  const pageTextNorm = pageOk ? normalise(page.text) : "";
  const pageUrl = page ? (page.final_url ?? page.url ?? null) : null;
  for (const [field, proposal] of Object.entries(fields)) {
    if (!proposal || proposal.value == null) continue;
    if (!pageOk) {
      rejected[field] = { reason: page ? `page ${page.status ?? "not ok"}` : "no saved page", value: proposal.value, quote: proposal.quote ?? null };
      continue;
    }
    const r = gateField(field, proposal, pageTextNorm, pageUrl);
    if (r.skipped) continue;
    if (r.ok) accepted[field] = { value: r.value, quote: r.quote, url: r.url };
    else rejected[field] = { reason: r.reason, value: proposal.value, quote: proposal.quote ?? null };
  }
  return { accepted, rejected };
}
