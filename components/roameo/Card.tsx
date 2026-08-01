"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import { buildAskRoameoHref } from "@/lib/chat-seed";
import { createItem } from "@/lib/db/items";
import { recordCardSignal } from "@/lib/db/signals";
import { saveItem, unsaveItem } from "@/lib/db/saved";
import { describeSupabaseError } from "@/lib/db/errors";
import type { Candidate, CardKind } from "@/lib/now/types";
import type { CardSubjectType } from "@/lib/types";

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
  /** Fires after a successful default "Add to today" (handleAdd), on top of the "planned" signal already recorded — Plan's gap blocks and disruption "Other options" (plan-v1.1-overhaul.md W4 #6) use this to refetch their own item/gap state, since this card's own createItem call happens with no way for a parent otherwise to know a mutation occurred. Not called when `onPrimary` overrides the add behavior entirely. */
  onAdded?: () => void;
  className?: string;
}

const CATEGORY_BY_SUBJECT: Record<CardSubjectType, string> = {
  place: "activity",
  event: "activity",
  experience: "booking",
  itinerary_item: "activity",
  reel: "activity",
};

// Category glyph shown in the photo box's navy-gradient fallback when a
// subject has no usable image (quality === "none") — keeps the box's height
// instead of collapsing it (see `hasRealPhoto` below).
const CATEGORY_GLYPH: Record<CardSubjectType, string> = {
  place: "location_on",
  event: "event",
  experience: "confirmation_number",
  itinerary_item: "bookmark",
  reel: "movie",
};

function todayISODate(iso: string): string {
  return iso.slice(0, 10);
}

function directionsUrl(coords: { lat: number; lng: number }): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}`;
}

/**
 * One card, rendered identically everywhere — Home rail, Plan gaps, chip
 * discover grids, Reels. Geometry is fixed per variant (v1.1 W3,
 * plan-v1.1-overhaul.md) rather than intrinsic, which is what previously
 * produced ragged rail/grid bottoms: `tile` is 168×204 (112 photo + 92 fixed
 * copy), `grid` is fluid-width×232 (128 photo + 104 fixed copy), `hero` is
 * full-width with an intrinsic copy block (208 photo, min 132 copy — no
 * siblings to misalign against).
 *
 * `tile`/`grid` carry ONLY a floating bookmark button over the photo —
 * tapping the card body (photo, headline, meta — everything except the
 * bookmark) navigates to the subject's own detail page. `hero` keeps the
 * full action row (primary · Ask Roameo · Directions · Save · Nah): the
 * four actions tile/grid used to expose live on the detail page instead.
 */
export function RoameoCard({
  candidate,
  variant,
  deviceId,
  tripId,
  onDismiss,
  onPrimary,
  onAdded,
  className = "",
}: RoameoCardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [added, setAdded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

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
      onAdded?.();
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

  // Tapping the card body (photo/headline/meta — everything except the
  // bookmark on tile/grid, or the action row on hero) opens the subject's
  // own detail page. Every subject type now has a real route — including
  // "event" (app/(shell)/event/[id]/page.tsx, new in v1.1 W3) — so this is a
  // plain navigation, never a fetch-then-open-sheet.
  const detailHref =
    candidate.subject.type === "place"
      ? `/place/${candidate.subject.id}`
      : candidate.subject.type === "event"
        ? `/event/${candidate.subject.id}`
        : candidate.subject.type === "experience"
          ? `/experience/${candidate.subject.id}`
          : candidate.subject.type === "itinerary_item"
            ? `/plan/item/${candidate.subject.id}`
            : candidate.subject.type === "reel"
              ? `/social/${candidate.subject.id}`
              : null;

  function handleOpenDetails() {
    signal("opened");
    if (detailHref) router.push(detailHref);
  }

  function handleBookmarkClick(e: React.MouseEvent) {
    e.stopPropagation();
    void handleSave();
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

  const isHero = variant === "hero";
  // Hero requires a validated 'ok' image (plan-v1-home-pivot.md §11); tiles
  // and grid cards accept 'thin' too — only 'none' falls back to the
  // gradient+glyph placeholder below.
  const hasRealPhoto =
    candidate.image.url != null &&
    (isHero ? candidate.image.quality === "ok" : candidate.image.quality !== "none");
  const showAskRoameo = candidate.primaryAction.kind !== "tell";
  const showDirections = candidate.primaryAction.kind !== "directions" && candidate.coords != null;
  // Meta line for tile/grid — one sensible fact per subject, sourced from
  // whatever the ranker already populated (generators.ts writes contextual
  // text into `detail`: walk time, price/duration, best-time tips, etc.)
  // rather than inventing new fields for this presentation-only change.
  const metaLine = candidate.detail || candidate.railMeta || null;

  // Typographic fallback (plan-v1-home-pivot.md §11.2) for the copy block
  // below the photo. The photo box itself always renders now (real image or
  // a navy gradient + glyph placeholder) — it must never collapse, which is
  // what used to leave a ~96px height gap versus neighboring cards.
  const dark = !hasRealPhoto;
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

  const photoHeight = isHero ? "h-52" : variant === "grid" ? "h-32" : "h-28";

  return (
    <div
      className={`group relative flex h-full flex-col overflow-hidden rounded-xl border ${
        dark ? "border-transparent bg-primary text-on-primary" : "border-outline-variant/60 bg-surface-container-lowest"
      } ${variant === "tile" ? "w-[168px]" : "w-full"} ${className}`}
    >
      <div
        onClick={handleOpenDetails}
        className={`relative w-full shrink-0 cursor-pointer bg-surface-container ${photoHeight}`}
      >
        {hasRealPhoto ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={candidate.image.url!} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary to-primary-container">
            <Icon name={CATEGORY_GLYPH[candidate.subject.type]} size={32} filled className="text-on-primary/70" />
          </div>
        )}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2">
          <span className="rounded-full bg-secondary-container px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-on-secondary-container">
            {candidate.pill}
          </span>
          {!isHero ? (
            <button
              type="button"
              aria-label={saved ? "Remove from saved" : "Save"}
              onClick={handleBookmarkClick}
              disabled={busy}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition-colors hover:bg-black/50 disabled:opacity-60"
            >
              <Icon name={saved ? "bookmark" : "bookmark_add"} filled={saved} size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {isHero ? (
        <div
          className={`flex min-h-[132px] flex-1 flex-col gap-1 ${dark ? "gap-2 p-5 pt-4" : "p-3.5"}`}
        >
          <div onClick={handleOpenDetails} className="flex cursor-pointer flex-col gap-1">
            {dark ? (
              <span className="mb-1 w-fit rounded-full bg-secondary-container px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-on-secondary-container">
                {candidate.pill}
              </span>
            ) : null}
            <span
              className={`font-semibold uppercase tracking-wide text-label-md ${
                dark ? "text-secondary-fixed-dim" : "text-secondary"
              }`}
            >
              {candidate.why}
            </span>
            <h3
              className={`font-bold text-headline-md line-clamp-3 ${dark ? "text-on-primary" : "text-primary"}`}
            >
              {candidate.headline}
            </h3>
            {candidate.detail ? (
              <p
                className={`text-body-lg line-clamp-3 ${dark ? "text-on-primary/75" : "text-on-surface-variant"}`}
              >
                {candidate.detail}
              </p>
            ) : null}
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
            <button
              type="button"
              onClick={handlePrimary}
              disabled={busy || (candidate.primaryAction.kind === "add" && added)}
              className="flex shrink-0 items-center gap-1 rounded-full bg-secondary-container px-3 py-1.5 text-label-sm font-semibold text-on-secondary-container transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {added && candidate.primaryAction.kind === "add" ? "Added" : candidate.primaryAction.label}
              {primaryIcon}
            </button>

            {showAskRoameo ? (
              <Link
                href={askHref}
                onClick={() => signal("opened")}
                className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-label-sm font-semibold transition-colors ${ghostButton}`}
              >
                Ask Roameo
                <Icon name="chat" size={16} />
              </Link>
            ) : null}

            {showDirections ? (
              <button
                type="button"
                onClick={() => candidate.coords && window.open(directionsUrl(candidate.coords), "_blank", "noopener")}
                className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-label-sm font-semibold transition-colors ${ghostButton}`}
              >
                Directions
                <Icon name="directions" size={16} />
              </button>
            ) : null}

            <button
              type="button"
              aria-label={saved ? "Remove from saved" : "Save"}
              onClick={handleBookmarkClick}
              disabled={busy}
              className={`ml-auto flex shrink-0 items-center justify-center rounded-full border p-1.5 transition-colors disabled:opacity-60 ${ghostButton}`}
            >
              <Icon name={saved ? "bookmark" : "bookmark_add"} filled={saved} size={16} />
            </button>
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
        </div>
      ) : (
        <div
          onClick={handleOpenDetails}
          className={`flex cursor-pointer flex-col gap-1 overflow-hidden ${
            variant === "tile" ? "h-[92px] p-2.5" : "h-[104px] p-3"
          }`}
        >
          <h3
            className={`font-bold line-clamp-2 ${dark ? "text-on-primary" : "text-primary"} ${
              variant === "tile" ? "text-label-md" : "text-headline-sm"
            }`}
          >
            {candidate.headline}
          </h3>
          {metaLine ? (
            <p
              className={`line-clamp-1 text-[11px] ${dark ? "text-on-primary/75" : "text-on-surface-variant"}`}
            >
              {metaLine}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default RoameoCard;
