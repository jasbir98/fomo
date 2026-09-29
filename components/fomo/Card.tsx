"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, SmartImage } from "@/components/ui";
import { buildAskFomoHref } from "@/lib/chat-seed";
import { directionsUrlFor } from "@/lib/maps/links";
import { saveItem, unsaveItem } from "@/lib/db/saved";
import { describeSupabaseError } from "@/lib/db/errors";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import type { Candidate, CardKind } from "@/lib/cards/types";
import type { CardSubjectType } from "@/lib/types";

export type CardVariant = "hero" | "tile" | "grid";

export interface FomoCardProps {
  candidate: Candidate;
  variant: CardVariant;
  /** Hero only: the "Nah" ghost action. Omit to hide it. */
  onDismiss?: () => void;
  /** Overrides the default handler for a primary action kind ("swap" needs Plan's own swap logic; "location" needs Home's permission-request flow). Receives the action's `kind` so one override can branch on it. */
  onPrimary?: (kind: CardKind) => void;
  /** Hero only: relaxes the photo bar from 'ok' to tile/grid's 'thin-or-better' — for rail-derived featured cards (Home's Celestial Glass redesign), which reuse the hero layout but shouldn't inherit the true page-hero's stricter photo requirement. Most candidates only ever have 'thin' photos; gating all of them on 'ok' collapses them onto the same generic gradient+glyph placeholder. */
  allowThinPhoto?: boolean;
  className?: string;
}

// CATEGORY_BY_SUBJECT lived here, mapping a subject type onto
// `itinerary_items.category` for "Add to today". Fomo has no itinerary, so it
// is gone. CATEGORY_GLYPH below is NOT the same thing and is still needed.

// Category glyph shown in the photo box's navy-gradient fallback when a
// subject has no usable image (quality === "none") — keeps the box's height
// instead of collapsing it (see `hasRealPhoto` below).
const CATEGORY_GLYPH: Record<CardSubjectType, string> = {
  place: "location_on",
  event: "event",
  happening: "sell",
};

/**
 * One card, rendered identically everywhere it appears — Home, Saved, chat's
 * seeded item cards. Geometry is fixed per variant (v1.1 W3,
 * plan-v1.1-overhaul.md) rather than intrinsic, which is what previously
 * produced ragged rail/grid bottoms: `tile` is 168×204 (112 photo + 92 fixed
 * copy), `grid` is fluid-width×232 (128 photo + 104 fixed copy), `hero` is
 * full-width with an intrinsic copy block (208 photo, min 132 copy — no
 * siblings to misalign against).
 *
 * `tile`/`grid` carry ONLY a floating bookmark button over the photo —
 * tapping the card body (photo, headline, meta — everything except the
 * bookmark) navigates to the subject's own detail page. `hero` keeps the
 * full action row (primary · Ask Fomo · Directions · Save · Nah): the
 * four actions tile/grid used to expose live on the detail page instead.
 */
export function FomoCard({
  candidate,
  variant,
  onDismiss,
  onPrimary,
  allowThinPhoto = false,
  className = "",
}: FomoCardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const db = supabaseBrowserAuth();

  const askHref = buildAskFomoHref({
    type: candidate.subject.type,
    id: candidate.subject.id,
    name: candidate.subjectName,
    coords: candidate.coords,
    returnTo: pathname,
  });

  // handleAdd ("Add to today") lived here. Fomo has no itinerary, so a card's
  // primary "add" action now routes to handleSave — the shortlist is the only
  // thing there is to add something to. See the `kind === "add"` branch in
  // handlePrimary below.

  async function handleSave() {
    if (busy) return;
    setBusy(true);
    try {
      if (saved) {
        await unsaveItem(db, candidate.subject.type, candidate.subject.id);
        setSaved(false);
      } else {
        await saveItem(db, {
          subject_type: candidate.subject.type,
          subject_id: candidate.subject.id,
          note: null,
        });
        setSaved(true);
      }
    } catch (err) {
      console.error(`[fomo] save toggle failed ${describeSupabaseError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Tapping the card body (photo/headline/meta — everything except the
  // bookmark on tile/grid, or the action row on hero) opens the subject's
  // own detail page. Every remaining subject type has one — place, event
  // (app/(shell)/event/[id]/page.tsx) and happening.
  const detailHref =
    candidate.subject.type === "place"
      ? `/place/${candidate.subject.id}`
      : candidate.subject.type === "event"
        ? `/event/${candidate.subject.id}`
        : `/happening/${candidate.subject.id}`;

  function handleOpenDetails() {
    router.push(detailHref);
  }

  // handleSecondaryAction/handleSecondaryClick lived here, driving the
  // practicalities rail's "Already sorted" dismiss. That generator and its
  // rail are gone with the trip layer, and Candidate no longer carries
  // `secondaryAction`, so both handlers went with them.

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
    if (kind === "add") void handleSave();
    else if (kind === "directions" && candidate.coords) {
      const url = directionsUrlFor({ lat: candidate.coords.lat, lng: candidate.coords.lng });
      if (url) window.open(url, "_blank", "noopener");
    }
    // "swap"/"location"/"book"/"tell"/"watch" without an override render as
    // navigable links below (book) or fall through to Ask Fomo (tell) —
    // "swap"/"location" need a caller-supplied onPrimary to do anything.
  }

  const isHero = variant === "hero";
  // Hero requires a validated 'ok' image (plan-v1-home-pivot.md §11) unless
  // `allowThinPhoto` opts a hero-variant card into tile/grid's more lenient
  // 'thin-or-better' bar — only 'none' falls back to the gradient+glyph
  // placeholder below.
  const hasRealPhoto =
    candidate.image.url != null &&
    (isHero && !allowThinPhoto ? candidate.image.quality === "ok" : candidate.image.quality !== "none");
  const showAskFomo = candidate.primaryAction.kind !== "tell";
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
          ? saved
            ? "bookmark"
            : "bookmark_add"
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
  // Real pixel dims for the CDN/next-image transform request — tile is a
  // fixed 168px-wide rail card, grid is a ~2-up grid-cols-2 column (roughly
  // 214px inside a 480px shell, see app/(shell)/discover/[intent]/page.tsx),
  // hero is full-width up to the app's 480px shell max-width.
  const photoWidth = isHero ? 480 : variant === "grid" ? 214 : 168;
  const photoPx = isHero ? 208 : variant === "grid" ? 128 : 112;
  const photoSizes = isHero
    ? "(max-width: 480px) 100vw, 480px"
    : variant === "grid"
      ? "(max-width: 480px) 45vw, 214px"
      : "168px";

  return (
    <div
      className={`group relative flex h-full flex-col overflow-hidden rounded-2xl shadow-level-1 ${
        dark ? "bg-primary text-on-primary" : "bg-surface-container-lowest"
      } ${variant === "tile" ? "w-[168px]" : "w-full"} ${className}`}
    >
      <div
        onClick={handleOpenDetails}
        className={`relative w-full shrink-0 cursor-pointer bg-surface-container ${photoHeight}`}
      >
        {hasRealPhoto ? (
          <SmartImage
            src={candidate.image.url}
            alt=""
            width={photoWidth}
            height={photoPx}
            sizes={photoSizes}
            priority={isHero}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary to-primary-container">
            <Icon name={CATEGORY_GLYPH[candidate.subject.type]} size={32} filled className="text-on-primary/70" />
          </div>
        )}
        <div className="absolute inset-x-0 top-0 flex items-start justify-between p-2">
          {/* Hero's dark (no-photo) copy block repeats this pill itself
              below, over the solid gradient rather than a photo — showing
              it here too just doubled up the same chip on one continuous
              amber block. */}
          {!(isHero && dark) ? (
            <span className="rounded-full bg-secondary-container px-2.5 py-1 text-label-sm font-bold uppercase tracking-wide text-on-secondary-container">
              {candidate.pill}
            </span>
          ) : (
            <span aria-hidden />
          )}
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
              <span className="mb-1 w-fit rounded-full bg-secondary-container px-2.5 py-1 text-label-sm font-bold uppercase tracking-wide text-on-secondary-container">
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
              className={`font-bold text-headline-md line-clamp-2 ${dark ? "text-on-primary" : "text-primary"}`}
            >
              {candidate.headline}
            </h3>
            {/* One short one-liner at most — this used to clamp to 3 lines,
                which was room enough for a small paragraph, not "a one-liner
                about the thing" (see the Home card-density pass). */}
            {candidate.detail ? (
              <p
                className={`text-body-lg line-clamp-1 ${dark ? "text-on-primary/75" : "text-on-surface-variant"}`}
              >
                {candidate.detail}
              </p>
            ) : null}
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
            <button
              type="button"
              onClick={handlePrimary}
              disabled={busy}
              className="flex shrink-0 items-center gap-1 rounded-full bg-secondary-container px-3 py-1.5 text-label-sm font-semibold text-on-secondary-container transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {saved && candidate.primaryAction.kind === "add" ? "Saved" : candidate.primaryAction.label}
              {primaryIcon}
            </button>

            {showAskFomo ? (
              <Link
                href={askHref}
                className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-label-sm font-semibold transition-colors ${ghostButton}`}
              >
                Ask Fomo
                <Icon name="chat" size={16} />
              </Link>
            ) : null}

            {showDirections && candidate.coords ? (
              <a
                href={directionsUrlFor(candidate.coords) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-label-sm font-semibold transition-colors ${ghostButton}`}
              >
                Directions
                <Icon name="directions" size={16} />
              </a>
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
              onClick={onDismiss}
              className={`absolute right-2.5 top-2.5 rounded-full px-2.5 py-1 text-label-sm font-semibold backdrop-blur-sm transition-opacity hover:opacity-90 ${
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
              className={`line-clamp-1 text-label-sm font-medium ${dark ? "text-on-primary/75" : "text-on-surface-variant"}`}
            >
              {metaLine}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default FomoCard;
