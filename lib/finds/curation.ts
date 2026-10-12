/**
 * Finds curation helpers for scripts/finds.ts — list ordering, "which rows did
 * the user mean" resolution, and the numbered table.
 *
 * Pure (no DB, no env) so the numbering contract is testable. The contract
 * that matters: `approve 1,3` means rows 1 and 3 of `list --suggested`, and
 * that numbering is derived ONLY from the rows currently in the DB, sorted by
 * `suggestedOrder`. Nothing about the numbers is stored; every command
 * re-reads the table and re-derives them, so a number printed by `suggest` is
 * the same number `approve` resolves, unless someone changed the set of
 * suggested rows in between (the command then acts on what the numbers mean
 * now — `list` first if unsure).
 */
import type { FindRow } from "@/lib/finds/types";
import type { FindCandidate } from "@/lib/finds/candidates";

/** Suggested rows by score desc (nulls last), then id — the numbering `list --suggested` prints. */
export function suggestedOrder(rows: readonly FindRow[]): FindRow[] {
  return rows
    .filter((r) => r.status === "suggested")
    .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.id.localeCompare(b.id));
}

/** Live rows by Fomo level desc, then approval time, then id — the numbering `list --live` prints. */
export function liveOrder(rows: readonly FindRow[]): FindRow[] {
  return rows
    .filter((r) => r.status === "live")
    .sort(
      (a, b) =>
        b.fomo_level - a.fomo_level ||
        (a.approved_at ?? "").localeCompare(b.approved_at ?? "") ||
        a.id.localeCompare(b.id)
    );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TargetResult = { ok: true; rows: FindRow[] } | { ok: false; error: string };

/**
 * Resolve a comma-separated list of 1-based list numbers and/or row uuids
 * against `numbered` (the list the numbers index) and `all` (every row, for
 * uuids — a uuid works regardless of status or which list is numbered).
 * Duplicates collapse; an unknown number or uuid is an error naming it, so a
 * typo never silently acts on a different row.
 */
export function resolveTargets(arg: string, numbered: readonly FindRow[], all: readonly FindRow[]): TargetResult {
  const tokens = arg.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return { ok: false, error: "no rows given (use list numbers like 1,3 or row ids)" };
  const rows: FindRow[] = [];
  for (const token of tokens) {
    let row: FindRow | undefined;
    if (UUID_RE.test(token)) {
      row = all.find((r) => r.id.toLowerCase() === token.toLowerCase());
      if (!row) return { ok: false, error: `no find with id ${token}` };
    } else if (/^\d+$/.test(token)) {
      row = numbered[Number(token) - 1];
      if (!row) return { ok: false, error: `no row numbered ${token} (list has ${numbered.length})` };
    } else {
      return { ok: false, error: `"${token}" is neither a list number nor a row id` };
    }
    if (!rows.includes(row)) rows.push(row);
  }
  return { ok: true, rows };
}

/** One table line's worth of fields; built from a DB row + its subject, or from a not-yet-saved candidate (dry run). */
export interface TableLine {
  type: string;
  title: string;
  when: string;
  price: string;
  score: number | null;
  level: number;
  why: string;
}

export function lineFromCandidate(c: FindCandidate, level: number, why: string): TableLine {
  return { type: c.subject_type, title: c.title, when: c.when, price: c.price, score: c.score, level, why };
}

function cell(text: string, width: number): string {
  const t = text.replace(/\s+/g, " ");
  return (t.length > width ? `${t.slice(0, width - 1)}…` : t).padEnd(width);
}

/** Numbered, fixed-width table: n, type, title, when, price, score, level, why. `why` is last and unpadded so it can run long. */
export function formatTable(lines: readonly TableLine[]): string {
  const head = `${"n".padStart(2)}  ${cell("type", 9)} ${cell("title", 38)} ${cell("when", 18)} ${cell("price", 14)} ${"score".padStart(5)}  lvl  why`;
  const body = lines.map(
    (l, i) =>
      `${String(i + 1).padStart(2)}  ${cell(l.type, 9)} ${cell(l.title, 38)} ${cell(l.when, 18)} ${cell(l.price || "-", 14)} ${
        l.score == null ? "    -" : l.score.toFixed(1).padStart(5)
      }  ${String(l.level).padStart(3)}  ${l.why}`
  );
  return [head, ...body].join("\n");
}
