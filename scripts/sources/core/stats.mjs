/** Per-adapter run stats: counts plus a breakdown of why rows were skipped. */

export function emptyStats() {
  return { fetched: 0, parsed: 0, kept: 0, skipped: { past: 0, invalid: 0, notEdinburgh: 0, robots: 0, blocked: 0, offWedge: 0 } };
}

export function mergeStats(a, b) {
  return {
    fetched: a.fetched + b.fetched,
    parsed: a.parsed + b.parsed,
    kept: a.kept + b.kept,
    skipped: {
      past: a.skipped.past + b.skipped.past,
      invalid: a.skipped.invalid + b.skipped.invalid,
      notEdinburgh: a.skipped.notEdinburgh + b.skipped.notEdinburgh,
      robots: a.skipped.robots + b.skipped.robots,
      blocked: a.skipped.blocked + b.skipped.blocked,
      offWedge: a.skipped.offWedge + b.skipped.offWedge,
    },
  };
}
