/**
 * The one-line context /signin shows above its form when a visitor was sent
 * there for a specific reason — "Sign in to chat with Fomo", not a bare
 * form with no idea why they're looking at it. Fed by a `?reason=` query
 * param set by whoever redirected them: proxy.ts (account-gated pages —
 * see its `SIGNIN_REASON_BY_PREFIX`) and lib/useSaved.ts's `sendToSignIn`
 * (a signed-out Save tap) both set it; app/welcome/page.tsx's "Skip"/finish
 * flow does not, so a visitor who went through the intro slides just sees
 * the plain form.
 *
 * Deliberately a closed, known set rather than echoing arbitrary query
 * text back into the page — an unrecognised value (typo'd, stale, or
 * tampered with) renders nothing rather than blank or garbled copy.
 */
const REASON_COPY = {
  fomo: "Sign in to chat with Fomo — it knows everything on this week.",
  save: "Sign in to save this for later.",
  profile: "Sign in to see your profile.",
} as const;

export type SigninReason = keyof typeof REASON_COPY;

export function isSigninReason(value: string | null | undefined): value is SigninReason {
  return !!value && Object.prototype.hasOwnProperty.call(REASON_COPY, value);
}

/** The context line for a `?reason=` value, or `null` for an unset/unknown one. */
export function signinReasonCopy(value: string | null | undefined): string | null {
  return isSigninReason(value) ? REASON_COPY[value] : null;
}
