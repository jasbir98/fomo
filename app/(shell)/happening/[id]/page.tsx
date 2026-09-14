"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { districtFromAddress } from "@/lib/city";
import { nextOccurrences, normalizeRecurrence } from "@/lib/happenings/occurrence";
import {
  ELIGIBILITY_FALLBACK,
  ELIGIBILITY_ICON,
  checkedLabel,
  happeningTypeTag,
  occurrenceRangeLabel,
  recurrencePatternLabel,
  savingBadgeLabel,
  shortStartTimeFromNote,
  stripLeadingPatternEcho,
} from "@/lib/happenings/format";
import { categoryDefaultImage } from "@/lib/happenings/category-style";
import type { HappeningResponse } from "@/app/api/happenings/[id]/route";
import type { Happening, Occurrence } from "@/lib/happenings/types";
import { Button, Icon, PageHeader, PhotoCarousel, ShareButton, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";
import { NotifyMeButton } from "@/components/happenings";
import { ensurePushSubscribed, pushReasonMessage } from "@/lib/push/client";

/** Same lat/lng-first, address-fallback shape as app/(shell)/event/[id]'s
 *  eventDirectionsUrl / lib/maps/links.ts's buildDirectionsUrl for Place —
 *  a Happening has neither a Place's google_place_id nor an Event's shape,
 *  so it gets its own tiny copy rather than forcing a shared helper's type
 *  to widen for one more caller. */
function happeningDirectionsUrl(h: Happening): string | null {
  if (h.lat != null && h.lng != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${h.lat},${h.lng}`;
  }
  const fallback = h.address ?? h.venue_name;
  if (!fallback) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fallback)}`;
}

async function fetchHappening(id: string): Promise<{ happening: Happening | null; siblings: Happening[] }> {
  const res = await fetch(`/api/happenings/${id}`);
  const json = (await res.json()) as HappeningResponse;
  return { happening: json.happening, siblings: json.siblings ?? [] };
}

/**
 * Happening detail page (built to the `fomo_happening_detail_mary_king_s_close_navy_blue`
 * mockup) — the destination for every happening card tap (hero, list card,
 * Free Any Time row, standing deal). Mirrors app/(shell)/place/[id] and
 * app/(shell)/event/[id]'s data-fetching shape (client component, `use()`
 * on the params promise, a loading/not-found pair) but reads through
 * GET /api/happenings/[id] instead of a direct client-side `lib/db` call,
 * because lib/db/happenings.ts is `server-only` — see that route's own doc
 * comment.
 */
export default function HappeningDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [happening, setHappening] = useState<Happening | null>(null);
  // Other members of the same series (lib/happenings/series.ts) — "" when
  // this happening isn't part of one. Drives the Locations section below.
  const [siblings, setSiblings] = useState<Happening[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [notifySubscribed, setNotifySubscribed] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHappening(id)
      .then(({ happening, siblings }) => {
        if (!cancelled) {
          setHappening(happening);
          setSiblings(siblings);
        }
      })
      .catch((err) => console.error("Failed to load happening", err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Whether this specific happening already has an on-sale alert for the
  // signed-in caller — fetches the caller's whole alert list rather than a
  // per-happening endpoint, matching Home's own GET /api/alerts read; this
  // page only has the one card to check membership for.
  useEffect(() => {
    if (!NOTIFY_ME_ENABLED) return;
    let cancelled = false;
    fetch("/api/alerts")
      .then((res) => res.json())
      .then((json: { happeningIds?: string[] }) => {
        if (!cancelled) setNotifySubscribed((json.happeningIds ?? []).includes(id));
      })
      .catch((err) => console.error("[happening] alerts fetch failed", err));
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function handleNotify() {
    setNotifyError(null);
    const result = await ensurePushSubscribed();
    if (!result.ok) {
      setNotifyError(pushReasonMessage(result.reason) ?? "Couldn't turn on alerts — try again.");
      return;
    }
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ happeningId: id }),
      });
      if (!res.ok) throw new Error(`POST /api/alerts ${res.status}`);
      setNotifySubscribed(true);
    } catch (err) {
      console.error("[happening] create alert failed", err);
      setNotifyError("Couldn't turn on alerts — try again.");
    }
  }

  async function handleCopyCode() {
    if (!happening?.promo_code) return;
    try {
      await navigator.clipboard.writeText(happening.promo_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard API unsupported/denied — the code is still visible for a
      // manual copy, same silent no-op as the hero card's own copy button.
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
      </div>
    );
  }

  if (!happening) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Deal" showBack />
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <Icon name="local_offer" size={32} />
          <p className="text-body-md">We couldn&rsquo;t find this deal.</p>
          <Link href="/" className="text-label-md font-medium text-secondary">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  const now = new Date();
  const upcoming: Occurrence[] = nextOccurrences(
    happening,
    now,
    new Date(now.getTime() + 366 * 86_400_000)
  );
  const primaryOccurrence = upcoming[0] ?? null;
  const rec = normalizeRecurrence(happening.recurrence);
  const isAlways = rec.type === "always";
  const pattern = recurrencePatternLabel(rec);
  const isSeries = siblings.length > 0;

  const tag = happeningTypeTag(happening, primaryOccurrence?.exact ?? false);
  const badge = savingBadgeLabel(happening);
  const district = happening.district ?? districtFromAddress(happening.address);
  const eligibilityLabel = ELIGIBILITY_FALLBACK[happening.eligibility];
  const directionsUrl = happeningDirectionsUrl(happening);
  const ctaHref = happening.booking_url ?? happening.source_url;
  const ctaLabel = happening.cta_label ?? "Claim Offer";
  const bookingNotOpenYet =
    happening.booking_opens_at != null && new Date(happening.booking_opens_at).getTime() > now.getTime();
  // App isn't deployed yet — window.location.origin is the correct base for
  // a shareable link until there's a real production host. For a series,
  // this shares the lead (currently-viewed) member's own page, same as
  // every other link on this page.
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/happening/${happening.id}` : "";
  const shareText = `${[
    happening.title,
    primaryOccurrence ? occurrenceRangeLabel(primaryOccurrence) : null,
    badge,
  ]
    .filter(Boolean)
    .join(" · ")} — found on Fomo`;

  // Hero image fallback chain (task: no more flat navy/ticket-icon block for
  // a happening with no image): the happening's own `image_url` (already
  // resolved server-side to fall back to its linked place's photo, if any —
  // see GET /api/happenings/[id]'s withPlaceImageFallback), else this
  // category's bundled default image (always resolves to something, so
  // heroPhotos is never empty). `imgError` (set by the hidden probe <img>
  // below) drops a real but broken remote URL down to the same default.
  const heroImageUrl =
    happening.image_url && !imgError ? happening.image_url : categoryDefaultImage(happening.category);
  const heroPhotos: CarouselPhoto[] = [{ url: heroImageUrl, alt: happening.title }];

  function openDirections() {
    if (directionsUrl) window.open(directionsUrl, "_blank", "noopener");
  }

  function openSource() {
    // Re-guarded even though the component already returned its
    // not-found state above for a null `happening` — TS doesn't carry that
    // narrowing into a nested function body (it could, in principle, run
    // after a future re-render), so this satisfies the checker rather than
    // reflecting a real runtime possibility.
    if (!happening) return;
    window.open(happening.source_url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        title={happening.title}
        showBack
        action={<ShareButton title={happening.title} text={shareText} url={shareUrl} />}
      />

      {/* Hero — heroPhotos always has exactly one entry (see heroImageUrl's
          fallback chain above), so this always renders a real photo, never
          the old flat navy/ticket-icon block. */}
      <section className="relative h-64 w-full overflow-hidden">
        <PhotoCarousel key={`${happening.id}-${heroImageUrl}`} photos={heroPhotos} />
        {/* Drop to the category default if the remote URL 404s/CORS-fails —
            <img> inside PhotoCarousel has no onError hook of its own, so this
            is a hidden probe image purely to catch that and flip state. Only
            probes a real `image_url`; the default image itself is a bundled
            local asset that can't fail the same way.
            Intentionally left as a bare <img>, not SmartImage: it never
            paints (className="hidden"), it exists solely to fire onError, and
            the same URL is already fetched — optimized — by PhotoCarousel's
            <SmartImage> above, so this stays a second, cheap, unoptimized
            request rather than duplicating a CDN-resized one. */}
        {happening.image_url && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={happening.image_url} alt="" className="hidden" onError={() => setImgError(true)} />
        ) : null}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
        <div className="absolute bottom-4 left-5 z-20 flex items-center gap-2">
          <StatusPill
            label={primaryOccurrence ? occurrenceRangeLabel(primaryOccurrence) : "Ongoing"}
            tone="info"
            icon="schedule"
          />
          {badge ? <StatusPill label={badge} tone="success" icon="local_offer" /> : null}
        </div>
      </section>

      <div className="flex flex-col gap-6 px-5">
        {/* Title & tags */}
        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary-container px-2.5 py-0.5 text-label-sm font-bold uppercase tracking-wider text-on-primary-container">
              {tag}
            </span>
            {happening.editorial_tag ? (
              <span className="text-label-sm font-bold text-secondary">{happening.editorial_tag}</span>
            ) : null}
          </div>
          <h1 className="text-headline-lg font-extrabold leading-snug text-on-surface">{happening.title}</h1>

          {happening.saving_label ? (
            <p className="mt-2 text-body-md font-semibold text-secondary">{happening.saving_label}</p>
          ) : null}
          {happening.summary ? (
            <p className="mt-2 text-body-md text-on-surface-variant">{happening.summary}</p>
          ) : null}

          {(happening.venue_name || happening.address) ? (
            <div className="mt-4 flex items-start gap-2.5 border-t border-outline-variant/30 pt-4 text-on-surface-variant">
              <Icon name="storefront" className="mt-0.5 shrink-0 text-primary" />
              <div className="flex min-w-0 flex-col">
                {happening.venue_name ? (
                  <p className="text-body-md font-medium text-on-surface">{happening.venue_name}</p>
                ) : null}
                {happening.address ? <p className="text-label-md text-on-surface-variant">{happening.address}</p> : null}
                {district ? <p className="text-label-sm text-secondary">{district}</p> : null}
              </div>
            </div>
          ) : null}
        </section>

        {/* Promo code */}
        {happening.promo_code ? (
          <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
            <div className="mb-2.5 flex items-center gap-2 text-primary">
              <Icon name="confirmation_number" size={19} />
              <h2 className="text-headline-sm text-primary">Claim Voucher Code</h2>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-container-low p-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">
                  Promo Code
                </span>
                <span className="truncate text-body-lg font-extrabold tracking-wider text-on-surface">
                  {happening.promo_code}
                </span>
              </div>
              <button
                type="button"
                onClick={handleCopyCode}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-label-sm font-bold text-on-primary transition-opacity hover:opacity-90 active:scale-95"
              >
                <Icon name={copied ? "check" : "content_copy"} size={16} />
                {copied ? "Copied!" : "Copy Code"}
              </button>
            </div>
            {happening.redemption_note ? (
              <p className="mt-2.5 flex items-start gap-1.5 text-body-sm leading-relaxed text-on-surface-variant">
                <Icon name="info" size={16} className="mt-0.5 shrink-0 text-secondary" />
                {happening.redemption_note}
              </p>
            ) : null}
          </section>
        ) : happening.redemption_note ? (
          <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
            <div className="mb-2 flex items-center gap-2 text-primary">
              <Icon name="how_to_reg" size={19} />
              <h2 className="text-headline-sm text-primary">How to redeem</h2>
            </div>
            <p className="text-body-md text-on-surface-variant">{happening.redemption_note}</p>
          </section>
        ) : null}

        {/* Eligibility */}
        {happening.eligibility !== "anyone" || happening.eligibility_note || happening.allowance_note ? (
          <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
            <div className="mb-3 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-fixed">
                <Icon name={ELIGIBILITY_ICON[happening.eligibility]} size={18} className="text-primary" />
              </div>
              <div>
                <h2 className="text-headline-sm leading-tight text-primary">Eligibility</h2>
                {eligibilityLabel ? (
                  <p className="text-label-sm font-bold uppercase tracking-wide text-secondary">{eligibilityLabel}</p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col gap-2.5 rounded-lg bg-surface-container p-3 text-body-sm text-on-surface-variant">
              {happening.eligibility_note ? (
                <div className="flex items-start gap-2">
                  <Icon name="badge" size={16} className="mt-0.5 shrink-0 text-secondary" />
                  <p className="leading-relaxed">{happening.eligibility_note}</p>
                </div>
              ) : null}
              {happening.allowance_note ? (
                <div
                  className={`flex items-start gap-2 ${
                    happening.eligibility_note ? "border-t border-hairline pt-2.5" : ""
                  }`}
                >
                  <Icon name="group" size={16} className="mt-0.5 shrink-0 text-secondary" />
                  <p className="leading-relaxed">{happening.allowance_note}</p>
                </div>
              ) : null}
              {!happening.eligibility_note && !happening.allowance_note ? (
                <p className="leading-relaxed">
                  {eligibilityLabel ? `Open to ${eligibilityLabel.toLowerCase()}.` : "Open to everyone."}
                </p>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* Sells fast — the source's own free-text sellout_note. Cards only
            ever show a short derived "Sells fast" badge for a high-risk item
            (BookEarlyCard) — this is where the actual sourced sentence
            lives, in full, per the card-density pass's "nothing lost on the
            detail page" rule. */}
        {happening.sellout_note ? (
          <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
            <div className="mb-2 flex items-center gap-2 text-primary">
              <Icon name="bolt" size={19} />
              <h2 className="text-headline-sm text-primary">Sells fast</h2>
            </div>
            <p className="text-body-md text-on-surface-variant">{happening.sellout_note}</p>
          </section>
        ) : null}

        {/* When */}
        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
          <h2 className="mb-3 flex items-center gap-2 text-headline-sm text-primary">
            <Icon name="calendar_month" size={19} />
            When
          </h2>
          {isSeries ? (
            // A plain template literal, not "Runs at {n} locations…" JSX text
            // — the mixed text/expression/text form silently lost the space
            // right after the number under this app's compiler (rendered
            // "3locations", no space) even though the source reads fine.
            // One expression container sidesteps that JSX whitespace quirk
            // entirely.
            <p className="text-body-md text-on-surface-variant">
              {`Runs at ${siblings.length + 1} locations across Edinburgh — see each one’s own days/times below.`}
            </p>
          ) : isAlways ? (
            (() => {
              // "Every day" is itself a pattern-shaped label — dedupe it
              // against time_note the same way as the recurring branch below
              // (a source note sometimes literally starts "Every day, …").
              const note = stripLeadingPatternEcho("Every day", happening.time_note);
              return (
                <div className="rounded-lg bg-surface-container p-3">
                  <p className="text-body-md font-bold text-on-surface">Every day</p>
                  {note ? (
                    <p className="mt-0.5 flex items-center gap-1 text-label-md text-on-surface-variant">
                      <Icon name="schedule" size={14} />
                      {note}
                    </p>
                  ) : null}
                </div>
              );
            })()
          ) : rec.type === "once" ? (
            // One-off: unchanged single-row rendering — there is no
            // "pattern" to a single date, so nothing to say once vs. repeat.
            upcoming.length > 0 ? (
              <div className="flex flex-col gap-2">
                {upcoming.slice(0, 5).map((occ, i) => (
                  <div
                    key={`${occ.dayDate}-${i}`}
                    className="flex items-center justify-between rounded-lg bg-surface-container p-3"
                  >
                    <div className="flex flex-col">
                      <span className="text-body-md font-bold text-on-surface">{occurrenceRangeLabel(occ)}</span>
                      {happening.time_note ? (
                        <span className="mt-0.5 flex items-center gap-1 text-label-md text-on-surface-variant">
                          <Icon name="schedule" size={14} />
                          {happening.time_note}
                        </span>
                      ) : null}
                    </div>
                    {i === 0 ? (
                      <span className="rounded-full bg-primary-fixed px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-primary">
                        Next
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-body-md text-on-surface-variant">
                No upcoming dates in the next year — this offer may have ended.
              </p>
            )
          ) : upcoming.length > 0 ? (
            // Recurring (weekly/annual/dates): the pattern + any shared note
            // is written ONCE here, then just the actual upcoming dates as
            // compact chips below — not the same line repeated per date. When
            // the note itself restates the pattern ("Every Saturday, 09:30
            // start…"), that leading echo is stripped so it's never printed
            // twice — see stripLeadingPatternEcho.
            (() => {
              const note = stripLeadingPatternEcho(pattern, happening.time_note);
              return (
                <div className="flex max-w-[480px] flex-col gap-3">
                  {pattern || note ? (
                    <div className="rounded-2xl bg-surface-container p-3">
                      {pattern ? <p className="text-body-md font-bold text-on-surface">{pattern}</p> : null}
                      {note ? (
                        <p className="mt-0.5 flex items-center gap-1 text-label-md text-on-surface-variant">
                          <Icon name="schedule" size={14} />
                          {note}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {upcoming.slice(0, 8).map((occ, i) => (
                      <span
                        key={`${occ.dayDate}-${i}`}
                        className={`rounded-full px-3 py-1.5 text-label-sm font-bold ${
                          i === 0 ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface"
                        }`}
                      >
                        {occurrenceRangeLabel(occ)}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()
          ) : (
            <p className="text-body-md text-on-surface-variant">
              No upcoming dates in the next year — this offer may have ended.
            </p>
          )}
        </section>

        {/* Locations — series only (lib/happenings/series.ts); one entry per
            member, each with its own schedule written once (never a shared
            description repeated), directions, and a link into that
            location's own page. Replaces the single-venue "Where" section
            below, which only makes sense for a non-series happening. */}
        {isSeries ? (
          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-headline-sm text-primary">Locations ({siblings.length + 1})</span>
            </div>
            <div className="flex max-w-[480px] flex-col gap-2.5">
              {[happening, ...siblings]
                .slice()
                .sort((a, b) => (a.venue_name ?? a.title).localeCompare(b.venue_name ?? b.title))
                .map((member) => {
                  const memberPattern = recurrencePatternLabel(normalizeRecurrence(member.recurrence));
                  // Compact row schedule: the pattern plus, at most, a short
                  // derived start time ("9:30am") — NEVER the member's full
                  // `time_note` (task: rows must not dump research-note
                  // prose). The full note still lives on that member's own
                  // detail page (the "When" section above handles it there,
                  // including its own pattern-echo dedupe).
                  const memberStartTime = shortStartTimeFromNote(member.time_note);
                  const memberDirections = happeningDirectionsUrl(member);
                  const isCurrent = member.id === happening.id;
                  return (
                    <div
                      key={member.id}
                      className={`rounded-2xl p-3 shadow-sm ${
                        isCurrent ? "bg-primary-fixed" : "bg-surface-container-lowest"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-col">
                          <p className="truncate text-body-md font-bold text-on-surface">
                            {member.venue_name ?? member.district ?? member.title}
                          </p>
                          {member.district ? <p className="text-label-sm text-secondary">{member.district}</p> : null}
                          {memberPattern || memberStartTime ? (
                            <p className="mt-1 flex items-center gap-1 text-label-md text-on-surface-variant">
                              <Icon name="schedule" size={14} />
                              {[memberPattern, memberStartTime].filter(Boolean).join(" · ")}
                            </p>
                          ) : null}
                        </div>
                        {isCurrent ? (
                          <span className="shrink-0 rounded-full bg-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-on-primary">
                            Viewing
                          </span>
                        ) : (
                          <div className="flex shrink-0 items-center gap-1.5">
                            {memberDirections ? (
                              <a
                                href={memberDirections}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-container text-primary shadow-xs"
                                aria-label={`Directions to ${member.venue_name ?? member.title}`}
                              >
                                <Icon name="near_me" size={16} />
                              </a>
                            ) : null}
                            <Link
                              href={`/happening/${member.id}`}
                              className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-container text-primary shadow-xs"
                              aria-label={`View ${member.title}`}
                            >
                              <Icon name="chevron_right" size={16} />
                            </Link>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </section>
        ) : null}

        {/* Where */}
        {!isSeries && directionsUrl ? (
          <section>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-headline-sm text-primary">Where</span>
            </div>
            <button
              type="button"
              onClick={openDirections}
              className="relative h-36 w-full overflow-hidden rounded-2xl bg-surface-container text-left shadow-level-1"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon name="map" size={56} className="text-outline-variant" />
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div className="min-w-0">
                  <p className="truncate text-label-md text-primary">
                    {happening.venue_name ?? happening.address ?? district ?? "Edinburgh"}
                  </p>
                  <p className="text-label-sm text-on-surface-variant">Tap to open directions</p>
                </div>
                <Icon name="open_in_new" className="shrink-0 text-primary" />
              </div>
            </button>
          </section>
        ) : null}

        {/* Provenance */}
        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary">
                <Icon name="check_circle" size={14} className="text-on-secondary" />
              </div>
              <span className="truncate text-body-sm font-bold text-on-surface">{happening.source_name}</span>
            </div>
            <span className="shrink-0 rounded-full bg-surface-container px-2.5 py-0.5 text-label-sm font-bold text-secondary">
              {checkedLabel(happening.verified_at)}
            </span>
          </div>
          <button
            type="button"
            onClick={openSource}
            className="mt-2.5 flex items-center gap-1 text-label-md font-bold text-primary hover:underline"
          >
            View official terms
            <Icon name="north_east" size={15} />
          </button>
        </section>
      </div>

      {/* Sticky bottom CTA */}
      <div className="sticky bottom-[64px] z-30 flex flex-col gap-2 border-t border-outline-variant/40 bg-surface-container-lowest/95 px-5 py-4 backdrop-blur-md shadow-[0_-4px_16px_rgba(3,22,50,0.08)]">
        <div className="flex items-center gap-2">
          <Button
            variant="orange"
            fullWidth
            trailingIcon="open_in_new"
            onClick={() => window.open(ctaHref, "_blank", "noopener,noreferrer")}
          >
            {ctaLabel}
          </Button>
          {NOTIFY_ME_ENABLED && bookingNotOpenYet ? (
            <NotifyMeButton subscribed={notifySubscribed} onNotify={() => void handleNotify()} />
          ) : null}
        </div>
        {notifyError ? <p className="text-label-sm text-error">{notifyError}</p> : null}
      </div>
    </div>
  );
}
