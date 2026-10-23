/**
 * trace-server-maps.mjs — runs after `next build` (package.json "build").
 *
 * next.config.ts's `experimental.serverSourceMaps` writes a .js.map beside
 * every server chunk, but Next's file traces (.nft.json, which Vercel uses
 * to decide what goes into each function) leave them out, so on Vercel
 * lib/analytics/server-source-map.ts would find no maps and PostHog would get
 * minified chunk frames. This adds, to each trace, the maps of the chunks
 * that trace already lists — each function gets only its own maps, not all
 * ~30 MB of them.
 *
 * Plain Node ESM, no deps. Safe to re-run; a missing .next is a no-op.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const SERVER_DIR = path.join(process.cwd(), ".next", "server");

function* traces(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* traces(full);
    else if (name.endsWith(".nft.json")) yield full;
  }
}

if (existsSync(SERVER_DIR)) {
  let traceCount = 0;
  let added = 0;
  for (const file of traces(SERVER_DIR)) {
    const trace = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(trace.files)) continue;
    const dir = path.dirname(file);
    const listed = new Set(trace.files);
    // The trace's own entry file (page.js beside page.js.nft.json) isn't listed in it.
    const entry = path.basename(file, ".nft.json");
    const candidates = [entry, ...trace.files].filter((f) => f.endsWith(".js") && !f.includes("node_modules"));
    let changed = false;
    for (const js of candidates) {
      const map = `${js}.map`;
      if (listed.has(map) || !existsSync(path.join(dir, map))) continue;
      trace.files.push(map);
      listed.add(map);
      added++;
      changed = true;
    }
    if (changed) {
      writeFileSync(file, JSON.stringify(trace));
      traceCount++;
    }
  }
  console.log(`trace-server-maps: added ${added} source maps to ${traceCount} function traces`);
}
