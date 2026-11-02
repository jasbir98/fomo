/**
 * Applying one approve / reject decision to a staged deal. Pure orchestration
 * over a `ReviewStore`, so the idempotency rules are testable with a fake
 * store; app/review/[token]/actions.ts supplies the real one (lib/review/store.ts).
 *
 * Rules:
 *   - Re-read the row first. If it was already reviewed (or is live, or was
 *     approved or rejected some other way) change NOTHING and say what happened.
 *   - Writes are conditional on the row still being open, so two taps (or an
 *     email scanner and a person) cannot both win: the loser's write matches
 *     no row and it reports the winner's outcome.
 *   - Approve uses the same state change as the weekly report's approve SQL
 *     (scraper/weekly_edinburgh.py approve_sql): approved = true,
 *     extraction_status = 'approved'. Promotion stays scripts/promote-happenings.mjs.
 *   - The workflow dispatch happens only after OUR write succeeded, and its
 *     failure never undoes the approval.
 *   - Past batches stage the same slug again. After our write succeeds, older
 *     UNREVIEWED rows with the same slug are closed too (reviewed_action
 *     'superseded', same conditional style), so they cannot reach a later
 *     digest or be promoted by accident. That step is best effort: a failure
 *     never undoes the decision (the digest also skips any slug that has a
 *     decided row).
 */
import { SUPERSEDED_ACTION, SUPERSEDED_REASON, type StagedDeal } from "./digest";
import type { DispatchResult } from "./dispatch";
import type { ReviewAction } from "./token";

export const MAX_REASON_LENGTH = 200;
export const DEFAULT_REJECT_REASON = "rejected in digest review";

export type ReviewPatch = {
  approved?: boolean;
  extraction_status: "approved" | "rejected";
  rejected_reason?: string;
  reviewed_at: string;
  reviewed_action: ReviewAction;
  updated_at: string;
};

export interface ReviewStore {
  read(id: string): Promise<StagedDeal | null>;
  /** Apply `patch` only if the row is still open. True when a row was written. */
  writeIfOpen(id: string, patch: ReviewPatch): Promise<boolean>;
  /**
   * Close the OLDER, still-open rows with the same slug as `row` (conditional on
   * each still being unreviewed). Returns how many were closed.
   */
  closeOlderDuplicates(row: StagedDeal, patch: SupersededPatch): Promise<number>;
}

export type SupersededPatch = {
  extraction_status: "rejected";
  rejected_reason: string;
  reviewed_at: string;
  reviewed_action: typeof SUPERSEDED_ACTION;
  updated_at: string;
};

export function buildSupersededPatch(now: Date): SupersededPatch {
  const iso = now.toISOString();
  return { extraction_status: "rejected", rejected_reason: SUPERSEDED_REASON, reviewed_at: iso, reviewed_action: SUPERSEDED_ACTION, updated_at: iso };
}

/** Where a staged row stands, for deciding whether a decision may still be made. */
export type ReviewState =
  | { kind: "open" }
  | { kind: "reviewed"; action: string; at: string | null; reason: string | null }
  | { kind: "live" }
  | { kind: "approved-elsewhere" }
  | { kind: "rejected-elsewhere"; reason: string | null };

export function reviewState(row: StagedDeal): ReviewState {
  if (row.reviewed_at) {
    return { kind: "reviewed", action: row.reviewed_action ?? "reviewed", at: row.reviewed_at, reason: row.rejected_reason ?? null };
  }
  if (row.happening_id || row.extraction_status === "promoted") return { kind: "live" };
  if (row.approved === true || row.extraction_status === "approved") return { kind: "approved-elsewhere" };
  if (row.extraction_status === "rejected") return { kind: "rejected-elsewhere", reason: row.rejected_reason ?? null };
  return { kind: "open" };
}

export function cleanReason(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_REJECT_REASON;
  const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_LENGTH);
  return t || DEFAULT_REJECT_REASON;
}

export function buildPatch(action: ReviewAction, now: Date, reason?: unknown): ReviewPatch {
  const iso = now.toISOString();
  if (action === "approve") {
    return { approved: true, extraction_status: "approved", reviewed_at: iso, reviewed_action: "approve", updated_at: iso };
  }
  return { extraction_status: "rejected", rejected_reason: cleanReason(reason), reviewed_at: iso, reviewed_action: "reject", updated_at: iso };
}

export type Decision =
  | { kind: "missing" }
  | { kind: "already"; title: string; state: Exclude<ReviewState, { kind: "open" }> }
  | { kind: "done"; title: string; action: ReviewAction; dispatch: DispatchResult | null; closedOlder: number };

export async function decide(opts: {
  store: ReviewStore;
  id: string;
  action: ReviewAction;
  reason?: unknown;
  now?: Date;
  /** Called once, after a successful approve write. */
  dispatch?: () => Promise<DispatchResult>;
}): Promise<Decision> {
  const { store, id, action } = opts;
  const now = opts.now ?? new Date();

  const row = await store.read(id);
  if (!row) return { kind: "missing" };

  const before = reviewState(row);
  if (before.kind !== "open") return { kind: "already", title: row.title, state: before };

  const wrote = await store.writeIfOpen(id, buildPatch(action, now, opts.reason));
  if (!wrote) {
    // Lost a race (or the row changed between the read and the write): report what is there now.
    const fresh = await store.read(id);
    if (!fresh) return { kind: "missing" };
    const state = reviewState(fresh);
    if (state.kind === "open") throw new Error("review write matched no row although the row is still open");
    return { kind: "already", title: fresh.title, state };
  }

  let closedOlder = 0;
  try {
    closedOlder = await store.closeOlderDuplicates(row, buildSupersededPatch(now));
  } catch (err) {
    console.error("[review] closing older duplicates failed:", err instanceof Error ? err.message : err);
  }

  const dispatch = action === "approve" && opts.dispatch ? await opts.dispatch() : null;
  return { kind: "done", title: row.title, action, dispatch, closedOlder };
}

// --- wording ----------------------------------------------------------------------------------

export type Outcome = { tone: "good" | "neutral" | "bad"; headline: string; detail: string | null };

const dateOf = (iso: string | null) => {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime())
    ? ""
    : ` on ${t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" })}`;
};

export function describeState(state: Exclude<ReviewState, { kind: "open" }>): Outcome {
  switch (state.kind) {
    case "live":
      return { tone: "neutral", headline: "Already live", detail: "This deal is already on Fomo. Nothing was changed." };
    case "approved-elsewhere":
      return { tone: "neutral", headline: "Already approved", detail: "This deal was approved before. Nothing was changed." };
    case "rejected-elsewhere":
      return { tone: "neutral", headline: "Already rejected", detail: state.reason ? `Reason: ${state.reason}. Nothing was changed.` : "Nothing was changed." };
    case "reviewed": {
      const when = dateOf(state.at);
      if (state.action === "approve") return { tone: "neutral", headline: `Already approved${when}`, detail: "Nothing was changed." };
      if (state.action === "reject") {
        return { tone: "neutral", headline: `Already rejected${when}`, detail: state.reason ? `Reason: ${state.reason}. Nothing was changed.` : "Nothing was changed." };
      }
      if (state.action === "superseded") {
        return { tone: "neutral", headline: `Already handled${when}`, detail: "Another copy of this deal was reviewed, so this one was closed. Nothing was changed." };
      }
      if (state.action === "expired") {
        return { tone: "neutral", headline: `This one expired${when}`, detail: "It waited more than 14 days without a decision, so it was dropped. Nothing was changed." };
      }
      return { tone: "neutral", headline: `Already reviewed${when}`, detail: "Nothing was changed." };
    }
  }
}

export function describeDecision(decision: Decision): Outcome {
  switch (decision.kind) {
    case "missing":
      return { tone: "bad", headline: "This link is no longer valid", detail: null };
    case "already":
      return describeState(decision.state);
    case "done": {
      if (decision.action === "reject") return { tone: "good", headline: "Rejected", detail: "It will not go on Fomo." };
      if (decision.dispatch === "dispatched") return { tone: "good", headline: "Approved", detail: "Publishing now. It should be live within a few minutes." };
      return { tone: "good", headline: "Approved", detail: "It will go live with the next daily run." };
    }
  }
}
