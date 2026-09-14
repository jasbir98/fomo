"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "@/components/ui";
import { buildAskFomoHref } from "@/lib/chat-seed";
import { recordCardSignal } from "@/lib/db/signals";
import { saveItem, unsaveItem } from "@/lib/db/saved";
import { describeSupabaseError } from "@/lib/db/errors";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import type { Candidate, CardKind } from "@/lib/now/types";
import type { CardSubjectType } from "@/lib/types";

export type CardVariant = "hero" | "tile" | "grid";

export interface FomoCardProps {
  candidate: Candidate;
  variant: CardVariant;
  /** Hero only: the "Nah" ghost action. Omit to hide it. */
  onDismiss?: () => void;
  /** Overrides the default handler for a primary action kind ("swap" needs Plan's own swap logic; "location" needs Home's permission-request flow). Receives the action's `kind` so one override can branch on it. */
  onPrimary?: (kind: CardKind) => void;
  /** Phase 7 (plan §E.2) — fires after a successful `secondaryAction` (currently only the practicalities rail's "Already sorted" dismiss) POSTs to the server, same "card can't know the parent's list state" reasoning as `onAdded`. Home wires this to refetch /api/now so a dismissed topic doesn't reappear on the next render; a no-op for every card without a `secondaryAction`. */
  onSecondaryAction?: () => void;
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
  experience: "confirmation_number",
  itinerary_item: "bookmark",
  reel: "movie",
  practicality: "info",
};

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
  // Phase 7 (plan §E.2) — optimistic hide for the practicalities rail's
  // "Already sorted" action: the card disappears the instant it's tapped,
  // ahead of the POST resolving. `handleSecondaryAction`/`onSecondaryAction`
  // (which used to flip this to true) were removed with the practicalities
  // rail's secondaryAction feature, so `dismissed` is now always false — left
  // in place since the render guard below is still correct, just dormant.
  const [dismissed] = useState(false);
  const db = supabaseBrowserAuth();

  if (dismissed) return null;

  const askHref = buildAskFomoHref({
    type: candidate.subject.type,
    id: candidate.subject.id,
    name: candidate.subjectName,
    coords: candidate.coords,
    returnTo: pathname,
  });

  function signal(action: "opened" | "saved" | "dismissed") {
    void recordCardSignal(db, {
      card_type: candidate.generator,
      subject_type: candidate.subject.type,
      subject_id: candidate.subject.id,
      action,
    });
  }

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
        signal("saved");
      }
    } catch (err) {
      console.error(`[fomo] save toggle failed ${describeSupabaseError(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Tapping the card body (photo/headline/meta — everything except the
  // bookmark on tile/grid, or the action row on hero) opens the subject's
  // own detail page. Every subject type now has a real route — including
  // "event" (app/(shell)/event/[id]/page.tsx, new in v1.1 W3) — except
  // "practicality" (Phase 7): the plan explicitly rules out a
  // /practicalities detail page ("the rail is the whole feature"), so this
  // stays null and handleOpenDetails below routes to Ask Fomo instead.
  const detailHref =
    candidate.subject.type === "place"
      ? `/place/${candidate.subject.id}`
      : candidate.subject.type === "event"
        ? `/event/${candidate.subject.id}`
        : candidate.subject.type === "experience"
          ? `/experience/${candidate.subject.id}`
          : candidate.subject.type === "reel"
            ? `/social/${candidate.subject.id}`
            : null;

  function handleOpenDetails() {
    signal("opened");
    // Phase 7 — a practicality card has no detail page; tapping the body is
    // the natural "tell me more" gesture, so it opens chat pre-seeded with
    // this row's own chat_seed/headline instead of navigating nowhere.
    if (candidate.subject.type === "practicality") {
      router.push(askHref);
      return;
    }
    if (detailHref) router.push(detailHref);
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
      window.open(directionsUrl(candidate.coords), "_blank", "noopener");
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
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={candidate.image.url!} alt="" loading="lazy" className="h-full w-full object-cover" />
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
            <span className="rounded-full bg-secondary-container px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-on-secondary-container">
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
                onClick={() => signal("opened")}
                className={`flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-label-sm font-semibold transition-colors ${ghostButton}`}
              >
                Ask Fomo
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

export default FomoCard;
