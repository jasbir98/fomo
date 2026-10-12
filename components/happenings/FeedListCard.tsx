"use client";

import { createContext, useContext } from "react";
import { Icon, NavCard, SaveButton, SmartImage } from "@/components/ui";
import { eventIsInProgress, formatEventDate, formatEventPrice, formatEventTimeSpan, formatEventWhen } from "@/lib/events/format";
import {
  ELIGIBILITY_ICON,
  checkedLabel,
  eventOnNowLabel,
  eligibilityLine,
  happeningDayLabel,
  happeningOnNowLabel,
  happeningTimeLabel,
  happeningTypeTag,
  occurrenceRangeLabel,
  oneLinerSummary,
  savingBadgeLabel,
  shortDayLabel,
} from "@/lib/happenings/format";
import { occurrenceIsLive } from "@/lib/happenings/occurrence";
import { categoryStyle, defaultImageFor, kindStyle } from "@/lib/happenings/category-style";
import { priceLabelForCard, priceLabelForEvent, priceLabelForHappening } from "@/lib/happenings/price-label";
import { PriceTag } from "@/components/happenings/PriceTag";
import type { FeedCardData, RecurringCardData, SeriesCardData } from "@/lib/happenings/feed-types";
import type { Happening, HappeningKind, Occurrence } from "@/lib/happenings/types";
import type { EventItem } from "@/lib/types";
import { whoGroupForEligibility } from "@/lib/happenings/groups";
import { interestForHappeningCategory } from "@/lib/personalise/interests";
import { useEffectiveWho } from "@/lib/personalise/useEffectiveWho";
import { happeningToPreview, prefetchHappening, setHappeningPreview } from "@/lib/happenings/preview-cache";
import { eventToPreview, prefetchEvent, setEventPreview } from "@/lib/events/preview-cache";
import { eventImageFor } from "@/lib/events/image";
import { track, priceBand, trackOutboundClicked } from "@/lib/analytics/track";
import { isNewSince, useNewSinceCutoff } from "@/lib/personalise/freshness";

/** Set by FeedListCard for the row it renders; CardShell reads it to show the "New" badge. */
const CardIsNew = createContext(false);

/** Where this list is mounted — sent as `card_opened`'s `surface` so
 *  analytics can tell a Home "What's on" tap apart from the same card
 *  rendered on /whats-on, /weekend, /deals, /free or /book-early. */
export type FeedCardSurface = "home_whats_on" | "whats_on" | "weekend" | "free" | "deals" | "book_early" | "home_any_day" | "whats_on_any_day";

export interface FeedListCardProps {
  card: FeedCardData;
  /** Omitted only by call sites not yet passing it through — `card_opened` still fires, just without a `surface`. */
  surface?: FeedCardSurface;
  /** 0-based index within its list, when cheaply known at the call site. */
  position?: number;
}

/** One `card_opened` call site for every happening-backed row variant below
 *  — `kind` is always "happening" (what detail page it opens), `source` is
 *  the more specific sub-type: the happening's own `kind` (deal/event/
 *  activity/tour/festival) for a single row, or "series"/"recurring" for
 *  the aggregated card variants. */
function trackCardOpened(
  source: string,
  id: string,
  surface: FeedCardSurface | undefined,
  position: number | undefined,
  isFree: boolean | null | undefined
) {
  track("card_opened", { kind: "happening", id, source, surface, position, price_band: priceBand(isFree) });
}

function trackEventCardOpened(id: string, surface: FeedCardSurface | undefined, position: number | undefined, isFree: boolean | null | undefined) {
  track("card_opened", { kind: "event", id, source: "event", surface, position, price_band: priceBand(isFree) });
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
    return <span className="text-label-sm font-bold uppercase tracking-wider text-secondary">{tag}</span>;
  }
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-label-sm font-bold uppercase tracking-wide ${kindStyle(kind).className}`}>
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
  return <Icon name={style.icon} size={14} className={`shrink-0 ${style.textClass}`} />;
}

/**
 * The "when" text of a happening/series meta row: a live occurrence reads as
 * one compact plain string ("On now · until 16 May", see
 * `happeningOnNowLabel`); anything else its clock label ("Tonight 8pm", "Fri
 * 3 Oct 7pm"), falling back to the bare day ("Today"/"Tomorrow"/"Fri 3 Oct")
 * for occurrences with no clock time so every card states its date. Computed
 * with `new Date()` at render — safe, because these cards only ever render
 * after the client-side feed fetch (`useCachedJson`'s server snapshot is
 * always empty), never in SSR HTML.
 */
function occurrenceWhenLabel(occurrence: Occurrence): string {
  const now = new Date();
  if (occurrenceIsLive(occurrence, now)) return happeningOnNowLabel(occurrence, now);
  return happeningTimeLabel(occurrence, now) ?? happeningDayLabel(occurrence, now);
}

/**
 * The one-line meta row above a card title: [icon] [tag] WHEN • trailing.
 * The date never truncates (it is the point of the row) — the trailing venue
 * does — and the "•" only renders when there is something after it, so a
 * card with no venue can't end on a dangling bullet.
 */
function MetaRow({
  icon,
  tag,
  when,
  trailing,
  trailingClassName = "",
}: {
  icon?: React.ReactNode;
  tag?: React.ReactNode;
  when: string;
  trailing?: string | null;
  trailingClassName?: string;
}) {
  return (
    // One visible line: flex-wrap + a fixed height hides anything that wraps.
    // The venue group needs ~5rem, so when a long date leaves less than that
    // it drops to the hidden second line whole, instead of showing "• N".
    <div className="mb-1 flex h-5 min-w-0 flex-wrap items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-label-sm font-medium text-on-surface-variant">
      {icon}
      {tag}
      <span className="shrink-0 font-bold text-accent">{when}</span>
      {trailing ? (
        <span className="flex min-w-[5rem] flex-1 basis-0 items-center gap-1.5">
          <span aria-hidden className="shrink-0">•</span>
          <span className={`min-w-0 truncate ${trailingClassName}`}>{trailing}</span>
        </span>
      ) : null}
    </div>
  );
}

/** Optional plain-text scope label for the meta row — the category icon already says what kind of thing this is, so only a wide-scope tag ("NATIONAL EVENT") is worth the width, as plain text. */
function scopeTag(tag: string): React.ReactNode {
  return isWideScopeTag(tag) ? <TypeTag tag={tag} kind="event" /> : null;
}

/**
 * The card's single footer row — provenance/time on the left, the bookmark on
 * the right, vertically centred in one 40px line (the save button used to sit
 * on a row of its own, which read as dead whitespace).
 */
function CardFooter({ children, save }: { children?: React.ReactNode; save: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2 text-label-md text-on-surface-variant">{children}</div>
      <div className="ml-auto shrink-0">{save}</div>
    </div>
  );
}

/** Makes the whole card row navigate to `href` while keeping its own inner
 *  buttons/links working — see components/ui/NavCard.tsx's doc comment for
 *  why this is a div, not a wrapping `<a>`/`<Link>` (a bookmark button or
 *  the CTA anchor inside would be invalid HTML nested in a real `<a>`). */
/** No outer border — a soft shadow (--shadow-level-1, strengthening to
 *  -level-2 on hover) does the separating job instead, matching the mockup's
 *  glass-panel treatment (app/globals.css's elevation doc comment). */
function CardShell({
  href,
  children,
  onPointerDown,
  onNavigate,
}: {
  href: string;
  children: React.ReactNode;
  /** Card→detail instant-preview hand-off (task: happening detail page
   *  load) — see lib/happenings/preview-cache.ts. Undefined for a row that
   *  doesn't link to a happening (EventRow), which just gets Link's normal
   *  behaviour. */
  onPointerDown?: () => void;
  onNavigate?: () => void;
}) {
  const isNew = useContext(CardIsNew);
  return (
    <NavCard
      href={href}
      onPointerDown={onPointerDown}
      onNavigate={onNavigate}
      className="relative flex cursor-pointer flex-col gap-2 rounded-2xl bg-surface-container-lowest p-3.5 shadow-level-1 transition-shadow hover:shadow-level-2"
    >
      {isNew ? (
        <span className="absolute left-2 top-2 z-10 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-extrabold uppercase leading-none tracking-wide text-on-accent shadow-level-1">
          New
        </span>
      ) : null}
      {children}
    </NavCard>
  );
}

function HappeningRow({
  happening,
  occurrence,
  surface,
  position,
}: {
  happening: Happening;
  occurrence: Occurrence;
  surface?: FeedCardSurface;
  position?: number;
}) {
  const tag = happeningTypeTag(happening, occurrence.exact);
  const venue = happening.venue_name ?? happening.district;
  const priceLabel = priceLabelForHappening(happening);
  const eligibility = eligibilityLine(happening);
  const who = useEffectiveWho();
  const whoGroup = whoGroupForEligibility(happening.eligibility);
  const qualifies = whoGroup != null && who.includes(whoGroup);
  const oneLiner = oneLinerSummary(happening.summary);

  const thumbnail = happening.image_url ?? defaultImageFor(happening);

  // CARD DENSITY: this row shows ONLY a compact meta chip row (kind/time/
  // venue), the title, one derived one-liner, the price badge, (at most) one
  // eligibility badge, and — PM decision 2026-09-26 (freshness badge) — a
  // single subtle "Checked Nd ago" line. The full saving_label sentence, the
  // full summary and the eligibility_note/allowance_note sentence still
  // render in full only on the happening's own /happening/[id] page, never
  // duplicated outside the card (see the Home card-density pass); "Checked
  // Nd ago" is the one exception, restored here in as small a footprint as
  // possible (a bare timestamp line, not the full source_name too).
  return (
    <CardShell
      href={`/happening/${happening.id}`}
      onPointerDown={() => prefetchHappening(happening.id)}
      onNavigate={() => {
        setHappeningPreview(
          happening.id,
          happeningToPreview(happening, { priceLabel: savingBadgeLabel(happening), whenLabel: occurrenceRangeLabel(occurrence) })
        );
        trackCardOpened(happening.kind, happening.id, surface, position, happening.is_free);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col">
          <MetaRow
            icon={<CategoryDot category={happening.category} />}
            tag={scopeTag(tag)}
            when={occurrenceWhenLabel(occurrence)}
            trailing={venue}
          />
          <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{happening.title}</h4>
        </div>
        <PriceTag label={priceLabel} />
      </div>

      {oneLiner ? <p className="line-clamp-2 text-body-sm leading-snug text-on-surface-variant">{oneLiner}</p> : null}

      <CardFooter
        save={
          <SaveButton
            subjectType="happening"
            subjectId={happening.id}
            interestHint={interestForHappeningCategory(happening.category)}
            compact
            className="-my-1 -mr-2"
          />
        }
      >
        <span className="shrink-0">{checkedLabel(happening.verified_at)}</span>
        {eligibility && qualifies ? (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-secondary-container/25 px-2 py-0.5 text-label-sm font-bold text-primary">
            <Icon name="check_circle" filled size={12} className="shrink-0" />
            <span className="truncate">You qualify · {eligibility}</span>
          </span>
        ) : eligibility ? (
          <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-surface-container px-2 py-0.5 text-label-sm font-bold text-secondary">
            <Icon name={ELIGIBILITY_ICON[happening.eligibility]} size={12} className="shrink-0" />
            <span className="truncate">{eligibility}</span>
          </span>
        ) : null}
      </CardFooter>
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
function SeriesRow({ card, surface, position }: { card: SeriesCardData; surface?: FeedCardSurface; position?: number }) {
  const { lead, occurrence } = card;
  const tag = happeningTypeTag(lead, occurrence.exact);
  const thumbnail = lead.image_url ?? defaultImageFor(lead);
  const oneLiner = oneLinerSummary(lead.summary);
  // The lead's own price stands in for the whole series (a "Parkrun ·
  // 3 locations" card has one price story, not three — same reason it
  // already borrows the lead's image/category/eligibility).
  const priceLabel = priceLabelForHappening(lead);

  return (
    <CardShell
      href={`/happening/${lead.id}`}
      onPointerDown={() => prefetchHappening(lead.id)}
      onNavigate={() => {
        setHappeningPreview(
          lead.id,
          happeningToPreview(lead, { priceLabel: savingBadgeLabel(lead), whenLabel: occurrenceRangeLabel(occurrence) })
        );
        trackCardOpened("series", lead.id, surface, position, lead.is_free);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col">
          <MetaRow
            icon={<CategoryDot category={lead.category} />}
            tag={scopeTag(tag)}
            when={occurrenceWhenLabel(occurrence)}
            trailing={`${card.locationCount} locations`}
            trailingClassName="font-semibold text-secondary"
          />
          <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{card.title}</h4>
        </div>
        <PriceTag label={priceLabel} />
      </div>

      {oneLiner ? <p className="line-clamp-2 text-body-sm leading-snug text-on-surface-variant">{oneLiner}</p> : null}

      <CardFooter
        save={
          <SaveButton
            subjectType="happening"
            subjectId={lead.id}
            interestHint={interestForHappeningCategory(lead.category)}
            compact
            className="-my-1 -mr-2"
          />
        }
      >
        <span className="shrink-0">{checkedLabel(lead.verified_at)}</span>
      </CardFooter>
    </CardShell>
  );
}

/**
 * A collapsed RECURRING card (lib/happenings/recurring.ts) — the same title
 * at the same venue on several dates, "Tue 29 Sep + 3 more dates" instead of
 * one row per date. Borrows every display field from `card.lead` (the
 * earliest member's own full card, happening OR event), exactly like
 * SeriesRow borrows from its lead; tapping it goes to the lead's own detail
 * page — that occurrence's actual booking link/details.
 */
function RecurringRow({ card, surface, position }: { card: RecurringCardData; surface?: FeedCardSurface; position?: number }) {
  const { lead, dates } = card;
  const extraCount = dates.length - 1;
  const dateLabel = `${shortDayLabel(dates[0])}${extraCount > 0 ? ` + ${extraCount} more date${extraCount === 1 ? "" : "s"}` : ""}`;
  const priceLabel = priceLabelForCard(lead);
  const venue = lead.kind === "happening" ? (lead.happening.venue_name ?? lead.happening.district) : lead.event.venue_name;
  const thumbnail =
    lead.kind === "happening"
      ? (lead.happening.image_url ?? defaultImageFor(lead.happening))
      : eventImageFor(lead.event);
  const oneLiner = lead.kind === "happening" ? oneLinerSummary(lead.happening.summary) : oneLinerSummary(lead.event.description);
  const href = lead.kind === "happening" ? `/happening/${lead.happening.id}` : `/event/${lead.event.id}`;

  return (
    <CardShell
      href={href}
      onPointerDown={() => (lead.kind === "happening" ? prefetchHappening(lead.happening.id) : prefetchEvent(lead.event.id))}
      onNavigate={() => {
        if (lead.kind === "happening") {
          setHappeningPreview(lead.happening.id, happeningToPreview(lead.happening, { priceLabel: savingBadgeLabel(lead.happening), whenLabel: dateLabel }));
          trackCardOpened("recurring", lead.happening.id, surface, position, lead.happening.is_free);
        } else {
          setEventPreview(lead.event.id, eventToPreview(lead.event, { priceLabel: formatEventPrice(lead.event), whenLabel: dateLabel }));
          trackEventCardOpened(lead.event.id, surface, position, lead.event.is_free);
        }
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col">
          <MetaRow
            icon={lead.kind === "happening" ? <CategoryDot category={lead.happening.category} /> : undefined}
            tag={lead.kind === "event" ? <TypeTag tag="EVENT" kind="event" /> : scopeTag(happeningTypeTag(lead.happening, lead.occurrence.exact))}
            when={dateLabel}
          />
          <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{card.title}</h4>
          {venue ? <p className="truncate text-label-sm font-medium text-on-surface-variant">{venue}</p> : null}
        </div>
        <PriceTag label={priceLabel} />
      </div>

      {oneLiner ? <p className="line-clamp-2 text-body-sm leading-snug text-on-surface-variant">{oneLiner}</p> : null}

      <CardFooter
        save={
          lead.kind === "happening" ? (
            <SaveButton
              subjectType="happening"
              subjectId={lead.happening.id}
              interestHint={interestForHappeningCategory(lead.happening.category)}
              compact
              className="-my-1 -mr-2"
            />
          ) : (
            <SaveButton subjectType="event" subjectId={lead.event.id} compact className="-my-1 -mr-2" />
          )
        }
      >
        {lead.kind === "happening" ? <span className="shrink-0">{checkedLabel(lead.happening.verified_at)}</span> : null}
      </CardFooter>
    </CardShell>
  );
}

function FestivalRow({ happening, surface, position }: { happening: Happening; surface?: FeedCardSurface; position?: number }) {
  const priceLabel = priceLabelForHappening(happening);
  const ctaHref = happening.booking_url ?? happening.source_url;
  const ctaLabel = happening.cta_label ?? "View Details";
  let sourceHost = happening.source_url;
  try {
    sourceHost = new URL(happening.source_url).hostname.replace(/^www\./, "");
  } catch {
    // source_url failed to parse as a URL — fall back to the raw string.
  }
  const bannerImage = happening.image_url ?? defaultImageFor(happening);

  return (
    <NavCard
      href={`/happening/${happening.id}`}
      ariaLabel={happening.title}
      onPointerDown={() => prefetchHappening(happening.id)}
      onNavigate={() => {
        setHappeningPreview(happening.id, happeningToPreview(happening, { priceLabel: savingBadgeLabel(happening) }));
        trackCardOpened("festival", happening.id, surface, position, happening.is_free);
      }}
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
        sizes="(min-width: 1024px) 560px, (max-width: 480px) 100vw, 480px"
        className="h-28 w-full object-cover"
      />
      <div className="flex flex-col gap-3 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-label-sm font-bold uppercase tracking-wide ${kindStyle("festival").className}`}>
              Festival
            </span>
            {happening.editorial_tag ? (
              <span className="text-label-sm font-bold text-secondary">{happening.editorial_tag}</span>
            ) : null}
          </div>
          <h4 className="pt-1 text-headline-md font-extrabold leading-tight text-on-surface">{happening.title}</h4>
        </div>
        <PriceTag label={priceLabel} variant="banner" />
      </div>

      {oneLinerSummary(happening.summary) ? (
        <p className="line-clamp-1 text-body-sm leading-relaxed text-on-surface-variant">
          {oneLinerSummary(happening.summary)}
        </p>
      ) : null}

      {/* Source domain + verified mark — PM decision 2026-09-26 (freshness
          badge) restored a subtle "Checked Nd ago" alongside the icon,
          which used to be icon-only with the full text left to the detail
          page's Provenance section. */}
      <div className="flex items-center justify-between rounded-lg bg-surface-container p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="public" size={17} className="text-accent" />
          <span className="truncate text-label-md font-bold text-on-surface">{sourceHost}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-label-sm font-medium text-on-surface-variant/70">
          <Icon name="verified" size={16} className="text-secondary" />
          {checkedLabel(happening.verified_at)}
        </div>
      </div>

      <a
        href={ctaHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          e.stopPropagation();
          trackOutboundClicked("happening", happening.id, ctaHref, "festival_cta");
        }}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary py-2.5 text-label-md font-bold text-on-primary shadow-sm transition-opacity hover:opacity-90 active:scale-[0.98]"
      >
        {ctaLabel}
        <Icon name="north_east" size={16} />
      </a>
      </div>
    </NavCard>
  );
}

function EventRow({ event, surface, position }: { event: EventItem; surface?: FeedCardSurface; position?: number }) {
  const eventDate = formatEventDate(event.starts_at);
  // Client-render only (see occurrenceWhenLabel) — safe to read the clock here.
  const eventLive = eventIsInProgress(event);
  const eventTime = formatEventTimeSpan(event.starts_at, event.ends_at);
  const priceLabel = priceLabelForEvent(event);
  // Own photo -> the linked venue's photo -> the category tile (event
  // categories are a subset of the happening ones: lib/events/image.ts).
  const thumbnail = eventImageFor(event);

  return (
    <CardShell
      href={`/event/${event.id}`}
      onPointerDown={() => prefetchEvent(event.id)}
      onNavigate={() => {
        setEventPreview(
          event.id,
          eventToPreview(event, { priceLabel: formatEventPrice(event), whenLabel: formatEventWhen(event.starts_at, event.ends_at) })
        );
        trackEventCardOpened(event.id, surface, position, event.is_free);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <Thumbnail src={thumbnail} alt="" />
        <div className="flex min-w-0 flex-1 flex-col">
          <MetaRow
            tag={<TypeTag tag="EVENT" kind="event" />}
            when={eventLive ? eventOnNowLabel(event.ends_at) : eventDate}
            trailing={event.venue_name}
          />
          <h4 className="line-clamp-2 text-headline-sm font-bold leading-snug text-on-surface">{event.name}</h4>
        </div>
        <PriceTag label={priceLabel} />
      </div>

      {oneLinerSummary(event.description) ? (
        <p className="line-clamp-2 text-body-sm leading-snug text-on-surface-variant">{oneLinerSummary(event.description)}</p>
      ) : null}

      <CardFooter save={<SaveButton subjectType="event" subjectId={event.id} compact className="-my-1 -mr-2" />}>
        <Icon name="schedule" size={14} className="shrink-0 text-secondary" />
        <span className="truncate">{eventTime}</span>
      </CardFooter>
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
export function FeedListCard({ card, surface, position }: FeedListCardProps) {
  // "New since your last visit" (lib/personalise/freshness.ts): badges the
  // card without moving it, so the list keeps its time order.
  const isNew = isNewSince(card, useNewSinceCutoff());
  return <CardIsNew.Provider value={isNew}>{feedRow(card, surface, position)}</CardIsNew.Provider>;
}

function feedRow(card: FeedCardData, surface: FeedCardSurface | undefined, position: number | undefined) {
  if (card.kind === "series") return <SeriesRow card={card} surface={surface} position={position} />;
  if (card.kind === "recurring") return <RecurringRow card={card} surface={surface} position={position} />;
  if (card.kind === "happening") {
    if (card.happening.kind === "festival") {
      return <FestivalRow happening={card.happening} surface={surface} position={position} />;
    }
    return <HappeningRow happening={card.happening} occurrence={card.occurrence} surface={surface} position={position} />;
  }
  return <EventRow event={card.event} surface={surface} position={position} />;
}

export default FeedListCard;
