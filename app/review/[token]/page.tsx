import type { Metadata } from "next";
import { connection } from "next/server";
import { FomoLogo } from "@/components/ui";
import { evidenceQuote, isUnconfirmedSource, safeHttpUrl, topReasons } from "@/lib/review/digest";
import { NO_ANALYTICS_SCRIPT } from "@/lib/review/analytics-guard";
import { describeState, reviewState } from "@/lib/review/decide";
import { supabaseReviewStore } from "@/lib/review/store";
import { verifyReviewToken } from "@/lib/review/token";
import { ReviewForm } from "./ReviewForm";

/**
 * /review/[token]: the page behind the digest email's Approve / Reject buttons.
 *
 * VIEWING CHANGES NOTHING. Email scanners and link previews open every link in
 * a message, so this page only reads. The write is the form's POST (a Server
 * Action, ./actions.ts), which verifies the token again.
 *
 * An invalid, tampered, expired or unknown token gets one generic refusal with
 * no deal data on it. Never indexed, never cached, no referrer sent (so the
 * token is not leaked to the source site or to analytics), and kept out of
 * analytics (lib/review/analytics-guard.ts). Not in app/sitemap.ts.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review a deal",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col gap-5 bg-background px-4 pb-10 pt-8">
      {/* Runs before hydration; see lib/review/analytics-guard.ts. */}
      <script dangerouslySetInnerHTML={{ __html: NO_ANALYTICS_SCRIPT }} />
      <FomoLogo className="self-start" />
      {children}
    </main>
  );
}

function Refusal() {
  return (
    <Shell>
      <div className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
        <h1 className="text-headline-sm text-on-surface">This link is no longer valid</h1>
        <p className="mt-2 text-body-md text-on-surface-variant">
          It may have expired (links last 7 days) or already been used. Ask for a fresh digest to get a new one.
        </p>
      </div>
    </Shell>
  );
}

export default async function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;

  const verified = verifyReviewToken(token);
  if (!verified.ok) return <Refusal />;

  let deal;
  try {
    deal = await supabaseReviewStore().read(verified.id);
  } catch (err) {
    console.error("[review] page read failed:", err instanceof Error ? err.message : err);
    return <Refusal />;
  }
  if (!deal) return <Refusal />;

  const state = reviewState(deal);
  const reasons = topReasons(deal, 4);
  const quote = evidenceQuote(deal);
  const source = safeHttpUrl(deal.source_url) ?? safeHttpUrl(deal.booking_url);
  const price = deal.saving_label?.trim() || deal.price_text?.trim() || null;
  const approving = verified.action === "approve";

  return (
    <Shell>
      <section className="flex flex-col gap-3 rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
        <h1 className="text-headline-md text-on-surface">{deal.title}</h1>
        {deal.venue_name || price ? (
          <p className="text-body-md text-on-surface-variant">{[deal.venue_name, price].filter(Boolean).join(" · ")}</p>
        ) : null}
        {deal.summary ? <p className="text-body-md text-on-surface">{deal.summary}</p> : null}
        {deal.time_note ? <p className="text-body-sm text-on-surface-variant">{deal.time_note}</p> : null}
        {typeof deal.quality_score === "number" ? (
          <p className="text-label-lg text-primary-container">Score {deal.quality_score}</p>
        ) : null}
        {reasons.length > 0 ? (
          <ul className="list-disc pl-5 text-body-sm text-on-surface-variant">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
        {isUnconfirmedSource(deal) ? (
          <p className="text-label-lg text-brand-orange-ink">
            Unconfirmed: from social media or a newsletter, not checked against the venue&apos;s own page.
          </p>
        ) : null}
        {quote ? <blockquote className="border-l-4 border-outline-variant pl-3 text-body-sm italic text-on-surface-variant">&ldquo;{quote}&rdquo;</blockquote> : null}
        {source ? (
          <a href={source} target="_blank" rel="noopener noreferrer nofollow" className="text-label-lg text-secondary-container underline underline-offset-2">
            View the source page
          </a>
        ) : null}
      </section>

      {state.kind === "open" ? (
        <ReviewForm token={token} action={verified.action} />
      ) : (
        (() => {
          const outcome = describeState(state);
          return (
            <div role="status" className="rounded-2xl bg-surface-container p-5 text-on-surface">
              <p className="text-headline-sm">{outcome.headline}</p>
              {outcome.detail ? <p className="mt-1 text-body-md">{outcome.detail}</p> : null}
            </div>
          );
        })()
      )}

      <p className="text-body-sm text-on-surface-variant">
        {state.kind === "open"
          ? approving
            ? "Nothing changes until you tap Approve."
            : "Nothing changes until you tap Reject."
          : "Opening this page again changes nothing."}
      </p>
    </Shell>
  );
}
