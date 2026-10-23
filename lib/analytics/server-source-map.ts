/**
 * Maps server stack frames from the built chunks (.next/server/chunks/…js)
 * back to our source files, using the .js.map files that
 * next.config.ts's `experimental.serverSourceMaps` writes beside them.
 * Node's own `--enable-source-maps` doesn't reach `error.stack` here: Next
 * installs its own stack formatting, and only applies the maps in its log
 * output. Node runtime only (lib/analytics/server-exception.ts imports this
 * behind a NEXT_RUNTIME check).
 */
import { readFileSync } from "node:fs";
import { SourceMap } from "node:module";
import path from "node:path";
import type { ExceptionEntry } from "./exceptions";

/** One parsed map per chunk for the life of the function instance; null when a chunk has none. */
const maps = new Map<string, SourceMap | null>();

function mapFor(file: string): SourceMap | null {
  if (!maps.has(file)) {
    let map: SourceMap | null = null;
    try {
      map = new SourceMap(JSON.parse(readFileSync(`${file}.map`, "utf8")));
    } catch {
      // No map beside this chunk (Next's own runtime, node_modules externals).
    }
    maps.set(file, map);
  }
  return maps.get(file) ?? null;
}

/** Rewrites, in place, every frame that has a map: file relative to the project root, original line/column/name. */
export function resolveServerFrames(list: ExceptionEntry[]): void {
  const root = process.cwd();
  for (const entry of list) {
    for (const frame of entry.stacktrace?.frames ?? []) {
      if (!frame.filename.endsWith(".js") || !frame.lineno || !frame.colno) continue;
      const file = frame.filename.replace(/^file:\/\//, "");
      const map = mapFor(file);
      const hit = map?.findEntry(frame.lineno - 1, frame.colno - 1);
      if (!hit || !("originalSource" in hit) || !hit.originalSource) continue;
      const source = path.relative(root, path.resolve(path.dirname(file), hit.originalSource));
      frame.filename = source;
      frame.lineno = hit.originalLine + 1;
      frame.colno = hit.originalColumn + 1;
      // `name` is on Node's mapping but missing from @types/node 20.
      const name = (hit as { name?: string }).name;
      if (name) frame.function = name;
      frame.in_app = !source.includes("node_modules") && !source.startsWith("..");
    }
  }
}
