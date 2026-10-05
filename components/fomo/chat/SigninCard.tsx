import Link from "next/link";

/** Sign-in link that lands back on Ask Fomo and asks `question` once signed in (`/fomo?q=…&send=1`). */
function signinHref(question: string): string {
  return `/signin?next=${encodeURIComponent(`/fomo?q=${encodeURIComponent(question)}&send=1`)}&reason=fomo`;
}

/** Under Fomo's limit-hit (or session-expired) message: sign in, and `question` is asked again on the way back. */
export function SigninCard({ question, expired = false }: { question: string; expired?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-[320px] flex-col items-center gap-2 rounded-xl border border-outline-variant/60 bg-surface-container-lowest p-4 text-center">
      <p className="text-label-md font-bold text-primary">{expired ? "Sign in again" : "Keep asking Fomo"}</p>
      <p className="text-label-sm text-on-surface-variant">
        {expired
          ? "It only takes a moment, and your chat is saved."
          : "Signing in is free. You get way more questions and your chat is saved."}
      </p>
      <Link
        href={signinHref(question)}
        className="mt-1 rounded-full bg-primary px-5 py-2 text-label-md font-semibold text-on-primary transition-opacity hover:opacity-90"
      >
        Sign in to continue
      </Link>
    </div>
  );
}
