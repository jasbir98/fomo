#!/usr/bin/env node

/**
 * Finds user-visible text containing em dashes (—, U+2014) in happenings and events tables
 * and proposes rewrites using standard typography rules.
 *
 * Usage:
 *   node scripts/dedash-content.mjs         # dry run: write proposals to scratchpad/dedash-proposals.json
 *   node scripts/dedash-content.mjs --apply # apply changes to live database (requires human review first)
 */

import fs from 'fs';
import path from 'path';

// Load .env.local manually
function loadEnv() {
  const envPath = '.env.local';
  const content = fs.readFileSync(envPath, 'utf-8');
  const env = {};
  content.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [key, ...valueParts] = trimmed.split('=');
    if (key) {
      env[key] = valueParts.join('=').replace(/^['"]|['"]$/g, '');
    }
  });
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const REST_URL = `${SUPABASE_URL}/rest/v1`;
const headers = {
  apikey: SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

// Dedash rewrite function
function dedash(text) {
  if (!text || typeof text !== 'string') return text;

  let result = text;

  // Rule 1: Numeric/date ranges: (\d)\s*—\s*(\d) → $1–$2 (en dash, no spaces)
  result = result.replace(/(\d)\s*—\s*(\d)/g, '$1–$2');

  // Rule 2: Spaced em dash before continuation
  // Check if next char is lowercase, uppercase, or digit
  result = result.replace(/ — ([a-z])/g, ', $1');
  result = result.replace(/ — ([A-Z0-9])/g, '. $1');
  // If preceded by punctuation, just drop the dash
  result = result.replace(/([.!?:]) — /g, '$1 ');

  // Rule 3: Unspaced em dash between words
  result = result.replace(/(\w)—(\w)/g, '$1, $2');

  // Rule 4: Trailing or leading em dash
  result = result.replace(/ —\s*$/g, '');
  result = result.replace(/^\s*— /g, '');

  // Rule 5: Collapse artifacts
  result = result.replace(/  +/g, ' ');
  result = result.replace(/, ,/g, ',');
  result = result.replace(/\. \./g, '.');
  result = result.trim();

  return result;
}

// For titles: use colon instead of comma/period
function dedashTitle(text) {
  if (!text || typeof text !== 'string') return text;

  let result = text;

  // Rule 1: Numeric/date ranges
  result = result.replace(/(\d)\s*—\s*(\d)/g, '$1–$2');

  // Rule 2 (title version): spaced em dash becomes colon
  result = result.replace(/ — ([a-z])/g, ': $1');
  result = result.replace(/ — ([A-Z0-9])/g, ': $1');
  result = result.replace(/([.!?:]) — /g, '$1 ');

  // Rule 3: Unspaced em dash
  result = result.replace(/(\w)—(\w)/g, '$1, $2');

  // Rule 4: Trailing/leading
  result = result.replace(/ —\s*$/g, '');
  result = result.replace(/^\s*— /g, '');

  // Rule 5: Collapse
  result = result.replace(/  +/g, ' ');
  result = result.replace(/, ,/g, ',');
  result = result.replace(/\. \./g, '.');
  result = result.trim();

  return result;
}

async function fetchJSON(url, method = 'GET', body = null) {
  const options = {
    method,
    headers,
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

async function discoverColumns(table) {
  const url = `${REST_URL}/${table}?select=*&limit=1`;
  try {
    const rows = await fetchJSON(url);
    if (rows.length === 0) return [];
    const row = rows[0];
    const textColumns = [
      'title', 'description', 'summary', 'subtitle', 'sellout_note',
      'eligibility_note', 'promo_note', 'venue_name', 'tagline'
    ];
    return textColumns.filter(col => col in row && typeof row[col] === 'string');
  } catch (err) {
    console.error(`Error discovering columns for ${table}:`, err.message);
    return [];
  }
}

async function fetchAllRows(table, textColumns, isTitle = false) {
  const proposals = [];
  let offset = 0;
  const limit = 1000;

  let filter = '';
  if (table === 'happenings') {
    filter = '&status=eq.live';
  } else if (table === 'events') {
    // Fetch all rows (or future rows if there's a start_time/starts_at column)
    // For now, just fetch all
  }

  while (true) {
    const select = textColumns.join(',') + ',id';
    const url = `${REST_URL}/${table}?select=${select}&limit=${limit}&offset=${offset}${filter}`;

    try {
      const rows = await fetchJSON(url);
      if (rows.length === 0) break;

      rows.forEach(row => {
        textColumns.forEach(col => {
          const before = row[col];
          if (!before || typeof before !== 'string' || !before.includes('—')) return;

          const dedashFn = col === 'title' ? dedashTitle : dedash;
          const after = dedashFn(before);

          if (before !== after) {
            proposals.push({
              table,
              id: row.id,
              column: col,
              before,
              after,
            });
          }
        });
      });

      offset += limit;
    } catch (err) {
      console.error(`Error fetching ${table} at offset ${offset}:`, err.message);
      break;
    }
  }

  return proposals;
}

async function applyProposals(proposals) {
  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const proposal of proposals) {
    const { table, id, column, before, after } = proposal;
    const url = `${REST_URL}/${table}?id=eq.${id}`;

    try {
      // Re-check that current value still matches
      const currentRows = await fetchJSON(`${REST_URL}/${table}?id=eq.${id}&select=${column}`);
      if (currentRows.length === 0 || currentRows[0][column] !== before) {
        console.log(`⊘ Skipped ${table} id=${id} ${column}: value changed`);
        skipCount++;
        continue;
      }

      // Apply patch
      const patchHeaders = { ...headers, 'Prefer': 'return=minimal' };
      const response = await fetch(url, {
        method: 'PATCH',
        headers: patchHeaders,
        body: JSON.stringify({ [column]: after }),
      });

      if (response.ok) {
        successCount++;
      } else {
        const text = await response.text();
        console.error(`✗ Failed to update ${table} id=${id}: ${text}`);
        errorCount++;
      }
    } catch (err) {
      console.error(`Error applying proposal for ${table} id=${id}:`, err.message);
      errorCount++;
    }
  }

  console.log(`\n=== Apply Results ===`);
  console.log(`✓ Updated: ${successCount}`);
  console.log(`⊘ Skipped: ${skipCount}`);
  console.log(`✗ Errors: ${errorCount}`);
}

async function main() {
  const isApply = process.argv.includes('--apply');

  if (isApply) {
    // Load proposals from file
    const proposalsPath = 'scratchpad/dedash-proposals.json';
    if (!fs.existsSync(proposalsPath)) {
      console.error(`No proposals file found at ${proposalsPath}`);
      console.error('Run dry-run first: node scripts/dedash-content.mjs');
      process.exit(1);
    }

    const proposals = JSON.parse(fs.readFileSync(proposalsPath, 'utf-8'));
    console.log(`Applying ${proposals.length} proposals...\n`);
    await applyProposals(proposals);
  } else {
    // Dry run: discover columns and collect proposals
    console.log('Discovering columns...');
    const happeningsColumns = await discoverColumns('happenings');
    const eventsColumns = await discoverColumns('events');

    console.log(`Happenings columns: ${happeningsColumns.join(', ')}`);
    console.log(`Events columns: ${eventsColumns.join(', ')}\n`);

    console.log('Fetching happenings...');
    const happeningsProposals = await fetchAllRows('happenings', happeningsColumns, happeningsColumns.includes('title'));

    console.log('Fetching events...');
    const eventsProposals = await fetchAllRows('events', eventsColumns, eventsColumns.includes('title'));

    const allProposals = [...happeningsProposals, ...eventsProposals];

    // Write to scratchpad
    const scratchpadDir = 'scratchpad';
    if (!fs.existsSync(scratchpadDir)) {
      fs.mkdirSync(scratchpadDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(scratchpadDir, 'dedash-proposals.json'),
      JSON.stringify(allProposals, null, 2)
    );

    // Print summary
    console.log('\n=== Dry Run Summary ===');
    console.log(`Total proposals: ${allProposals.length}`);

    const byTable = {};
    const byColumn = {};

    allProposals.forEach(p => {
      byTable[p.table] = (byTable[p.table] || 0) + 1;
      const key = `${p.table}.${p.column}`;
      byColumn[key] = (byColumn[key] || 0) + 1;
    });

    console.log('\nBy table:');
    Object.entries(byTable).forEach(([table, count]) => {
      console.log(`  ${table}: ${count}`);
    });

    console.log('\nBy column:');
    Object.entries(byColumn).forEach(([col, count]) => {
      console.log(`  ${col}: ${count}`);
    });

    // Show first 10 examples
    console.log('\n=== First 10 Examples ===');
    allProposals.slice(0, 10).forEach((p, i) => {
      console.log(`\n${i + 1}. ${p.table} id=${p.id} (${p.column})`);
      console.log(`   Before: ${p.before.substring(0, 80)}`);
      console.log(`   After:  ${p.after.substring(0, 80)}`);
    });

    if (allProposals.length > 10) {
      console.log(`\n... and ${allProposals.length - 10} more proposals.`);
    }

    console.log(`\nProposals saved to ${scratchpadDir}/dedash-proposals.json`);
    console.log('Review the file, then run: node scripts/dedash-content.mjs --apply');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
