// Run with `npx tsx --test lib/review/decide.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REJECT_REASON, MAX_REASON_LENGTH, buildPatch, cleanReason, decide, describeDecision, reviewState, type ReviewPatch, type ReviewStore } from "./decide";
import type { StagedDeal } from "./digest";
import type { DispatchResult } from "./dispatch";
import { dispatchPromote } from "./dispatch";

const ID = "3f2a8c1e-5b7d-4e90-a1c2-0d9e8f7a6b5c";
const NOW = new Date("2026-11-02T09:00:00Z");

/** In-memory staging table with the same "write only while open" rules as the real store. */
function fakeStore(initial: Partial<StagedDeal> = {}, siblings: Partial<StagedDeal>[] = [], opts: { closeThrows?: boolean } = {}) {
  const table: StagedDeal[] = [
    { id: ID, slug: "cask-pints", batch_id: "edi-daily-2026-11-02", created_at: "2026-11-02T06:00:00Z", title: "£4 cask pints", approved: false, extraction_status: "validated", happening_id: null, reviewed_at: null, ...initial },
    ...siblings.map((s, i) => ({ id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`, slug: "cask-pints", title: "£4 cask pints", approved: false, extraction_status: "validated", happening_id: null, reviewed_at: null, ...s }) as StagedDeal),
  ];
  const writes: ReviewPatch[] = [];
  const closed: string[] = [];
  const open = (r: StagedDeal) => reviewState(r).kind === "open";
  const store: ReviewStore = {
    async read(id) {
      const r = table.find((x) => x.id === id);
      return r ? { ...r } : null;
    },
    async writeIfOpen(id, patch) {
      const i = table.findIndex((x) => x.id === id);
      if (i < 0 || !open(table[i])) return false;
      writes.push(patch);
      table[i] = { ...table[i], ...patch };
      return true;
    },
    async closeOlderDuplicates(row, patch) {
      if (opts.closeThrows) throw new Error("boom");
      let n = 0;
      table.forEach((r, i) => {
        if (r.id === row.id || r.slug !== row.slug || !row.created_at || !r.created_at || !(r.created_at < row.created_at) || !open(r)) return;
        table[i] = { ...r, ...patch };
        closed.push(r.id);
        n += 1;
      });
      return n;
    },
  };
  return { store, writes, closed, table, get row() { return table[0]; } };
}

const counter = () => {
  let calls = 0;
  const dispatch = async (): Promise<DispatchResult> => {
    calls += 1;
    return "dispatched";
  };
  return { dispatch, get calls() { return calls; } };
};

test("approve writes the weekly report's state change plus the review fields, then dispatches once", async () => {
  const f = fakeStore();
  const d = counter();
  const out = await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: d.dispatch });
  assert.deepEqual(out, { kind: "done", title: "£4 cask pints", action: "approve", dispatch: "dispatched", closedOlder: 0 });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].approved, true);
  assert.equal(f.writes[0].extraction_status, "approved");
  assert.equal(f.writes[0].reviewed_at, NOW.toISOString());
  assert.equal(f.writes[0].reviewed_action, "approve");
  assert.equal(d.calls, 1);
});

test("approving twice changes nothing the second time and does not dispatch again", async () => {
  const f = fakeStore();
  const d = counter();
  await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: d.dispatch });
  const second = await decide({ store: f.store, id: ID, action: "approve", now: new Date(NOW.getTime() + 60_000), dispatch: d.dispatch });
  assert.equal(second.kind, "already");
  assert.equal(f.writes.length, 1);
  assert.equal(d.calls, 1);
  assert.equal(f.row?.reviewed_at, NOW.toISOString());
  assert.match(describeDecision(second).headline, /^Already approved/);
});

test("reject then approve: the second decision is refused and the first stands", async () => {
  const f = fakeStore();
  const d = counter();
  await decide({ store: f.store, id: ID, action: "reject", reason: "chain", now: NOW });
  const out = await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: d.dispatch });
  assert.equal(out.kind, "already");
  assert.equal(f.row?.approved, false);
  assert.equal(f.row?.extraction_status, "rejected");
  assert.equal(d.calls, 0);
  const text = describeDecision(out);
  assert.match(text.headline, /^Already rejected/);
  assert.match(text.detail ?? "", /chain/);
});

test("reject stores the reason (trimmed, capped) or a default, and does not dispatch", async () => {
  const f = fakeStore();
  const d = counter();
  await decide({ store: f.store, id: ID, action: "reject", reason: "  not   a real saving ", now: NOW, dispatch: d.dispatch });
  assert.equal(f.writes[0].rejected_reason, "not a real saving");
  assert.equal(f.writes[0].extraction_status, "rejected");
  assert.equal(f.writes[0].reviewed_action, "reject");
  assert.equal(f.writes[0].approved, undefined);
  assert.equal(d.calls, 0);
  assert.equal(cleanReason(""), DEFAULT_REJECT_REASON);
  assert.equal(cleanReason(null), DEFAULT_REJECT_REASON);
  assert.equal(cleanReason("x".repeat(500)).length, MAX_REASON_LENGTH);
  assert.equal(buildPatch("reject", NOW).rejected_reason, DEFAULT_REJECT_REASON);
});

test("an expired row cannot be approved: it reports expiry and changes nothing", async () => {
  const f = fakeStore({ reviewed_at: "2026-10-30T09:00:00Z", reviewed_action: "expired", extraction_status: "rejected", rejected_reason: "expired: not reviewed within 14 days" });
  const out = await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: counter().dispatch });
  assert.equal(out.kind, "already");
  assert.equal(f.writes.length, 0);
  assert.match(describeDecision(out).headline, /expired/);
});

test("a row that is already live, or approved by hand, is left alone", async () => {
  for (const initial of [{ happening_id: "11111111-1111-4111-8111-111111111111", extraction_status: "promoted" }, { approved: true, extraction_status: "approved" }]) {
    const f = fakeStore(initial);
    const out = await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: counter().dispatch });
    assert.equal(out.kind, "already");
    assert.equal(f.writes.length, 0);
  }
});

test("a missing row is reported as missing", async () => {
  const store: ReviewStore = { read: async () => null, writeIfOpen: async () => false, closeOlderDuplicates: async () => 0 };
  assert.deepEqual(await decide({ store, id: ID, action: "approve" }), { kind: "missing" });
});

test("two taps racing: the loser's conditional write matches nothing and it reports the winner", async () => {
  const f = fakeStore();
  const d = counter();
  const [a, b] = await Promise.all([
    decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: d.dispatch }),
    decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: d.dispatch }),
  ]);
  assert.equal([a, b].filter((x) => x.kind === "done").length, 1);
  assert.equal([a, b].filter((x) => x.kind === "already").length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(d.calls, 1);
});

test("a failed dispatch keeps the approval and says it goes live with the next daily run", async () => {
  const f = fakeStore();
  const out = await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: async () => "failed" });
  assert.equal(out.kind, "done");
  assert.equal(f.row?.approved, true);
  assert.match(describeDecision(out).detail ?? "", /next daily run/);
  const noToken = await decide({ store: fakeStore().store, id: ID, action: "approve", now: NOW, dispatch: async () => "no-token" });
  assert.match(describeDecision(noToken).detail ?? "", /next daily run/);
  const ok = await decide({ store: fakeStore().store, id: ID, action: "approve", now: NOW, dispatch: async () => "dispatched" });
  assert.match(describeDecision(ok).detail ?? "", /Publishing now/);
});

test("reviewState reads the row", () => {
  assert.equal(reviewState({ id: ID, title: "x" }).kind, "open");
  assert.equal(reviewState({ id: ID, title: "x", reviewed_at: "2026-11-01T00:00:00Z", reviewed_action: "approve" }).kind, "reviewed");
});

test("dispatchPromote: no token, ok, non-2xx and a thrown fetch never throw", async () => {
  const log = () => {};
  assert.equal(await dispatchPromote({ token: "", log }), "no-token");
  const seen: { url: string; body: string }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: String(init.body) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  assert.equal(await dispatchPromote({ token: "t", fetchImpl: ok, log }), "dispatched");
  assert.match(seen[0].url, /actions\/workflows\/daily-deals\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(seen[0].body), { ref: "main", inputs: { mode: "promote" } });
  const bad = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
  assert.equal(await dispatchPromote({ token: "t", fetchImpl: bad, log }), "failed");
  const boom = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
  assert.equal(await dispatchPromote({ token: "t", fetchImpl: boom, log }), "failed");
});

// --- older duplicates of the same slug ------------------------------------------------------------------

const OLD1 = { created_at: "2026-10-19T06:00:00Z", batch_id: "edi-2026-10-19" };
const OLD2 = { created_at: "2026-10-26T06:00:00Z", batch_id: "edi-2026-10-26" };

test("approving closes the older unreviewed rows of that slug as superseded, and nothing else", async () => {
  const f = fakeStore({}, [
    OLD1,
    OLD2,
    { ...OLD2, slug: "something-else" }, // other slug
    { created_at: "2026-11-03T06:00:00Z" }, // newer than the one decided
    { ...OLD1, reviewed_at: "2026-10-20T00:00:00Z", reviewed_action: "reject", extraction_status: "rejected" }, // already reviewed
    { ...OLD1, approved: true, extraction_status: "approved" }, // approved earlier
    { ...OLD1, happening_id: "11111111-1111-4111-8111-111111111111", extraction_status: "promoted" }, // already live
  ]);
  const out = await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: counter().dispatch });
  assert.equal(out.kind === "done" && out.closedOlder, 2);
  assert.equal(f.closed.length, 2);
  const [a, b, otherSlug, newer, reviewed, approved, live] = f.table.slice(1);
  for (const r of [a, b]) {
    assert.equal(r.reviewed_action, "superseded");
    assert.equal(r.extraction_status, "rejected");
    assert.equal(r.reviewed_at, NOW.toISOString());
    assert.match(r.rejected_reason ?? "", /superseded/);
    assert.notEqual(r.approved, true);
  }
  assert.equal(otherSlug.reviewed_at, null);
  assert.equal(newer.reviewed_at, null);
  assert.equal(reviewed.reviewed_action, "reject");
  assert.equal(approved.reviewed_at, null);
  assert.equal(live.reviewed_at, null);
  // only the decided row is approved
  assert.deepEqual(f.table.filter((r) => r.approved === true && r.reviewed_action === "approve").map((r) => r.id), [ID]);
});

test("rejecting closes the older unreviewed rows too", async () => {
  const f = fakeStore({}, [OLD1, OLD2]);
  const out = await decide({ store: f.store, id: ID, action: "reject", now: NOW });
  assert.equal(out.kind === "done" && out.closedOlder, 2);
  assert.deepEqual(f.table.slice(1).map((r) => r.reviewed_action), ["superseded", "superseded"]);
});

test("a second tap on the same row closes nothing more and changes nothing", async () => {
  const f = fakeStore({}, [OLD1]);
  await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: counter().dispatch });
  const before = JSON.stringify(f.table);
  const again = await decide({ store: f.store, id: ID, action: "approve", now: new Date(NOW.getTime() + 5000), dispatch: counter().dispatch });
  assert.equal(again.kind, "already");
  assert.equal(JSON.stringify(f.table), before);
  assert.equal(f.closed.length, 1);
});

test("a decision refused as already-reviewed never closes siblings", async () => {
  const f = fakeStore({ reviewed_at: "2026-11-01T00:00:00Z", reviewed_action: "reject", extraction_status: "rejected" }, [OLD1]);
  const out = await decide({ store: f.store, id: ID, action: "approve", now: NOW });
  assert.equal(out.kind, "already");
  assert.equal(f.closed.length, 0);
  assert.equal(f.table[1].reviewed_at, null);
});

test("if closing older duplicates fails, the decision still stands", async () => {
  const f = fakeStore({}, [OLD1], { closeThrows: true });
  const saved = console.error;
  console.error = () => {};
  try {
    const out = await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: counter().dispatch });
    assert.deepEqual(out, { kind: "done", title: "£4 cask pints", action: "approve", dispatch: "dispatched", closedOlder: 0 });
    assert.equal(f.row.approved, true);
  } finally {
    console.error = saved;
  }
});

test("promote-happenings picks only approved rows: closed duplicates are never approved", async () => {
  // scripts/promote-happenings.mjs selects approved=true AND extraction_status<>promoted.
  const f = fakeStore({}, [OLD1, OLD2]);
  await decide({ store: f.store, id: ID, action: "approve", now: NOW, dispatch: counter().dispatch });
  const picked = f.table.filter((r) => r.approved === true && r.extraction_status !== "promoted");
  assert.deepEqual(picked.map((r) => r.id), [ID]);
});
