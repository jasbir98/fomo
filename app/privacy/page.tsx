// Not legal advice: worth a solicitor's (or Termly/iubenda's) review. The bullet points describing what data
// this app collects were derived by reading the actual code (see each
// section's inline source references below) as of 2026-09-28 (PostHog
// analytics added); re-check them whenever a new data-collecting feature
// ships.

import Link from "next/link";
import { PageHeader } from "@/components/ui";

export const metadata = {
  title: "Privacy Policy",
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

export default function PrivacyPage() {
  return (
    <div className="flex min-h-dvh w-full flex-col bg-background pb-safe">
      <PageHeader title="Privacy Policy" showBack />
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 px-5 pb-12 lg:max-w-3xl lg:px-8 lg:py-12">
        <p className="text-label-sm text-on-surface-variant">Last updated 5 October 2026.</p>

        <Section title="Who we are">
          <p>
            Fomo (askfomo.com) is operated by <strong>Jasbir Singh</strong>, a sole trader (&ldquo;we&rdquo;,
            &ldquo;us&rdquo;). For any question about this policy or your data, contact{" "}
            <strong><a href="mailto:support@askfomo.com">support@askfomo.com</a></strong>.
          </p>
          <p>
            We are the data controller for the personal data described below, and this policy is
            written to meet UK GDPR requirements.
          </p>
        </Section>

        <Section title="What we collect">
          <p>We only collect what the app needs to work. Depending on how you use Fomo, that can include:</p>
          <ul className="list-disc space-y-2 pl-5">
            <li>
              <strong>Account details.</strong>{" "}If you sign in, we (via our auth provider, Supabase)
              store your email address, and (if you sign in with Google) the name and profile
              photo Google shares with us. You can also add or change your display name and photo
              yourself on your Profile.
            </li>
            <li>
              <strong>Saved items.</strong>{" "}Deals, events and places you save are
              stored against your account so they show up in your Saved list.
            </li>
            <li>
              <strong>Chat messages with Ask Fomo.</strong>{" "}Anything you type to our AI assistant is
              stored (linked to your account) so your conversation has memory, and is sent to our AI
              provider (DeepSeek, or Anthropic if DeepSeek is unavailable) to generate a reply. Don&rsquo;t
              share anything sensitive in chat.
            </li>
            <li>
              <strong>Location.</strong>{" "}If you allow it, your browser&rsquo;s location is used to sort
              things by distance and stored against your account so it persists between visits. You
              can deny or revoke this permission in your browser at any time; doing so removes the
              stored location.
            </li>
            <li>
              <strong>Push notifications.</strong>{" "}If you turn on notifications (e.g. for on-sale
              alerts), we store the subscription your browser gives us so we can send you that alert.
              No message content is stored beyond what&rsquo;s needed to identify which alert to send.
            </li>
            <li>
              <strong>Fomo Friday email signup.</strong>{" "}If you join our weekly digest, we store the
              email address you give us and where you signed up. This works without an account and is
              a separate opt-in from having one. You can unsubscribe any time via the link in every
              email.
            </li>
            <li>
              <strong>Tips you submit.</strong>{" "}If you tell us about a deal or event we&rsquo;re
              missing, we store what you send us (and your contact email, if you give one) so we can
              follow up or add it.
            </li>
            <li>
              <strong>Product analytics.</strong>{" "}We use Vercel Analytics (page views, no cookies, no
              personal identification) and PostHog, hosted in the EU, to understand how people use
              Fomo: which pages and features get used, session recordings with every input masked, and
              (via a survey pop-up) feedback you choose to give us. PostHog only starts saving anything
              across visits once you accept the cookie banner (see &ldquo;Cookies&rdquo; below); before
              that, or if you decline, nothing is written to your device. If you&rsquo;re signed in, the
              events PostHog records are linked to your account status (student/working, budget,
              whether you&rsquo;ve set preferences) so we can see which features matter to which kind of
              visitor, never your email or chat content.
            </li>
          </ul>
        </Section>

        <Section title="Cookies">
          <p>
            We use two kinds of cookies. The authentication cookie our auth provider (Supabase) sets to
            keep you signed in is essential to the service. Without it, you&rsquo;d have to sign in
            again on every page, and it isn&rsquo;t something you can opt out of. The second is
            PostHog&rsquo;s analytics cookie, which only gets set once you tap &ldquo;OK&rdquo; on the
            cookie bar at the bottom of the screen; tapping &ldquo;No thanks&rdquo; means nothing is
            stored on your device for analytics, and you won&rsquo;t be asked again either way. We
            don&rsquo;t use advertising or third-party tracking cookies.
          </p>
        </Section>

        <Section title="Why we process your data">
          <p>
            To provide the app (your account, saved items, chat, alerts); to run the Fomo Friday
            digest you opted into; to act on tips you send us; and to understand overall usage so we
            can improve the app. Where processing isn&rsquo;t strictly necessary to run the service
            (like the Fomo Friday digest), we rely on your consent, which you can withdraw at any
            time.
          </p>
        </Section>

        <Section title="Who we share it with">
          <p>
            We share data with the processors that make the app work: Supabase (hosting, database,
            authentication), our AI provider (DeepSeek, or Anthropic) for Ask Fomo replies, Vercel
            (hosting, anonymous analytics and performance monitoring), PostHog (EU-hosted product
            analytics, session replay and surveys), and, if you book something through the app, the
            relevant booking partner (e.g. Viator). We don&rsquo;t sell your data, and we don&rsquo;t
            share it for third-party advertising.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            We keep account data for as long as your account is active. Fomo Friday subscribers are
            kept until you unsubscribe. Tips are kept for as long as useful for adding or verifying
            the deal/event. If you delete your account, we delete or anonymize the personal data tied
            to it within a reasonable period, except where we&rsquo;re required to keep something for
            legal reasons.
          </p>
        </Section>

        <Section title="Your rights">
          <p>Under UK GDPR, you have the right to:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>access the personal data we hold about you;</li>
            <li>ask us to correct it if it&rsquo;s wrong;</li>
            <li>ask us to delete it;</li>
            <li>ask us to restrict or object to how we use it;</li>
            <li>receive a copy in a portable format; and</li>
            <li>complain to the UK Information Commissioner&rsquo;s Office (ico.org.uk).</li>
          </ul>
          <p>
            To delete your account or exercise any of these rights, email{" "}
            <strong><a href="mailto:support@askfomo.com">support@askfomo.com</a></strong>. You can also use
            &ldquo;Delete my account&rdquo; on your Profile page, which opens that email for you. We delete your
            account and the data tied to it within one month and confirm by email.
          </p>
        </Section>

        <Section title="Children">
          <p>Fomo isn&rsquo;t directed at children, and we don&rsquo;t knowingly collect data from anyone under 13.</p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            We may update this policy as the app changes. We&rsquo;ll update the date at the top when
            we do.
          </p>
        </Section>

        <p className="text-body-sm text-on-surface-variant">
          See also our <Link href="/terms" className="underline underline-offset-2">Terms</Link>.
        </p>
      </main>
    </div>
  );
}
