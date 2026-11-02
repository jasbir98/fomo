"use server";

import { decide, describeDecision, type Outcome } from "@/lib/review/decide";
import { dispatchPromote } from "@/lib/review/dispatch";
import { supabaseReviewStore } from "@/lib/review/store";
import { verifyReviewToken } from "@/lib/review/token";

const REFUSED: Outcome = { tone: "bad", headline: "This link is no longer valid", detail: null };

/**
 * The one write behind /review/[token]. Called from the confirm form's POST
 * (a Server Action), never from viewing the page. It trusts nothing from the
 * request except the token: the token is verified again here, the row id and
 * the action come out of the verified token (not from form fields), and the
 * rest is lib/review/decide.ts (idempotent, conditional writes).
 */
export async function submitReview(token: string, _previous: Outcome | null, formData: FormData): Promise<Outcome> {
  const verified = verifyReviewToken(token);
  if (!verified.ok) return REFUSED;

  try {
    const decision = await decide({
      store: supabaseReviewStore(),
      id: verified.id,
      action: verified.action,
      reason: formData.get("reason"),
      dispatch: () => dispatchPromote(),
    });
    return describeDecision(decision);
  } catch (err) {
    console.error("[review] decision failed:", err instanceof Error ? err.message : err);
    return { tone: "bad", headline: "Something went wrong", detail: "Nothing may have been saved. Reload this page to see where it stands, then try again." };
  }
}
