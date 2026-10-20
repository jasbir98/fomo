import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { JsonLd } from "@/components/seo/JsonLd";
import { FeedListCard, FreeAnyTimeRow, SubscribeCard } from "@/components/happenings";
import { Icon, SeeAllButton } from "@/components/ui";
import { weekendDates } from "@/lib/happenings/format";
import { localDayDate } from "@/lib/happenings/occurrence";
import { loadFeedForPage } from "@/lib/happenings/server-feed";
import { weekendCardKey } from "@/lib/happenings/weekend";
import { selectKidsSections, type KidsSections } from "@/lib/kids/sections";
import { feedCardEntry, freeAnyTimeEntry, itemListJsonLd, type ListEntry } from "@/lib/seo/list";
import { pageMetadata } from "@/lib/seo/metadata";

const TITLE = "Free and cheap things to do with kids in Edinburgh";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description:
    "Free museums, playparks, kids-eat-free deals and family events in Edinburgh this weekend and beyond. Checked prices, updated daily.",
  path: "/kids",
  // This route has its own opengraph-image.tsx.
  images: false,
});

/** Re-built at most every two minutes, in line with the catalogue cache (lib/db/cached.ts). */
export const revalidate = 120;

const GRID = "flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4 xl:grid-cols-3";

function Section({
  id,
  icon,
  title,
  blurb,
  children,
}: {
  id: string;
  icon: string;
  title: string;
  blurb: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5 px-1">
        <div className="flex items-center gap-2">
          <Icon name={icon} size={20} className="text-accent" />
          <h2 id={`${id}-title`} className="text-headline-sm font-extrabold tracking-tight text-on-surface">
            {title}
          </h2>
        </div>
        <p className="text-label-md text-on-surface-variant">{blurb}</p>
      </div>
      {children}
    </section>
  );
}

function listEntries(s: KidsSections): ListEntry[] {
  return [
    ...s.weekend.map(feedCardEntry),
    ...s.deals.map(feedCardEntry),
    ...s.freeAnyTime.map(freeAnyTimeEntry),
    ...s.comingUp.map(feedCardEntry),
  ];
}

/**
 * Free and cheap things to do with kids — an SEO landing page built from the
 * same feed as /weekend, /free and /deals, narrowed through lib/happenings/
 * family.ts. A server component so the HTML lists real things;
 * sections with nothing in them are left out.
 */
export default async function KidsPage() {
  const [now, later] = await Promise.all([loadFeedForPage("now"), loadFeedForPage("coming_up")]);
  const today = localDayDate(new Date());
  const { saturday, sunday } = weekendDates();
  const sections = now && later ? selectKidsSections(now, later, today, saturday, sunday) : null;
  const itemList = sections ? itemListJsonLd(TITLE, "/kids", listEntries(sections)) : null;
  const empty =
    !sections || (!sections.weekend.length && !sections.deals.length && !sections.freeAnyTime.length && !sections.comingUp.length);

  return (
    <>
      {itemList ? <JsonLd data={itemList} /> : null}
      <div className="flex flex-col pb-6">
        <div className="flex flex-col gap-6 px-4 pt-safe lg:mx-auto lg:w-full lg:max-w-[1200px] lg:px-8">
          <header className="flex flex-col gap-3 pt-5 lg:pt-8">
            <h1 className="text-headline-md font-extrabold tracking-tight text-primary lg:max-w-3xl lg:text-[2.25rem] lg:leading-tight">
              {TITLE}
            </h1>
          </header>

          {sections?.weekend.length ? (
            <Section
              id="this-weekend"
              icon="weekend"
              title="This weekend"
              blurb="Kid-friendly things on Saturday and Sunday."
            >
              <div className={GRID}>
                {sections.weekend.map((card, i) => (
                  <FeedListCard key={weekendCardKey(card)} card={card} surface="weekend" position={i} />
                ))}
              </div>
              <SeeAllButton href="/weekend?kids=1" total={sections.totals.weekend} shown={sections.weekend.length} />
            </Section>
          ) : null}

          {sections?.deals.length ? (
            <Section
              id="kids-go-free"
              icon="restaurant"
              title="Kids go free & kids eat free"
              blurb="Offers for families. Check each one's dates and conditions."
            >
              <div className={GRID}>
                {sections.deals.map((card, i) => (
                  <FeedListCard key={card.happening.id} card={card} surface="deals" position={i} />
                ))}
              </div>
              <SeeAllButton href="/deals?who=families" total={sections.totals.deals} shown={sections.deals.length} />
            </Section>
          ) : null}

          {sections?.freeAnyTime.length ? (
            <Section
              id="free-any-time"
              icon="all_inclusive"
              title="Free any time"
              blurb="Museums, parks and playparks with £0 admission."
            >
              <div className="flex flex-col gap-2.5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4">
                {sections.freeAnyTime.map((item) => (
                  <FreeAnyTimeRow key={`${item.kind}-${item.id}`} item={item} />
                ))}
              </div>
              <SeeAllButton href="/free?kids=1" total={sections.totals.freeAnyTime} shown={sections.freeAnyTime.length} />
            </Section>
          ) : null}

          {sections?.comingUp.length ? (
            <Section
              id="coming-up"
              icon="event"
              title="Coming up"
              blurb="Kid-friendly dates over the next month, including school-holiday activities."
            >
              <div className={GRID}>
                {sections.comingUp.map((card, i) => (
                  <FeedListCard key={weekendCardKey(card)} card={card} surface="whats_on" position={i} />
                ))}
              </div>
              <SeeAllButton href="/whats-on?kids=1" total={sections.totals.comingUp} shown={sections.comingUp.length} />
            </Section>
          ) : null}

          {empty ? (
            <p className="rounded-2xl border border-dashed border-hairline-strong p-6 text-center text-body-md text-on-surface-variant">
              Nothing kid-specific is lined up right now. Try{" "}
              <Link href="/whats-on?kids=1" className="font-semibold text-primary underline underline-offset-2">
                What&rsquo;s on with kids
              </Link>{" "}
              or{" "}
              <Link href="/free?kids=1" className="font-semibold text-primary underline underline-offset-2">
                free things to do
              </Link>
              .
            </p>
          ) : null}

          <SubscribeCard source="kids" />
        </div>
      </div>
    </>
  );
}
