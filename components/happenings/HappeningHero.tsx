"use client";

import { useState, type MouseEvent } from "react";
import { Icon, NavCard } from "@/components/ui";
import { districtFromAddress } from "@/lib/city";
import { daysUntilLastChance } from "@/lib/happenings/occurrence";
import {
  ELIGIBILITY_ICON,
  bucketForDayDate,
  checkedLabel,
  eligibilityLine,
  heroHeadline,
  oneLinerSummary,
  savingBadgeLabel,
} from "@/lib/happenings/format";
import { categoryDefaultImage, categoryStyle } from "@/lib/happenings/category-style";
import type { Happening, Occurrence } from "@/lib/happenings/types";

export interface HappeningHeroProps {
  happening: Happening;
  occurrence: Occurrence;
}

/**
 * The "Fomo Pick · Last Chance" hero — the top-ranked happening (see
 * app/api/feed/route.ts's `pickHero`). Distinct from components/fomo/Card.tsx's
 * `FomoCard` hero variant: that one renders a ranked `/api/now` Candidate
 * (place/event/experience), this one renders a happening's richer,
 * happening-only fields (promo code, redemption note, eligibility pill)
 * that a Candidate has no room for. The Home page renders whichever one
 * applies — this when there's a live happening, FomoCard's hero as the
 * fallback when there isn't (see the page's own doc comment).
 */
export function HappeningHero({ happening, occurrence }: HappeningHeroProps) {
  const [copied, setCopied] = useState(false);
  const [imgError, setImgError] = useState(false);
  const now = new Date();

  const badge = savingBadgeLabel(happening);
  const district = happening.district ?? districtFromAddress(happening.address);
  const eligibility = eligibilityLine(happening);
  const ctaHref = happening.booking_url ?? happening.source_url;
  const ctaLabel = happening.cta_label ?? "Claim Offer";

  // Truthful pick label — "Last Chance" implies genuine urgency, so it's
  // reserved for occurrences whose window is actually closing soon (<=3
  // days). Doors Open Days two weeks out was showing "Last Chance" before
  // this: the label was hardcoded regardless of how far away the
  // occurrence actually was. Falls back to naming WHEN it is (this
  // weekend / today / coming up) rather than a generic "Fomo Pick" alone,
  // which is still informative without being misleading.
  const daysLeft = daysUntilLastChance(occurrence, now);
  const bucket = bucketForDayDate(occurrence.dayDate, now);
  const pickLabel =
    daysLeft <= 3
      ? "Fomo Pick · Last Chance"
      : bucket === "today_tomorrow"
        ? "Fomo Pick · Today"
        : bucket === "this_weekend"
          ? "Fomo Pick · This Weekend"
          : "Fomo Pick · Coming Up";

  function handleCopy(e: MouseEvent) {
    e.stopPropagation();
    void doCopy();
  }

  async function doCopy() {
    if (!happening.promo_code) return;
    try {
      await navigator.clipboard.writeText(happening.promo_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard API unsupported or denied — the code is still visible in
      // the lockup for a manual copy, so this is a silent no-op, not an error.
    }
  }

  const cat = categoryStyle(happening.category);
  const heroImage = happening.image_url && !imgError ? happening.image_url : categoryDefaultImage(happening.category);

  return (
    <NavCard
      href={`/happening/${happening.id}`}
      ariaLabel={happening.title}
      className="relative flex flex-col overflow-hidden rounded-3xl bg-surface-container-lowest shadow-level-3 cursor-pointer"
    >
      <div className="relative h-40 w-full shrink-0 overflow-hidden bg-surface-container">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={heroImage}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={() => setImgError(true)}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-surface-container-lowest via-surface-container-lowest/15 to-transparent" />

        <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary-container/90 px-3 py-1 text-label-sm font-bold text-on-primary-container backdrop-blur-md">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-secondary-fixed-dim animate-pulse" />
            {pickLabel}
          </span>
          {badge ? (
            <span className="shrink-0 rounded-full border border-on-primary/20 bg-primary-container px-3 py-1 text-label-md font-bold text-on-primary-container shadow-md backdrop-blur-md">
              {badge}
            </span>
          ) : null}
        </div>

        <div className="absolute bottom-2.5 left-3.5 flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-sm font-bold backdrop-blur-md ${cat.badgeClass}`}>
            <Icon name={cat.icon} size={13} />
            {cat.label}
          </span>
          {district ? (
            <div className="flex items-center gap-1 text-primary">
              <Icon name="pin_drop" size={16} />
              <span className="text-label-sm font-extrabold uppercase tracking-wider">{district}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4 pt-2.5">
        <div className="flex flex-col gap-1">
          <h2 className="line-clamp-2 text-headline-md font-extrabold leading-snug text-on-surface">
            {heroHeadline(happening, occurrence, now)}
          </h2>
          {oneLinerSummary(happening.summary) ? (
            <p className="line-clamp-1 text-body-sm text-on-surface-variant">{oneLinerSummary(happening.summary)}</p>
          ) : null}
        </div>

        {happening.promo_code ? (
          <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-container-low p-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary-fixed text-primary">
                <Icon name="vpn_key" size={18} />
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="text-[9px] font-bold uppercase tracking-wider text-on-surface-variant">
                  {happening.redemption_note ?? "Code at checkout"}
                </span>
                <span className="truncate text-body-sm font-extrabold tracking-wider text-on-surface">
                  {happening.promo_code}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-label-sm font-bold text-on-primary transition-opacity hover:opacity-90 active:scale-95"
            >
              <Icon name={copied ? "check" : "content_copy"} size={14} />
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        ) : null}

        {eligibility ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full border border-hairline bg-surface-container px-2.5 py-1 text-label-sm font-medium text-on-surface-variant">
              <Icon name={ELIGIBILITY_ICON[happening.eligibility]} size={13} className="text-accent" />
              {eligibility}
            </span>
          </div>
        ) : null}

        <div className="flex items-center gap-2.5 border-t border-hairline pt-2.5">
          {/* Icon-only verified mark — the full "source · Checked Nd ago"
              line moved to the detail page's own Provenance section; the
              hero only needs a trust signal, not the sentence. Sits flush
              against the CTA (not `justify-between`'d to the opposite edge)
              so the footer row doesn't read as a big dead gap between two
              small elements — the CTA fills the rest of the width instead. */}
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-container text-accent"
            title={`${happening.source_name} · ${checkedLabel(happening.verified_at, now)}`}
            aria-label={`Verified by ${happening.source_name}, ${checkedLabel(happening.verified_at, now).toLowerCase()}`}
          >
            <Icon name="verified" size={15} />
          </span>
          <a
            href={ctaHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary px-4 py-2.5 text-label-md font-bold text-on-primary shadow-sm transition-opacity hover:opacity-90 active:scale-95"
          >
            {ctaLabel}
            <Icon name="arrow_forward" size={16} />
          </a>
        </div>
      </div>
    </NavCard>
  );
}

export default HappeningHero;
