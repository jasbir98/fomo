// NOTE: this is a template, not legal advice. {{OPERATOR_NAME}} below must
// be filled in before this is relied on. Have a solicitor review the
// filled-in copy before launch.

import Link from "next/link";
import { PageHeader } from "@/components/ui";

export const metadata = {
  title: "Terms of Use",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-title-sm font-extrabold tracking-tight text-on-surface">{title}</h2>
      <div className="flex flex-col gap-3 text-body-md leading-relaxed text-on-surface-variant">
        {children}
      </div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="flex min-h-dvh w-full flex-col bg-background pb-safe">
      <PageHeader title="Terms of Use" showBack />
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 px-5 pb-12">
        <p className="text-label-sm text-on-surface-variant">Last updated 26 September 2026.</p>

        <Section title="What Fomo is">
          <p>
            Fomo (askfomo.com, &ldquo;we&rdquo;, &ldquo;us&rdquo;, run by{" "}
            <strong>{"{{OPERATOR_NAME}}"}</strong>) helps you find free, cheap and discounted things
            to do in Edinburgh. By using Fomo, you agree to these terms.
          </p>
        </Section>

        <Section title="Information is best-effort">
          <p>
            We pull prices, opening times, dates and details from venues, event listings and other
            public sources, and keep them as fresh as we reasonably can, but things change without
            notice, and we can&rsquo;t guarantee everything you see is accurate or currently
            available. Always double-check price, availability and timing with the venue or organiser
            directly before you rely on it, especially for anything you&rsquo;re paying for or
            travelling for.
          </p>
        </Section>

        <Section title="Not an official festival or venue app">
          <p>
            Fomo is an independent guide. We aren&rsquo;t affiliated with, endorsed by, or an official
            app of the Edinburgh festivals, any venue, or any event organiser we list, unless we say
            otherwise.
          </p>
        </Section>

        <Section title="Affiliate and booking links">
          <p>
            Some listings link out to third-party booking partners (for example Viator). Some of
            these are affiliate links, so we may earn a commission if you book through them, at no
            extra cost to you. Any booking you make is a contract between you and that third party,
            not with us; their own terms and cancellation policy apply.
          </p>
        </Section>

        <Section title="Submitting tips">
          <p>
            You can send us tips about deals or events we&rsquo;re missing. By submitting a tip, you
            confirm it&rsquo;s accurate to the best of your knowledge and that you have the right to
            share it, and you give us permission to publish it (edited as needed) on Fomo. Don&rsquo;t
            submit anything false, misleading, spammy, or that infringes someone else&rsquo;s rights.
            We can remove or ignore any tip at our discretion.
          </p>
        </Section>

        <Section title="Content removal">
          <p>
            If you own content listed on Fomo and want it changed or removed, email support@askfomo.com and
            we&rsquo;ll act within 48 hours.
          </p>
        </Section>

        <Section title="Acceptable use">
          <p>
            Use Fomo lawfully and don&rsquo;t try to disrupt it, scrape it at scale, or abuse the tip
            or signup forms (including submitting spam or false information). We may suspend or
            remove access for anyone who does.
          </p>
        </Section>

        <Section title="No warranty, limited liability">
          <p>
            Fomo is provided &ldquo;as is&rdquo;, without warranty of any kind. To the extent
            permitted by law, we&rsquo;re not liable for losses arising from information on the app
            being wrong or out of date, from a third-party booking, or from the app being unavailable.
            Nothing here limits liability we can&rsquo;t lawfully limit (e.g. for fraud, or death or
            personal injury caused by our negligence).
          </p>
        </Section>

        <Section title="Changes">
          <p>We may update these terms as the app changes. We&rsquo;ll update the date at the top when we do.</p>
        </Section>

        <Section title="Governing law">
          <p>These terms are governed by the laws of Scotland, and any dispute is subject to the exclusive jurisdiction of the Scottish courts.</p>
        </Section>

        <p className="text-body-sm text-on-surface-variant">
          See also our <Link href="/privacy" className="underline underline-offset-2">Privacy Policy</Link>.
        </p>
      </main>
    </div>
  );
}
