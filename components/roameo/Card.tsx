"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import { EventDetailSheet } from "@/components/events";
import { buildAskRoameoHref } from "@/lib/chat-seed";
import { createItem } from "@/lib/db/items";
import { recordCardSignal } from "@/lib/db/signals";
import { saveItem, unsaveItem } from "@/lib/db/saved";
import { getEvent } from "@/lib/db/events";
import { describeSupabaseError } from "@/lib/db/errors";
import type { Candidate, CardKind } from "@/lib/now/types";
import type { CardSubjectType, EventItem } from "@/lib/types";

export type CardVariant = "hero" | "tile" | "grid";

export interface RoameoCardProps {
  candidate: Candidate;
  variant: CardVariant;
  deviceId: string;
  tripId: string | null;
  /** Hero only: the "Nah" ghost action. Omit to hide it. */
  onDismiss?: () => void;
  /** Overrides the default handler for a primary action kind ("swap" needs Plan's own swap logic; "location" needs Home's permission-request flow). Receives the action's `kind` so one override can branch on it. */
  onPrimary?: (kind: CardKind) => void;
  className?: string;
}

const CATEGORY_BY_SUBJECT: Record<CardSubjectType, string> = {
  place: "activity",
  event: "activity",
  experience: "booking",
  itinerary_item: "activity",
  reel: "activity",
};

function todayISODate(iso: string): string {
  return iso.slice(0, 10);
}

function directionsUrl(coords: { lat: number; lng: number }): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}`;
}

/**
 * One card, one action row, rendered identically everywhere — Home rail,
 * Plan gaps, chip discover grids, Reels. The action row's job is to be the
 * thing that stitches the six features together (plan-v1-home-pivot.md §8),
 * so it deliberately does NOT vary its actions by surface, only its size
 * (`tile` compacts to icon-only for the horizontal rail).
 */
export function RoameoCard({
  candidate,
  variant,
  deviceId,
  tripId,
  onDismiss,
  onPrimary,
  className = "",
}: RoameoCardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [added, setAdded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [eventSheetOpen, setEventSheetOpen] = useState(false);
  const [eventDetail, setEventDetail] = useState<EventItem | null>(null);
  const [eventLoading, setEventLoading] = useState(false);

  const askHref = buildAskRoameoHref({
    type: candidate.subject.type,
    id: candidate.subject.id,
    name: candidate.subjectName,
    coords: candidate.coords,
    returnTo: pathname,
  });

  function signal(action: "opened" | "saved" | "planned" | "dismissed") {
    void recordCardSignal({
      device_id: deviceId,
      trip_id: tripId,
      card_type: candidate.generator,
      subject_type: candidate.subject.type,
      subject_id: candidate.subject.id,
      action,
    });
  }

  async function handleAdd() {
    if (!tripId || added || busy) return;
    setBusy(true);
    try {
      await createItem(deviceId, {
        trip_id: tripId,
        day_date: todayISODate(candidate.validFrom),
        time_label: new Date(candidate.validFrom).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        }),
        starts_at: candidate.validFrom,
        duration_minutes: null,
        category: CATEGORY_BY_SUBJECT[candidate.subject.type],
        title: candidate.subjectName,
        location: candidate.detail || null,
        weather_alert: false,
        color_tag: null,
        place_id: candidate.subject.type === "place" ? candidate.subject.id : null,
        experience_id: candidate.subject.type === "experience" ? candidate.subject.id : null,
      });
      setAdded(true);
      signal("planned");
    } catch (err) {
      console.error(`[roameo] add-to-plan failed ${describeSupabaseError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (busy) return;
    setBusy(true);
    try {
      if (saved) {
        await unsaveItem(deviceId, candidate.subject.type, candidate.subject.id);
        setSaved(false);
      } else {
        await saveItem({
          device_id: deviceId,
          trip_id: tripId,
          subject_type: candidate.subject.type,
          subject_id: candidate.subject.id,
          note: null,
        });
        setSaved(true);
        signal("saved");
      }
    } catch (err) {
      console.error(`[roameo] save toggle failed ${describeSupabaseError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Tapping the card body (photo/why/headline/detail — everything except
  // the action row) opens the subject's own detail surface. Every subject
  // type except "event" has a real route; events have no `/event/[id]`
  // page (the rest of the app already shows them in a BottomSheet, see
  // app/(shell)/events/page.tsx), so that one case fetches-then-opens the
  // shared EventDetailSheet instead of navigating.
  const detailHref =
    candidate.subject.type === "place"
      ? `/place/${candidate.subject.id}`
      : candidate.subject.type === "experience"
        ? `/experience/${candidate.subject.id}`
        : candidate.subject.type === "itinerary_item"
          ? `/plan/item/${candidate.subject.id}`
          : candidate.subject.type === "reel"
            ? `/social/${candidate.subject.id}`
            : null;

  async function handleOpenDetails() {
    signal("opened");
    if (candidate.subject.type === "event") {
      if (eventLoading) return;
      if (eventDetail && eventDetail.id === candidate.subject.id) {
        setEventSheetOpen(true);
        return;
      }
      setEventLoading(true);
      try {
        const event = await getEvent(candidate.subject.id);
        setEventDetail(event);
        if (event) setEventSheetOpen(true);
      } catch (err) {
        console.error(`[roameo] event detail lookup failed ${describeSupabaseError(err)}`);
      } finally {
        setEventLoading(false);
      }
      return;
    }
    if (detailHref) router.push(detailHref);
  }

  function handlePrimary() {
    const kind = candidate.primaryAction.kind;
    if (onPrimary) {
      onPrimary(kind);
      return;
    }
    if (kind === "add") void handleAdd();
    else if (kind === "directions" && candidate.coords) {
      window.open(directionsUrl(candidate.coords), "_blank", "noopener");
    }
    // "swap"/"location"/"book"/"tell"/"watch" without an override render as
    // navigable links below (book) or fall through to Ask Roameo (tell) —
    // "swap"/"location" need a caller-supplied onPrimary to do anything.
  }

  const compact = variant === "tile";
  // Hero requires a validated 'ok' image (plan-v1-home-pivot.md §11); tiles
  // and grid cards accept 'thin' too — only 'none' falls back to the
  // typographic card everywhere.
  const showPhoto =
    candidate.image.url != null &&
    (variant === "hero" ? candidate.image.quality === "ok" : candidate.image.quality !== "none");
  const showAskRoameo = candidate.primaryAction.kind !== "tell";
  const showDirections = candidate.primaryAction.kind !== "directions" && candidate.coords != null;

  // Typographic fallback (plan-v1-home-pivot.md §11.2). The whole card goes
  // navy and the type scales up — it must NOT keep the photo box and render
  // it empty, which is what leaves a dead slab above the copy.
  const dark = !showPhoto;
  const ghostButton = dark
    ? "border-on-primary/30 text-on-primary hover:bg-on-primary/10"
    : "border-outline-variant/60 text-primary hover:bg-surface-container";

  const primaryIcon = (
    <Icon
      name={
        candidate.primaryAction.kind === "add"
          ? added
            ? "check"
            : "add"
          : candidate.primaryAction.kind === "directions"
            ? "directions"
            : candidate.primaryAction.kind === "book"
              ? "confirmation_number"
              : candidate.primaryAction.kind === "location"
                ? "my_location"
                : "auto_awesome"
      }
      size={16}
    />
  );

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-xl border ${
        dark ? "border-transparent bg-primary text-on-primary" : "border-outline-variant/60 bg-surface-container-lowest"
      } ${className}`}
    >
      {showPhoto ? (
        <div
          onClick={() => void handleOpenDetails()}
          className={`relative w-full shrink-0 cursor-pointer bg-surface-container ${
            variant === "hero" ? "h-52" : variant === "grid" ? "h-28" : "h-24"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={candidate.image.url!} alt="" loading="lazy" className="h-full w-full object-cover" />
          <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2">
            <span className="rounded-full bg-secondary-container px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-on-secondary-container">
              {candidate.pill}
            </span>
          </div>
        </div>
      ) : null}

      <div
        className={`flex flex-1 flex-col gap-1 ${
          dark && variant === "hero" ? "gap-2 p-5 pt-4" : compact ? "p-2.5" : "p-3.5"
        }`}
      >
        <div onClick={() => void handleOpenDetails()} className="flex cursor-pointer flex-col gap-1">
          {dark ? (
            <span
              className={`mb-1 w-fit rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${
                variant === "hero"
                  ? "bg-secondary-container text-on-secondary-container"
                  : "bg-on-primary/15 text-on-primary"
              }`}
            >
              {candidate.pill}
            </span>
          ) : null}
          {!compact ? (
            <span
              className={`font-semibold uppercase tracking-wide ${
                dark && variant === "hero" ? "text-label-md text-secondary-fixed-dim" : "text-[11px]"
              } ${dark ? (variant === "hero" ? "" : "text-secondary-fixed-dim") : "text-secondary"}`}
            >
              {candidate.why}
            </span>
          ) : null}
          <h3
            className={`font-bold ${dark ? "text-on-primary" : "text-primary"} ${
              compact
                ? "text-label-md line-clamp-2"
                : dark && variant === "hero"
                  ? "text-headline-md line-clamp-3"
                  : "text-headline-sm line-clamp-2"
            }`}
          >
            {candidate.headline}
          </h3>
          {candidate.detail ? (
            <p
              className={`${dark ? "text-on-primary/75" : "text-on-surface-variant"} ${
                compact
                  ? "text-[11px] line-clamp-1"
                  : dark && variant === "hero"
                    ? "text-body-lg line-clamp-3"
                    : "text-body-md line-clamp-2"
              }`}
            >
              {candidate.detail}
            </p>
          ) : null}
        </div>

        <div
          className={`mt-auto flex items-center gap-1.5 overflow-x-auto ${
            dark && variant === "hero" ? "pt-3" : "pt-2"
          } ${compact ? "" : "flex-wrap"}`}
        >
          <button
            type="button"
            onClick={handlePrimary}
            disabled={busy || (candidate.primaryAction.kind === "add" && added)}
            className="flex shrink-0 items-center gap-1 rounded-full bg-secondary-container px-3 py-1.5 text-label-sm font-semibold text-on-secondary-container transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {!compact ? (added && candidate.primaryAction.kind === "add" ? "Added" : candidate.primaryAction.label) : null}
            {primaryIcon}
          </button>

          {showAskRoameo ? (
            <Link
              href={askHref}
              onClick={() => signal("opened")}
              className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-label-sm font-semibold transition-colors ${ghostButton}`}
            >
              {!compact ? "Ask Roameo" : null}
              <Icon name="chat" size={16} />
            </Link>
          ) : null}

          {showDirections ? (
            <button
              type="button"
              onClick={() => candidate.coords && window.open(directionsUrl(candidate.coords), "_blank", "noopener")}
              className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-label-sm font-semibold transition-colors ${ghostButton}`}
            >
              {!compact ? "Directions" : null}
              <Icon name="directions" size={16} />
            </button>
          ) : null}

          <button
            type="button"
            aria-label={saved ? "Remove from saved" : "Save"}
            onClick={handleSave}
            disabled={busy}
            className={`ml-auto flex shrink-0 items-center justify-center rounded-full border p-1.5 transition-colors disabled:opacity-60 ${ghostButton}`}
          >
            <Icon name={saved ? "bookmark" : "bookmark_add"} filled={saved} size={16} />
          </button>
        </div>
      </div>

      {onDismiss ? (
        <button
          type="button"
          onClick={() => {
            signal("dismissed");
            onDismiss();
          }}
          className={`absolute right-2.5 top-2.5 rounded-full px-2.5 py-1 text-[11px] font-semibold backdrop-blur-sm transition-opacity hover:opacity-90 ${
            dark ? "bg-on-primary/15 text-on-primary" : "bg-primary/70 text-on-primary"
          }`}
        >
          Nah
        </button>
      ) : null}

      {candidate.subject.type === "event" ? (
        <EventDetailSheet
          open={eventSheetOpen}
          onClose={() => setEventSheetOpen(false)}
          event={eventDetail}
          deviceId={deviceId}
        />
      ) : null}
    </div>
  );
}

export default RoameoCard;
