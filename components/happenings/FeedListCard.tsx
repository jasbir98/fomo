"use client";

import { Icon, NavCard, SaveButton, SmartImage } from "@/components/ui";
import { formatEventDate, formatEventPrice, formatEventTimeSpan } from "@/lib/events/format";
import {
  ELIGIBILITY_ICON,
  eligibilityLine,
  happeningTimeLabel,
  happeningTypeTag,
  oneLinerSummary,
  savingBadgeLabel,
} from "@/lib/happenings/format";
import { categoryDefaultImage, categoryStyle, kindStyle } from "@/lib/happenings/category-style";
import type { FeedCardData, SeriesCardData } from "@/lib/happenings/feed-types";
import type { Happening, HappeningKind, Occurrence } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import { whoGroupForEligibility } from "@/lib/happenings/groups";
import { useDealProfile } from "@/lib/useSaved";

export interface FeedListCardProps {
  card: FeedCardData;
}

/** "NATIONAL EVENT"/"REGIONAL EVENT" render as a plain accent label (the mockup's National Cinema Weekend row); everything else (EVENT/DEAL/FESTIVAL, and every event card) renders as a filled pill. */
function isWideScopeTag(tag: string): boolean {
  return tag === "NATIONAL EVENT" || tag === "REGIONAL EVENT";
}

/** `kind` picks the pill's colour (lib/happenings/category-style.ts's
 *  KIND_STYLE) — one of the "everything's blue" fixes: DEAL/EVENT/ACTIVITY/
 *  TOUR/FESTIVAL used to all render the same navy bg-primary-container pill
 *  regardless of what they were. */
function TypeTag({ tag, kind }: { tag: string; kind: HappeningKind }) {
  if (isWideScopeTag(tag)) {
    return <span className="text-[10px] font-bold uppercase tracking-wider text-secondary">{tag}</span>;
  }
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${kindStyle(kind).className}`}>
      {tag}
    </span>
  );
}

/** Small leading thumbnail — happening's own `image_url`, else a bundled
 *  per-category default (lib/happenings/category-style.ts). No place-photo
 *  fallback here (unlike VenueDealCard, which already gets one for free from
 *  the venue lookup app/api/feed/route.ts already does) — the default image
 *  is always a valid local asset, so this never needs an error/icon fallback. */
function Thumbnail({ src, alt, size = 64 }: { src: string; alt: string; size?: number }) {
  return (
    <div
      className="shrink-0 overflow-hidden rounded-lg border border-hairline bg-surface-container"
      style={{ width: size, height: size }}
    >
      <SmartImage src={src} alt={alt} width={size} height={size} className="h-full w-full object-cover" />
    </div>
  );
}

/** Small coloured category glyph — the other half of the "everything's blue" fix, next to the kind pill on every happening row. */
function CategoryDot({ category }: { category: Happening["category"] }) {
  const style = categoryStyle(category);
  return <Icon name={style.icon} size={13} className={style.textClass} />;
}


/** Makes the whole card row navigate to `href` while keeping its own inner
 *  buttons/links working — see components/ui/NavCard.tsx's doc comment for
 *  why this is a div, not a wrapping `<a>`/`<Link>` (a bookmark button or
 *  the CTA anchor inside would be invalid HTML nested in a real `<a>`). */
/** No outer border — a soft shadow (--shadow-level-1, strengthening to
 *  -level-2 on hover) does the separating job instead, matching the mockup's
 *  glass-panel treatment (app/globals.css's elevation doc comment). */
function CardShell({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <NavCard
      href={href}
      className="flex cursor-pointer flex-col gap-2 rounded-2xl bg-surface-container-lowest p-4 shadow-level-1 transition-shadow hover:shadow-level-2"
    >
      {children}
    </NavCard>
  );
}

function HappeningRow({ happening, occurrence }: { happening: Happening; occurrence: Occurrence }) {
  const tag = happeningTypeTag(happening, occurrence.exact);
  const time = happeningTimeLabel(occurrence);
  const venue = happening.venue_name ?? happening.district;
  const badge = savingBadgeLabel(happening);
  const eligibility = eligibilityLine(happening);
  const { who } = useDealProfile();
  const whoGroup = whoGroupForEligibility(happening.eligibility);
  const qualifies = whoGroup != null && who.includes(whoGroup);
  const oneLiner = oneLinerSummary(happening.summary);

  const thumbnail = happening.image_url ?? categoryDefaultImage(happening.category);

  // CARD DENSITY: this row shows ONLY a compact meta chip row (kind/time/
  // venue), the title, one derived one-liner, the price badge and (at most)
  // one eligibility badge. The full saving_label sentence, the full summary,
  // the eligibility_note/allowance_note sentence, and the source/"Checked
  // Nd ago" line all used to render here too — they still render in full on
  // the happening's own /happening/[id] page, just never duplicated outside
  // the card (see the Home card-density pass).
  return (
    <CardShell href={`/happening/${happening.id}`}>
      <div className="flex items-start justify-between gap-3">
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-on-surface-variant">
            <CategoryDot category={happening.category} />
            <TypeTag tag={tag} kind={happening.kind} />
            {time ? <span className="font-bold text-accent">{time}</span> : null}
            {(time || tag) && venue ? <span>•</span> : null}
            {venue ? <span className="truncate">{venue}</span> : null}
          </div>
          <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{happening.title}</h4>
        </div>
        {badge ? (
          <span className="shrink-0 whitespace-nowrap rounded-full border border-hairline-strong bg-surface-container px-2.5 py-1 text-label-md font-extrabold text-primary shadow-xs">
            {badge}
          </span>
        ) : null}
      </div>

      {oneLiner ? (
        <p className="line-clamp-1 text-body-sm leading-relaxed text-on-surface-variant">{oneLiner}</p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        {eligibility && qualifies ? (
          <span className="inline-flex w-fit items-center gap-1 rounded-full bg-secondary-container/25 px-2 py-0.5 text-[11px] font-bold text-primary">
            <Icon name="check_circle" filled size={12} />
            You qualify · {eligibility}
          </span>
        ) : eligibility ? (
          <span className="inline-flex w-fit items-center gap-1 rounded-full bg-surface-container px-2 py-0.5 text-[11px] font-bold text-secondary">
            <Icon name={ELIGIBILITY_ICON[happening.eligibility]} size={12} />
            {eligibility}
          </span>
        ) : (
          <span />
        )}
        <SaveButton subjectType="happening" subjectId={happening.id} className="-my-2 -mr-2" />
      </div>
    </CardShell>
  );
}

/**
 * A collapsed series card (lib/happenings/series.ts) — "Parkrun · 3
 * locations" instead of a separate row per location. Borrows its
 * image/category/eligibility from `card.lead`, but the title and the
 * "N locations" line are the series' own; tapping it goes to the lead's
 * `/happening/[id]` page, which lists every member under "Also at" (see
 * that page's Locations section). No external booking CTA here — a series
 * has no one booking link, only its detail page does per-location.
 */
function SeriesRow({ card }: { card: SeriesCardData }) {
  const { lead, occurrence } = card;
  const tag = happeningTypeTag(lead, occurrence.exact);
  const time = happeningTimeLabel(occurrence);
  const thumbnail = lead.image_url ?? categoryDefaultImage(lead.category);
  const oneLiner = oneLinerSummary(lead.summary);

  return (
    <CardShell href={`/happening/${lead.id}`}>
      <div className="flex items-start justify-between gap-3">
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-on-surface-variant">
            <CategoryDot category={lead.category} />
            <TypeTag tag={tag} kind={lead.kind} />
            {time ? <span className="font-bold text-accent">{time}</span> : null}
            <span>•</span>
            <span className="truncate font-semibold text-secondary">{card.locationCount} locations</span>
          </div>
          <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{card.title}</h4>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        {oneLiner ? (
          <p className="line-clamp-1 text-body-sm leading-relaxed text-on-surface-variant">{oneLiner}</p>
        ) : (
          <span />
        )}
        <SaveButton subjectType="happening" subjectId={lead.id} className="-my-2 -mr-2" />
      </div>
    </CardShell>
  );
}

function FestivalRow({ happening }: { happening: Happening }) {
  const badge = savingBadgeLabel(happening);
  const ctaHref = happening.booking_url ?? happening.source_url;
  const ctaLabel = happening.cta_label ?? "View Details";
  let sourceHost = happening.source_url;
  try {
    sourceHost = new URL(happening.source_url).hostname.replace(/^www\./, "");
  } catch {
    // source_url failed to parse as a URL — fall back to the raw string.
  }
  const bannerImage = happening.image_url ?? categoryDefaultImage(happening.category);

  return (
    <NavCard
      href={`/happening/${happening.id}`}
      ariaLabel={happening.title}
      className="flex cursor-pointer flex-col overflow-hidden rounded-3xl bg-surface-container-lowest shadow-level-2"
    >
      {/* Full-width banner — the feed's max container is 480px (see e.g.
          app/(shell)/happening/[id]/page.tsx's own max-w-[480px]), so that's
          the realistic upper bound for the CDN/next-image transform width. */}
      <SmartImage
        src={bannerImage}
        alt=""
        width={480}
        height={112}
        sizes="(max-width: 480px) 100vw, 480px"
        className="h-28 w-full object-cover"
      />
      <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${kindStyle("festival").className}`}>
              Festival
            </span>
            {happening.editorial_tag ? (
              <span className="text-label-sm font-bold text-secondary">{happening.editorial_tag}</span>
            ) : null}
          </div>
          <h4 className="pt-1 text-headline-md font-extrabold leading-tight text-on-surface">{happening.title}</h4>
        </div>
        {badge ? (
          <span className="shrink-0 rounded-full border border-on-primary/20 bg-primary-container px-3 py-1 text-label-md font-extrabold text-on-primary-container shadow-xs">
            {badge}
          </span>
        ) : null}
      </div>

      {oneLinerSummary(happening.summary) ? (
        <p className="line-clamp-1 text-body-sm leading-relaxed text-on-surface-variant">
          {oneLinerSummary(happening.summary)}
        </p>
      ) : null}

      {/* Source domain + an icon-only verified mark — the full "Checked Nd
          ago" text moved to the detail page's Provenance section. */}
      <div className="flex items-center justify-between rounded-lg bg-surface-container p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="public" size={17} className="text-accent" />
          <span className="truncate text-label-md font-bold text-on-surface">{sourceHost}</span>
        </div>
        <Icon name="verified" size={16} className="shrink-0 text-secondary" />
      </div>

      <a
        href={ctaHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary py-2.5 text-label-md font-bold text-on-primary shadow-sm transition-opacity hover:opacity-90 active:scale-[0.98]"
      >
        {ctaLabel}
        <Icon name="north_east" size={16} />
      </a>
      </div>
    </NavCard>
  );
}

function EventRow({ event }: { event: EventItem }) {
  const eventDate = formatEventDate(event.starts_at);
  const eventTime = formatEventTimeSpan(event.starts_at, event.ends_at);
  const price = formatEventPrice(event);
  // EventItem (Skiddle/Ticketmaster) has no HappeningCategory-shaped column —
  // its own `category` is a free-text provider string, not our enum — so the
  // fallback default image just uses the neutral "other" category tile
  // rather than trying to map an arbitrary provider string onto our palette.
  const thumbnail = event.image_url ?? categoryDefaultImage(null);

  return (
    <CardShell href={`/event/${event.id}`}>
      <div className="flex items-start justify-between gap-3">
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-on-surface-variant">
            <TypeTag tag="EVENT" kind="event" />
            <span className="font-bold text-accent">{eventDate}</span>
            {event.venue_name ? (
              <>
                <span>•</span>
                <span className="truncate">{event.venue_name}</span>
              </>
            ) : null}
          </div>
          <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{event.name}</h4>
        </div>
        {price ? (
          <span className="shrink-0 rounded-full border border-hairline-strong bg-surface-container px-2.5 py-1 text-label-md font-extrabold text-primary shadow-xs">
            {price}
          </span>
        ) : null}
      </div>

      {oneLinerSummary(event.description) ? (
        <p className="line-clamp-1 text-body-sm leading-relaxed text-on-surface-variant">
          {oneLinerSummary(event.description)}
        </p>
      ) : null}

      <div className="flex items-center justify-between border-t border-hairline pt-2 text-on-surface-variant">
        <span className="flex items-center gap-1 text-[11px] font-medium">
          <Icon name="schedule" size={14} className="text-secondary" />
          {eventTime}
        </span>
        <SaveButton subjectType="event" subjectId={event.id} className="-my-2 -mr-2" />
      </div>
    </CardShell>
  );
}

/**
 * One row in a date bucket. Normalizes a happening OR a cheap event into the
 * same card chrome (type tag, time/venue line, price badge, title,
 * description, eligibility, provenance, save) — the mockup draws both from
 * the same visual template, and duplicating that template per data source
 * is exactly the kind of drift lib/happenings/format.ts's helpers exist to
 * prevent. A `kind: "happening"` row whose own `kind` field is `"festival"`
 * instead renders the wider civic variant (source-link row + full-width
 * CTA), matching the mockup's Doors Open Days card.
 */
export function FeedListCard({ card }: FeedListCardProps) {
  if (card.kind === "series") return <SeriesRow card={card} />;
  if (card.kind === "happening") {
    if (card.happening.kind === "festival") return <FestivalRow happening={card.happening} />;
    return <HappeningRow happening={card.happening} occurrence={card.occurrence} />;
  }
  return <EventRow event={card.event} />;
}

export default FeedListCard;
