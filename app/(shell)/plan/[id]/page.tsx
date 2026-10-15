import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { SubscribeCard } from "@/components/happenings";
import { PlanPhotos } from "@/components/plans/PlanPhotos";
import { PlanReceipt } from "@/components/plans/PlanReceipt";
import { PlanShareActions } from "@/components/plans/PlanShareActions";
import { getPlan } from "@/lib/plans/db";
import { dayLabel, planSummary } from "@/lib/plans/format";
import { describe, pageMetadata } from "@/lib/seo/metadata";

/** Prerender nothing; cache each plan on first request (see app/(shell)/event/[id]/page.tsx). */
export function generateStaticParams() {
  return [];
}

/** A plan never changes once made, so the cache can hold it for a long time. */
export const revalidate = 3600;

/** `null` = no such plan (404). A failed lookup throws, so the error page shows and nothing broken is cached. */
const loadPlan = cache((id: string) => getPlan(id));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const plan = await loadPlan(id).catch(() => null);
  if (!plan) return { robots: { index: false, follow: true } };
  const summary = planSummary(plan.items);
  return pageMetadata({
    title: summary.headline,
    description:
      describe([plan.items.map((i) => i.title).join(", "), summary.range, "Free and cheap things to do, found on Fomo"]) ??
      summary.headline,
    path: `/plan/${id}`,
    // This segment has its own opengraph-image.tsx (the receipt).
    images: false,
    // A plan is one person's picks, not a page for search results.
    noindex: true,
  });
}

/**
 * A shared weekend plan (askfomo.com/plan/<id>), the landing page for the
 * link someone dropped in a group chat. Account-free to view. Shows the
 * picks as a receipt, then the loop: send it on, make your own, get the
 * weekly email. See docs/plans/2026-10-14-weekend-plan.md.
 */
export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = await loadPlan(id);
  if (!plan) notFound();

  const summary = planSummary(plan.items);
  const days = [...new Set(plan.items.map((i) => i.day))].sort();

  return (
    <div className="flex flex-col pb-6">
      <PageHeader title="Weekend plan" />
      {/* Phone: one column (headline, receipt, buttons). Desktop: the receipt
          on the left, sticky; headline, photos and buttons on the right. */}
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5 px-4 pt-1 lg:grid lg:max-w-[1040px] lg:grid-cols-[440px_minmax(0,1fr)] lg:items-start lg:gap-x-12 lg:gap-y-6 lg:px-8 lg:pt-4">
        <div className="flex flex-col gap-1 lg:col-start-2 lg:row-start-1">
          <h1 className="text-headline-lg font-extrabold leading-tight tracking-tight text-on-surface lg:text-[2.5rem] lg:leading-[1.1]">
            {summary.headline}
          </h1>
          <p className="text-body-md text-on-surface-variant">
            {days.map(dayLabel).join(" & ")} · {plan.items.length} things, picked on Fomo
          </p>
        </div>

        <div className="lg:sticky lg:top-20 lg:col-start-1 lg:row-span-4 lg:row-start-1">
          <PlanReceipt items={plan.items} summary={summary} />
        </div>

        <PlanPhotos items={plan.items} className="hidden lg:col-start-2 lg:grid" />

        <div className="flex flex-col gap-3 lg:col-start-2">
          <PlanShareActions id={plan.id} headline={summary.headline} />
          <p className="text-center text-body-sm text-on-surface-variant lg:text-left">
            Prices are what each listing says. Check before you go.
          </p>
        </div>

        <SubscribeCard source="plan" className="lg:col-start-2" />
      </div>
    </div>
  );
}
