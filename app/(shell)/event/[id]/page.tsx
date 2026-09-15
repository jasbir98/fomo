"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { buildAskFomoHref } from "@/lib/chat-seed";
import { directionsUrlFor } from "@/lib/maps/links";
import { getEvent } from "@/lib/db";
import { isSaved, saveItem, unsaveItem } from "@/lib/db/saved";
import { formatEventPrice, formatEventWhen } from "@/lib/events/format";
import type { EventItem } from "@/lib/types";
import { Button, ErrorState, Icon, PageHeader, PhotoCarousel, ShareButton, StatusPill } from "@/components/ui";
import type { CarouselPhoto } from "@/components/ui";

/**
 * Event's own detail page (v1.1 W3) — mirrors app/(shell)/place/[id]/page.tsx's
 * data-fetching pattern, layout, and shared components (PageHeader,
 * PhotoCarousel, StatusPill), so every card that used to fetch-then-open a
 * sheet for an event now navigates here instead, exactly like a place card
 * navigates to /place/[id]. Fomo has no trips anymore — the secondary action
 * is a save/bookmark toggle (lib/db/saved.ts) instead of add-to-itinerary.
 */
export default function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const db = supabaseBrowserAuth();
  const pathname = usePathname();

  const [event, setEvent] = useState<EventItem | null>(null);
  const [loading, setLoading] = useState(true);
  // True only after a real fetch failure — `getEvent` (lib/db/events.ts)
  // throws on an actual Supabase/network error and only ever resolves to
  // `null` for a genuine "no such row", so this stays reserved for the
  // former and never fires for the latter.
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [saved, setSaved] = useState(false);
  const [savePending, setSavePending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getEvent(db, id)
      .then((data) => {
        if (!cancelled) {
          setEvent(data);
          setError(false);
        }
      })
      .catch((err) => {
        console.error("Failed to load event", err);
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [db, id, reloadTick]);

  useEffect(() => {
    let cancelled = false;
    isSaved(db, "event", id)
      .then((value) => {
        if (!cancelled) setSaved(value);
      })
      .catch((err) => console.error("Failed to check saved status", err));
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  async function handleToggleSave() {
    if (savePending) return;
    setSavePending(true);
    try {
      if (saved) {
        await unsaveItem(db, "event", id);
        setSaved(false);
      } else {
        await saveItem(db, { subject_type: "event", subject_id: id, note: null });
        setSaved(true);
      }
    } catch (err) {
      console.error("Failed to update saved status", err);
    } finally {
      setSavePending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status" aria-live="polite">
        <Icon name="auto_awesome" size={32} className="animate-pulse text-primary" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Event" showBack />
        <div className="px-5 py-16">
          <ErrorState
            title="Couldn't load this event"
            message="Check your connection and try again."
            onRetry={() => setReloadTick((t) => t + 1)}
          />
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Event" showBack />
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center text-on-surface-variant">
          <Icon name="event_busy" size={32} />
          <p className="text-body-md">We couldn&rsquo;t find this event.</p>
          <Link href="/whats-on" className="text-label-md font-medium text-secondary">
            Back to What&rsquo;s on
          </Link>
        </div>
      </div>
    );
  }

  const directionsUrl = directionsUrlFor({ lat: event.lat, lng: event.lng, query: event.address ?? event.venue_name ?? event.name });
  const price = formatEventPrice(event);
  // Event has a single image_url, no place_photos-style gallery — one-item
  // array reuses PhotoCarousel's existing placeholder-when-empty behavior
  // (see app/(shell)/place/[id]/page.tsx) rather than a bespoke hero block.
  const heroPhotos: CarouselPhoto[] = event.image_url ? [{ url: event.image_url, alt: event.name }] : [];
  // App isn't deployed yet — window.location.origin is the correct base for
  // a shareable link until there's a real production host.
  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}${pathname}` : "";
  const shareText = `${[event.name, formatEventWhen(event.starts_at, event.ends_at), price]
    .filter(Boolean)
    .join(" · ")} — found on Fomo`;

  return (
    <div className="flex flex-col gap-6 pb-6">
      <PageHeader
        title={event.name}
        showBack
        action={<ShareButton title={event.name} text={shareText} url={shareUrl} />}
      />

      {/* Hero */}
      <section className="relative h-64 w-full overflow-hidden">
        <PhotoCarousel key={event.id} photos={heroPhotos} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-gradient-to-t from-background/90 to-transparent" />
        <div className="absolute bottom-4 left-5 z-20">
          <StatusPill label={formatEventWhen(event.starts_at, event.ends_at)} tone="info" icon="schedule" />
        </div>
      </section>

      <div className="flex flex-col gap-6 px-5">
        {/* Description & stats */}
        <section className="rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            {event.category ? (
              <span className="rounded-full bg-surface-container-low px-3 py-1 text-label-sm capitalize text-on-surface-variant">
                {event.category}
              </span>
            ) : (
              <span />
            )}
            {price ? <span className="text-label-md font-semibold text-primary">{price}</span> : null}
          </div>
          {event.venue_name || event.city ? (
            <p className="mb-1 text-label-md font-medium text-secondary">
              {[event.venue_name, event.city].filter(Boolean).join(", ")}
            </p>
          ) : null}
          <p className="mb-4 text-body-md text-on-surface-variant">
            {event.description ??
              `${event.category ?? "Event"} at ${event.venue_name ?? event.city ?? "this venue"}.`}
          </p>
          <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4">
            <div className="flex items-center gap-3">
              <Icon name="schedule" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">When</p>
                <p className="text-label-md text-on-surface">
                  {formatEventWhen(event.starts_at, event.ends_at)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Icon name="location_on" className="text-primary" />
              <div>
                <p className="text-label-sm text-on-surface-variant">Venue</p>
                <p className="text-label-md text-on-surface">
                  {event.venue_name ?? event.address ?? "—"}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Mini map */}
        <section>
          <h2 className="mb-4 text-headline-sm text-primary">Location</h2>
          {directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="relative flex h-40 w-full overflow-hidden rounded-xl border border-outline-variant/40 bg-surface-container text-left"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon name="map" size={64} className="text-outline-variant" />
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div>
                  <p className="text-label-md text-primary">
                    {event.venue_name ?? event.address ?? event.name}
                  </p>
                  <p className="text-label-sm text-on-surface-variant">Tap to open directions</p>
                </div>
                <Icon name="open_in_new" className="text-primary" />
              </div>
            </a>
          ) : (
            <button
              type="button"
              disabled
              className="relative h-40 w-full overflow-hidden rounded-xl border border-outline-variant/40 bg-surface-container text-left disabled:pointer-events-none disabled:opacity-60"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <Icon name="map" size={64} className="text-outline-variant" />
              </div>
              <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between rounded-lg bg-white/90 px-3 py-2 backdrop-blur-md">
                <div>
                  <p className="text-label-md text-primary">
                    {event.venue_name ?? event.address ?? event.name}
                  </p>
                  <p className="text-label-sm text-on-surface-variant">Location unavailable</p>
                </div>
              </div>
            </button>
          )}
        </section>
      </div>

      {/* Sticky bottom actions */}
      <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 border-t border-outline-variant/40 bg-surface-container-lowest/95 px-5 py-4 backdrop-blur-md shadow-[0_-4px_16px_rgba(3,22,50,0.08)]">
        <div className="flex gap-3">
          {event.ticket_url ? (
            <a
              href={event.ticket_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-secondary-container px-4 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
            >
              <Icon name="confirmation_number" size={18} />
              Get tickets
            </a>
          ) : directionsUrl ? (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-medium text-on-secondary-container shadow-sm transition-all hover:opacity-90 active:opacity-80"
            >
              <Icon name="directions" size={18} />
              Get Directions
            </a>
          ) : (
            <Button
              variant="orange"
              fullWidth
              leadingIcon="directions"
              disabled
            >
              Get Directions
            </Button>
          )}
          <Link
            href={buildAskFomoHref({
              type: "event",
              id,
              name: event.name,
              coords: event.lat != null && event.lng != null ? { lat: event.lat, lng: event.lng } : null,
              returnTo: pathname,
            })}
            aria-label="Ask Fomo about this event"
            className="flex min-h-[48px] items-center justify-center rounded-xl border-[1.5px] border-primary px-4 text-primary transition-colors hover:bg-primary/5 active:bg-primary/10"
          >
            <Icon name="chat" size={20} />
          </Link>
          <Button
            variant={saved ? "danger" : "outline"}
            leadingIcon={saved ? "bookmark" : "bookmark_border"}
            onClick={handleToggleSave}
            disabled={savePending}
          >
            {saved ? "Saved" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
