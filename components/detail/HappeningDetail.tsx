"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { districtFromAddress } from "@/lib/city";
import { directionsUrlFor } from "@/lib/maps/links";
import { safeHttpUrl } from "@/lib/http/safe-url";
import { happeningHasEnded, nextOccurrences, normalizeRecurrence } from "@/lib/happenings/occurrence";
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
  weeklyEchoLabel,
} from "@/lib/happenings/format";
import { defaultImageFor } from "@/lib/happenings/category-style";
import { happeningCtaLabel } from "@/lib/happenings/cta";
import type { HappeningResponse } from "@/app/api/happenings/[id]/route";
import type { Happening, Occurrence } from "@/lib/happenings/types";
import { Button, ErrorState, FomoLoader, Icon, PhotoCarousel, SaveButton, ShareButton, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";
import { NOTIFY_ME_ENABLED } from "@/lib/happenings/book-early";
import { NotifyMeButton } from "@/components/happenings";
import { ensurePushSubscribed, pushReasonMessage } from "@/lib/push/client";
import { getHappeningPreview, takePrefetchedHappening, type HappeningPreview } from "@/lib/happenings/preview-cache";
import { interestForHappeningCategory } from "@/lib/personalise/interests";
import { track, trackOutboundClicked } from "@/lib/analytics/track";
import {
  ASIDE_CARD_CLASS,
  DETAIL_CONTENT_CLASS,
  DETAIL_CTA_BAR_CLASS,
  DETAIL_HERO_CLASS,
  DetailAside,
  DetailTopBar,
  detailGridClass,
  type DetailProps,
} from "./shared";

/** The preview cache never changes under a mounted page; nothing to subscribe to. */
const noopSubscribe = () => () => {};

// Throws on a network error or non-2xx status (GET /api/happenings/[id]
// returns 401/500 for those — see that route's own doc comment) so the
// caller can tell "the request failed" apart from a genuine 404, which the
// route signals differently: 200 with `happening: null`.
/**
 * Google Calendar "add event" link for the next occurrence. Timed rows get
 * their real start (and end, or +2h); date-only rows (stored at 00:00 UTC)
 * become all-day entries.
 */
function googleCalendarUrl(h: Happening, occ: Occurrence): string {
  const compactDay = (dayDate: string) => dayDate.replace(/-/g, "");
  const nextDay = (dayDate: string) => {
    const [y, m, d] = dayDate.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  };
  const start = occ.startsAt ? new Date(occ.startsAt) : null;
  const timed = start != null && occ.exact && (start.getUTCHours() !== 0 || start.getUTCMinutes() !== 0);
  let dates: string;
  if (timed && start) {
    const end = occ.endsAt ? new Date(occ.endsAt) : new Date(start.getTime() + 2 * 3_600_000);
    const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    dates = `${stamp(start)}/${stamp(end)}`;
  } else {
    dates = `${compactDay(occ.dayDate)}/${compactDay(nextDay(occ.lastDayDate))}`;
  }
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: h.title,
    dates,
    details: [h.summary, h.booking_url ?? h.source_url].filter(Boolean).join("\n\n"),
    location: [h.venue_name, h.address].filter(Boolean).join(", ") || "Edinburgh",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Reuses a card's early prefetch (started at pointerdown/touchstart, see
// lib/happenings/preview-cache.ts) when one is in flight for this id,
// instead of firing a second, redundant GET — the whole point of starting
// that fetch before the click even lands.
async function fetchHappening(id: string): Promise<{ happening: Happening | null; siblings: Happening[] }> {
  const prefetched = takePrefetchedHappening(id);
  const json: HappeningResponse = prefetched
    ? await prefetched
    : await (async () => {
        const res = await fetch(`/api/happenings/${id}`);
        if (!res.ok) throw new Error(`GET /api/happenings/${id} ${res.status}`);
        return (await res.json()) as HappeningResponse;
      })();
  return { happening: json.happening, siblings: json.siblings ?? [] };
}

/**
 * Happening detail (built to the `fomo_happening_detail_mary_king_s_close_navy_blue`
 * mockup) — the destination for every happening card tap (hero, list card,
 * Free Any Time row, standing deal). Mirrors app/(shell)/place/[id] and
 * app/(shell)/event/[id]'s data-fetching shape (client component, `use()`
 * on the params promise, a loading/not-found pair) but reads through
 * GET /api/happenings/[id] instead of a direct client-side `lib/db` call,
 * because lib/db/happenings.ts is `server-only` — see that route's own doc
 * comment.
 */
export function HappeningDetail({ id, presentation = "page" }: DetailProps) {

  const [happening, setHappening] = useState<Happening | null>(null);
  // Other members of the same series (lib/happenings/series.ts) — "" when
  // this happening isn't part of one. Drives the Locations section below.
  const [siblings, setSiblings] = useState<Happening[]>([]);
  const [loading, setLoading] = useState(true);
  // True only after a real fetch failure (network error or non-2xx) — a
  // genuine 404 (the route's own `happening: null`) never sets this, so the
  // "We couldn't find this deal" copy stays reserved for an actually-missing
  // happening instead of also covering a dropped connection.
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [notifySubscribed, setNotifySubscribed] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  // A card's click-time write to the preview cache, if there is one — powers
  // the instant hero while `loading` is still true; `null` means this page was
  // opened directly (a shared link, a fresh reload) with nothing to show yet.
  // Read through useSyncExternalStore with a null server snapshot, not
  // useMemo: the cache falls back to sessionStorage, which the server can't
  // see, so a plain render-time read made a reload of an already-visited
  // detail page hydrate a different header than the server sent (a
  // hydration mismatch). During hydration React renders the server snapshot
  // (null, matching the HTML) and then re-renders with the cached preview;
  // on a client-side navigation there's no hydration, so the preview still
  // paints on the very first render. Keyed on `id` via the snapshot closure.
  const preview = useSyncExternalStore<HappeningPreview | null>(noopSubscribe, () => getHappeningPreview(id), () => null);

  useEffect(() => {
    let cancelled = false;
    fetchHappening(id)
      .then(({ happening, siblings }) => {
        if (!cancelled) {
          setHappening(happening);
          setSiblings(siblings);
          setError(false);
        }
      })
      .catch((err) => {
        console.error("Failed to load happening", err);
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadTick]);

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
      setNotifyError(pushReasonMessage(result.reason) ?? "Couldn't turn on alerts. Try again.");
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
      setNotifyError("Couldn't turn on alerts. Try again.");
    }
  }

  async function handleUnnotify() {
    setNotifyError(null);
    try {
      const res = await fetch("/api/alerts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ happeningId: id }),
      });
      if (!res.ok) throw new Error(`DELETE /api/alerts ${res.status}`);
      setNotifySubscribed(false);
    } catch (err) {
      console.error("[happening] remove alert failed", err);
      setNotifyError("Couldn't turn off the alert. Try again.");
    }
  }

  async function handleCopyCode() {
    if (!happening?.promo_code) return;
    try {
      await navigator.clipboard.writeText(happening.promo_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard API unsupported/denied — say so, the code is selectable.
      setCopyFailed(true);
    }
  }

  if (loading) {
    // No preview at all (a shared link opened directly, a fresh reload) —
    // nothing to paint yet, so the full-page mascot loader.
    if (!preview) {
      return (
        <>
          {presentation === "modal" ? <DetailTopBar presentation="modal" /> : null}
          <div className={`flex items-center justify-center ${presentation === "modal" ? "min-h-[360px]" : "min-h-dvh"}`}>
            <FomoLoader />
          </div>
        </>
      );
    }
    // A card already handed us the hero fields (see lib/happenings/
    // preview-cache.ts) — paint them immediately instead of a blank
    // full-page loader, with skeleton rows standing in for everything the
    // preview doesn't have (promo code, eligibility, full "When" section,
    // provenance, the CTA — all of it needs the real happening row).
    const previewImage = preview.imageUrl ?? defaultImageFor({ category: preview.category, title: preview.title, venue_name: preview.venueName });
    return (
      <div className="flex flex-col gap-4 pb-6">
        <DetailTopBar presentation={presentation} title={preview.title} />
        <div className={detailGridClass(presentation)}>
        <section className={DETAIL_HERO_CLASS}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewImage} alt="" className="h-full w-full object-cover" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
          <div className="absolute bottom-4 left-4 right-4 z-20 flex flex-wrap items-center gap-2">
            {preview.whenLabel ? <StatusPill label={preview.whenLabel} tone="info" icon="schedule" /> : null}
            {preview.priceLabel ? <StatusPill label={preview.priceLabel} tone="success" icon="local_offer" /> : null}
          </div>
        </section>
        <div className={DETAIL_CONTENT_CLASS}>
          <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
            <h1 className="text-headline-lg font-extrabold leading-snug text-on-surface">{preview.title}</h1>
            {preview.venueName || preview.district ? (
              <div className="mt-4 flex items-start gap-2.5 border-t border-outline-variant/30 pt-4 text-on-surface-variant">
                <Icon name="storefront" className="mt-0.5 shrink-0 text-primary" />
                <div className="flex min-w-0 flex-col">
                  {preview.venueName ? (
                    <p className="text-body-md font-medium text-on-surface">{preview.venueName}</p>
                  ) : null}
                  {preview.district ? <p className="text-label-sm text-secondary">{preview.district}</p> : null}
                </div>
              </div>
            ) : null}
          </section>
          <div className="flex flex-col gap-3" role="status" aria-live="polite">
            <span className="sr-only">Loading the rest of this deal…</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-surface-container" />
            ))}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="hidden h-56 animate-pulse rounded-2xl bg-surface-container lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1 lg:block"
        />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <DetailTopBar presentation={presentation} title="Deal" />
        <div className="px-4 py-16">
          <ErrorState
            title="Couldn't load this deal"
            message="Check your connection and try again."
            onRetry={() => setReloadTick((t) => t + 1)}
          />
        </div>
      </div>
    );
  }

  if (!happening) {
    return (
      <div className="flex flex-col gap-4">
        <DetailTopBar presentation={presentation} title="Deal" />
        <div className="flex flex-col items-center gap-3 px-4 py-16 text-center text-on-surface-variant">
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
  // Date chips drop the year when it's the current one ("Thu 1 Oct").
  const thisYear = String(now.getFullYear());
  const chipLabel = (occ: Occurrence) => occurrenceRangeLabel(occ).replace(new RegExp(` ${thisYear}$`), "");

  const tag = happeningTypeTag(happening, primaryOccurrence?.exact ?? false);
  const badge = savingBadgeLabel(happening);
  const district = happening.district ?? districtFromAddress(happening.address);
  const eligibilityLabel = ELIGIBILITY_FALLBACK[happening.eligibility];
  // No summary AND nothing else explanatory (saving label, redemption or
  // eligibility note): fall back to one plain line built only from fields the
  // row itself holds. Null when there is nothing beyond the kind word.
  const KIND_FALLBACK_LABEL: Record<Happening["kind"], string> = {
    deal: "A deal",
    free_access: "Free access",
    festival: "A festival event",
    activity: "An activity",
    tour: "A tour",
    event: "An event",
  };
  const factualFallback =
    !happening.summary && !happening.saving_label && !happening.redemption_note && !happening.eligibility_note && (happening.venue_name || eligibilityLabel)
      ? `${[
          KIND_FALLBACK_LABEL[happening.kind] ?? "An event",
          happening.venue_name ? `at ${happening.venue_name}` : null,
          eligibilityLabel ? `for ${eligibilityLabel.toLowerCase()}` : null,
        ]
          .filter(Boolean)
          .join(" ")}.`
      : null;
  const directionsUrl = directionsUrlFor({ lat: happening.lat, lng: happening.lng, query: happening.address ?? happening.venue_name });
  // booking_url/source_url come from scrapers/APIs — validate before ever
  // handing them to window.open/location (see lib/http/safe-url.ts). A
  // rejected value hides the CTA rather than navigating somewhere unsafe.
  const ctaHref = safeHttpUrl(happening.booking_url ?? happening.source_url);
  const safeSourceUrl = safeHttpUrl(happening.source_url);
  // Say what the button actually does — "Claim Offer" on a free museum was wrong.
  const ctaLabel = happeningCtaLabel(happening);
  // Date-aware, not just status: a row still marked "live" whose window has
  // passed (e.g. a one-off weekend that's over) must show the ended banner too.
  const ended = happening.status !== "live" || happeningHasEnded(happening, new Date());
  // Only for things that happen on a day or a few — a months-long exhibition
  // as one calendar block helps nobody.
  const spanDays = primaryOccurrence
    ? (Date.parse(primaryOccurrence.lastDayDate) - Date.parse(primaryOccurrence.dayDate)) / 86_400_000
    : Infinity;
  // Primary link: the .ics route (app/api/happenings/[id]/ics/route.ts) —
  // a plain <a href>, no target="_blank", so iOS Safari opens the native
  // Add Event sheet directly instead of a new tab. Google Calendar's own
  // link stays as a secondary option for anyone who specifically wants that
  // app (task B).
  const icsUrl =
    primaryOccurrence && !isAlways && !isSeries && !ended && spanDays <= 3
      ? `/api/happenings/${happening.id}/ics`
      : null;
  const calendarUrl =
    primaryOccurrence && !isAlways && !isSeries && !ended && spanDays <= 3
      ? googleCalendarUrl(happening, primaryOccurrence)
      : null;
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
    .join(" · ")} · via Fomo`;

  // Hero image fallback chain (task: no more flat navy/ticket-icon block for
  // a happening with no image): the happening's own `image_url` (already
  // resolved server-side to fall back to its linked place's photo, if any —
  // see GET /api/happenings/[id]'s withPlaceImageFallback), else a keyword-themed
  // (else this category's) bundled default image (always resolves to something, so
  // heroPhotos is never empty). `imgError` (set by the hidden probe <img>
  // below) drops a real but broken remote URL down to the same default.
  const heroImageUrl =
    happening.image_url && !imgError ? happening.image_url : defaultImageFor(happening);
  const heroPhotos: CarouselPhoto[] = [{ url: heroImageUrl, alt: happening.title }];

  function openSource() {
    // Re-guarded even though the component already returned its
    // not-found state above for a null `happening` — TS doesn't carry that
    // narrowing into a nested function body (it could, in principle, run
    // after a future re-render), so this satisfies the checker rather than
    // reflecting a real runtime possibility.
    if (!happening || !safeSourceUrl) return;
    trackOutboundClicked("happening", happening.id, safeSourceUrl, "source");
    window.open(safeSourceUrl, "_blank", "noopener,noreferrer");
  }

  // The When and Where cards render twice: once in the left column (hidden
  // at lg) and once in the desktop aside (hidden below lg). They hold no
  // effects or mount-time tracking — only click-time `track` calls — so the
  // duplicate costs nothing but DOM.
  const whenCard = (cls: string) => (
    <section className={`rounded-2xl bg-surface-container-lowest p-5 shadow-level-1 ${cls}`}>
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
          {`Runs at ${siblings.length + 1} locations across Edinburgh. See each one’s own days/times below.`}
        </p>
      ) : isAlways ? (
        (() => {
          // "Every day" is itself a pattern-shaped label — dedupe it
          // against time_note the same way as the recurring branch below
          // (a source note sometimes literally starts "Every day, …").
          const note = stripLeadingPatternEcho("Every day", happening.time_note);
          return (
            <div className="rounded-lg bg-surface-container p-3">
              <p className="text-body-md font-semibold text-on-surface">Every day</p>
              {note ? (
                <p className="mt-1 flex items-start gap-1.5 text-body-sm text-on-surface-variant">
                  <Icon name="schedule" size={14} className="mt-0.5 shrink-0" />
                  <span className="min-w-0">{note}</span>
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
                    <span className="mt-1 flex items-start gap-1.5 text-body-sm text-on-surface-variant">
                      <Icon name="schedule" size={14} className="mt-0.5 shrink-0" />
                      <span className="min-w-0">{happening.time_note}</span>
                    </span>
                  ) : null}
                </div>
                {i === 0 ? (
                  <span className="rounded-full bg-primary-fixed px-2.5 py-1 text-label-sm font-bold uppercase tracking-wide text-primary">
                    Next
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-body-md text-on-surface-variant">
            No upcoming dates in the next year. This offer may have ended.
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
          const note = stripLeadingPatternEcho(weeklyEchoLabel(rec), stripLeadingPatternEcho(pattern, happening.time_note));
          return (
            <div className="flex max-w-[480px] flex-col gap-3 lg:max-w-none">
              {pattern || note ? (
                <div className="rounded-2xl bg-surface-container p-3">
                  {pattern ? <p className="text-body-md font-semibold text-on-surface">{pattern}</p> : null}
                  {note ? (
                    <p className="mt-1 flex items-start gap-1.5 text-body-sm text-on-surface-variant">
                      <Icon name="schedule" size={14} className="mt-0.5 shrink-0" />
                      <span className="min-w-0">{note}</span>
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {upcoming.slice(0, 8).map((occ, i) => (
                  <span
                    key={`${occ.dayDate}-${i}`}
                    className={`rounded-full px-3 py-1.5 text-label-md font-semibold ${
                      i === 0 ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface"
                    }`}
                  >
                    {chipLabel(occ)}
                  </span>
                ))}
              </div>
            </div>
          );
        })()
      ) : (
        <p className="text-body-md text-on-surface-variant">
          No upcoming dates in the next year. This offer may have ended.
        </p>
      )}
      {icsUrl ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Primary: the .ics route, plain <a href> with no
              target="_blank" — that's what makes iOS Safari open the
              native Add Event sheet instead of just downloading the
              file to a new tab. Works the same on Android (opens the
              device's calendar app's own import). */}
          <a
            href={icsUrl}
            onClick={() => track("calendar_added", { type: "ics", kind: "happening" })}
            className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline-strong px-3 text-label-md font-semibold text-primary hover:bg-surface-container"
          >
            <Icon name="event_available" size={16} />
            Add to calendar
          </a>
          {/* Secondary: unchanged Google Calendar web link, for anyone
              who specifically wants that app over the device's native
              one. */}
          {calendarUrl ? (
            <a
              href={calendarUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track("calendar_added", { type: "google", kind: "happening" })}
              className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline-strong px-3 text-label-md font-semibold text-on-surface-variant hover:bg-surface-container"
            >
              <Icon name="open_in_new" size={16} />
              Google Calendar
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
  const whereCard = (cls: string, href: string) => (
    <section className={cls}>
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-headline-sm text-primary">Where</span>
            </div>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackOutboundClicked("happening", happening.id, href, "directions")}
              className="flex w-full items-center gap-3 rounded-2xl bg-surface-container-lowest p-3.5 text-left shadow-level-1"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-fixed text-primary">
                <Icon name="near_me" size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-label-md font-bold text-on-surface">
                  {happening.venue_name ?? happening.address ?? district ?? "Edinburgh"}
                </p>
                <p className="text-label-sm text-on-surface-variant">Get directions</p>
              </div>
              <Icon name="open_in_new" className="shrink-0 text-primary" />
            </a>
          </section>
  );

  return (
    <div className="flex flex-col gap-4 pb-6">
      <DetailTopBar
        presentation={presentation}
        title={happening.title}
        action={
          <div className="flex items-center gap-1">
            <SaveButton
              subjectType="happening"
              subjectId={happening.id}
              interestHint={interestForHappeningCategory(happening.category)}
            />
            <ShareButton
              title={happening.title}
              text={shareText}
              url={shareUrl}
              interestHint={interestForHappeningCategory(happening.category)}
              kind="happening"
            />
          </div>
        }
      />

      <div className={detailGridClass(presentation)}>
      {/* Hero — heroPhotos always has exactly one entry (see heroImageUrl's
          fallback chain above), so this always renders a real photo, never
          the old flat navy/ticket-icon block. */}
      <section className={DETAIL_HERO_CLASS}>
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
        <div className="absolute bottom-4 left-4 right-4 z-20 flex flex-wrap items-center gap-2">
          <StatusPill
            label={primaryOccurrence ? occurrenceRangeLabel(primaryOccurrence) : "Ongoing"}
            tone="info"
            icon="schedule"
          />
          {badge ? <StatusPill label={badge} tone="success" icon="local_offer" /> : null}
        </div>
      </section>

      <div className={DETAIL_CONTENT_CLASS}>
        {ended ? (
          <div role="status" className="flex items-start gap-2.5 rounded-2xl bg-error-container/40 p-3.5 text-on-surface">
            <Icon name="event_busy" size={20} className="mt-0.5 shrink-0 text-error" />
            <p className="text-body-md">
              <span className="font-bold">This has ended.</span> It&apos;s no longer running. Check the official
              page before you go.
            </p>
          </div>
        ) : null}

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
          ) : factualFallback ? (
            <p className="mt-2 text-body-md text-on-surface-variant/80">{factualFallback}</p>
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
              <h2 className="text-headline-sm text-primary">Promo code</h2>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-container-low p-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">
                  Code
                </span>
                <span className="select-all truncate text-body-lg font-extrabold tracking-wider text-on-surface">
                  {happening.promo_code}
                </span>
              </div>
              <button
                type="button"
                onClick={handleCopyCode}
                className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-label-sm font-bold text-on-primary transition-opacity hover:opacity-90 active:scale-95"
              >
                <Icon name={copied ? "check" : "content_copy"} size={16} />
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {copyFailed ? (
              <p className="mt-2 text-label-sm text-on-surface-variant">
                Couldn&apos;t copy automatically. Press and hold the code to copy it.
              </p>
            ) : null}
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

        {whenCard("lg:hidden")}

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
            <div className="flex max-w-[480px] flex-col gap-2.5 lg:max-w-none lg:grid lg:grid-cols-2 lg:gap-3">
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
                  const memberDirections = directionsUrlFor({ lat: member.lat, lng: member.lng, query: member.address ?? member.venue_name });
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
                          <span className="shrink-0 rounded-full bg-primary px-2.5 py-1 text-label-sm font-bold uppercase tracking-wide text-on-primary">
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

        {!isSeries && directionsUrl ? whereCard("lg:hidden", directionsUrl) : null}

        {/* Provenance */}
        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-level-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary">
                <Icon name="check_circle" size={14} className="text-on-secondary" />
              </div>
              <span className="truncate text-body-sm font-bold text-on-surface">Source: {happening.source_name}</span>
            </div>
            <span className="shrink-0 rounded-full bg-surface-container px-2.5 py-0.5 text-label-sm font-bold text-secondary">
              {checkedLabel(happening.verified_at)}
            </span>
          </div>
          {safeSourceUrl ? (
            <button
              type="button"
              onClick={openSource}
              className="mt-2.5 flex items-center gap-1 text-label-md font-bold text-primary hover:underline"
            >
              View official terms
              <Icon name="north_east" size={15} />
            </button>
          ) : null}
        </section>
      </div>

      {/* Aside. Below lg this is `display: contents`: the CTA bar is a plain
          sticky-bottom flex child of the page exactly as before, and the
          `hidden lg:block` cards stay hidden. At lg it is the sticky right
          column — summary, the same single CTA group (static there), When,
          Where. */}
      <DetailAside presentation={presentation}>
      <section className={ASIDE_CARD_CLASS}>
        <div className="flex flex-col gap-2">
          {badge ? <p className="text-headline-md font-extrabold text-primary">{badge}</p> : null}
          {happening.saving_label ? (
            <p className="text-body-md font-semibold text-secondary">{happening.saving_label}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={primaryOccurrence ? occurrenceRangeLabel(primaryOccurrence) : "Ongoing"}
              tone="info"
              icon="schedule"
            />
            {eligibilityLabel ? <StatusPill label={eligibilityLabel} tone="neutral" icon="badge" /> : null}
          </div>
        </div>
      </section>

      <div className={DETAIL_CTA_BAR_CLASS}>
        <div className="flex items-center gap-2">
          {ctaHref ? (
            <Button
              variant="orange"
              fullWidth
              trailingIcon="open_in_new"
              onClick={() => {
                trackOutboundClicked("happening", happening.id, ctaHref, "primary");
                window.open(ctaHref, "_blank", "noopener,noreferrer");
              }}
            >
              {ctaLabel}
            </Button>
          ) : null}
          {NOTIFY_ME_ENABLED && bookingNotOpenYet ? (
            <NotifyMeButton
              subscribed={notifySubscribed}
              onNotify={() => void handleNotify()}
              onUnnotify={() => void handleUnnotify()}
            />
          ) : null}
        </div>
        {notifyError ? <p className="text-label-sm text-error">{notifyError}</p> : null}
      </div>

      {whenCard("hidden lg:block")}
      {!isSeries && directionsUrl ? whereCard("hidden lg:block", directionsUrl) : null}
      </DetailAside>
      </div>
    </div>
  );
}
