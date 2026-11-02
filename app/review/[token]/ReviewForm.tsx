"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import type { Outcome } from "@/lib/review/decide";
import { submitReview } from "./actions";

const TONE: Record<Outcome["tone"], string> = {
  good: "bg-surface-container text-primary",
  neutral: "bg-surface-container text-on-surface",
  bad: "bg-error-container text-on-error-container",
};

/**
 * The confirm step. Rendering the page changed nothing; this form's POST is
 * what writes. Without JavaScript it still submits (a plain form POST to the
 * Server Action), and the result replaces the form.
 */
export function ReviewForm({ token, action }: { token: string; action: "approve" | "reject" }) {
  const [result, formAction, pending] = useActionState(submitReview.bind(null, token), null);

  if (result) {
    return (
      <div role="status" className={`rounded-2xl p-5 ${TONE[result.tone]}`}>
        <p className="text-headline-sm">{result.headline}</p>
        {result.detail ? <p className="mt-1 text-body-md">{result.detail}</p> : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {action === "reject" ? (
        <label className="flex flex-col gap-1.5 text-label-md font-medium text-on-surface-variant">
          Reason (optional)
          <input
            name="reason"
            type="text"
            maxLength={200}
            autoComplete="off"
            placeholder="e.g. chain, not a real saving"
            className="min-h-[48px] w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 text-body-md text-on-surface placeholder:text-outline focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </label>
      ) : null}
      <Button type="submit" variant={action === "approve" ? "navy" : "danger"} fullWidth disabled={pending} className="min-h-[56px] text-body-lg">
        {pending ? "Saving..." : action === "approve" ? "Approve this deal" : "Reject this deal"}
      </Button>
    </form>
  );
}
