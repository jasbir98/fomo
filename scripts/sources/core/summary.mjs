/**
 * Run-summary output for scripts/daily-sources.mjs: per-source line + samples,
 * cross-source dedupe totals, category distribution and description backfill.
 * Text is intentionally stable — the dry run is diffed before/after refactors.
 */

import { CATEGORY_STATS } from "./normalize.mjs";

/** Per-source line + 3 sample rows. A shadow source (run + reported, never upserted) is labelled `[shadow]`. */
export function printSummary(provider, stats, rows, { shadow = false } = {}) {
  const s = stats;
  console.log(
    `[${provider}]${shadow ? " [shadow]" : ""} fetched=${s.fetched} parsed=${s.parsed} kept=${rows.length} ` +
      `skipped(past=${s.skipped.past} invalid=${s.skipped.invalid} notEdinburgh=${s.skipped.notEdinburgh} robots=${s.skipped.robots} blocked=${s.skipped.blocked} offWedge=${s.skipped.offWedge})`
  );
  const samples = rows.slice(0, 3);
  for (const row of samples) {
    console.log(
      `    sample: "${row.name}" @ ${row.starts_at} | venue=${row.venue_name ?? "?"} | ` +
        `free=${row.is_free ?? "?"} price=${row.price_from ?? "?"} ${row.currency ?? ""} | id=${row.provider_event_id}`
    );
  }
}

/** Validation outcome for one adapter: how many rows came in, rejections by reason, a few examples. */
export function printValidationSummary({ rowsIn, rejected, samples }) {
  const entries = Object.entries(rejected).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return;
  const total = entries.reduce((n, [, c]) => n + c, 0);
  console.log(`    validation: in=${rowsIn} kept=${rowsIn - total} rejected(${entries.map(([k, v]) => `${k}=${v}`).join(" ")})`);
  for (const [reason, list] of Object.entries(samples)) {
    for (const x of list.slice(0, 2)) {
      console.log(
        `      rejected ${reason}: "${x.name ?? ""}" @ ${x.starts_at ?? "?"} | venue=${x.venue ?? "?"} city=${x.city ?? "?"} addr=${x.address ?? "?"}`
      );
    }
  }
}

/** Image-check totals (image_broken is a soft fix: the row is kept with image_url=null). */
export function printImageSummary(r, { existingKnown }) {
  console.log(
    `\n[daily-sources] images: checked=${r.checked} image_broken=${r.broken} unchanged-in-db=${r.skippedExisting} ` +
      `over-cap-unchecked=${r.overCap}${Object.keys(r.reasons ?? {}).length ? ` broken-reasons(${Object.entries(r.reasons).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}${existingKnown ? "" : " (existing rows unknown: every row treated as new)"}`
  );
}

/** Totals after cross-source dedupe, plus every collapse (kept <- dropped). */
export function printDedupeSummary({ totalKept, merged, collapses }) {
  console.log(
    `\n[daily-sources] TOTAL kept-per-source=${totalKept} after cross-source dedupe=${merged.length} ` +
      `(${totalKept - merged.length} collapsed as likely duplicates across sources)`
  );
  if (collapses.length > 0) {
    console.log(`[daily-sources] cross-source collapses (kept <- dropped):`);
    for (const c of collapses) {
      console.log(
        `    "${c.kept.name}" (${c.kept.provider}) <- "${c.dropped.name}" (${c.dropped.provider}) | key="${c.key}"`
      );
    }
  }
}

/** Category distribution before/after the keyword classifier, across every adapter. */
export function printCategorySummary() {
  const beforeStr = Object.entries(CATEGORY_STATS.before).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  const afterStr = Object.entries(CATEGORY_STATS.after).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`\n[daily-sources] category distribution BEFORE keyword classifier: ${beforeStr || "(none)"}`);
  console.log(`[daily-sources] category distribution AFTER keyword classifier:  ${afterStr || "(none)"}`);
}

/** Description backfill totals + before/after samples. */
export function printBackfillSummary({ blankBefore, blankAfter, backfillStats, backfillSamples, backfillImageSamples = [] }) {
  console.log(
    `\n[daily-sources] descriptions: blank-before-backfill=${blankBefore} candidates=${backfillStats.candidates} ` +
      `fetched=${backfillStats.fetched} fetchFailed=${backfillStats.fetchFailed} robotsBlocked=${backfillStats.robotsBlocked} ` +
      `skippedRecentlyTried=${backfillStats.skippedRecent} imageCandidates=${backfillStats.imageCandidates} ` +
      `imageFromPage=${backfillStats.imageFromPage} imageBroken=${backfillStats.imageBroken} ` +
      `foundOnPage=${backfillStats.foundOnPage} datesFixed=${backfillStats.datesFixed} fallbackUsed=${backfillStats.fallbackUsed} ` +
      `blank-after=${blankAfter}`
  );
  if (backfillImageSamples.length > 0) {
    console.log(`[daily-sources] page-image samples:`);
    for (const s of backfillImageSamples) console.log(`    [${s.provider}] "${s.name}" -> ${s.image}`);
  }
  if (backfillSamples.length > 0) {
    console.log(`[daily-sources] description samples (before -> after):`);
    for (const s of backfillSamples) {
      console.log(
        `    [${s.provider}] "${s.name}"${s.fallback ? " (fallback)" : ""}\n` +
          `      before: ${s.before ? JSON.stringify(s.before) : "(empty)"}\n` +
          `      after:  ${JSON.stringify(s.after)}`
      );
    }
  }
}
