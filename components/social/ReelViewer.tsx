"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getDeviceId } from "@/lib/device";
import { createItem } from "@/lib/db/items";
import { recordCardSignal } from "@/lib/db/signals";
import { isSaved, saveItem, unsaveItem } from "@/lib/db/saved";
import { buildAskRoameoHref } from "@/lib/chat-seed";
import { buildSearchMapUrl } from "@/lib/maps/links";
import type { CardSubjectType, Place, SocialPost } from "@/lib/types";
import { resolvePlaceForReel } from "@/lib/social/reel-place";
import { proxiedThumbnailUrl } from "@/lib/social/media-proxy";
import { Icon } from "@/components/ui";
import { VideoEmbed } from "./VideoEmbed";

/**
 * card_signals.card_type this file writes with, kept distinct from each
 * other so lib/now/generators.ts's `reel_echo` generator can tell a genuine
 * reel "like" apart from an ordinary Save tap on the same subject:
 *  - REEL_LIKE_CARD_TYPE: the heart-swipe/heart-button gesture (the reel's
 *    core interaction) — this is the one reel_echo reads.
 *  - REEL_ACTION_CARD_TYPE: the RoameoCard-parity Ask Roameo/Save/Add-to-today
 *    row added alongside it (see ReelActionRow below).
 */
const REEL_LIKE_CARD_TYPE = "reel_like";
const REEL_ACTION_CARD_TYPE = "reel";

const SWIPE_THRESHOLD = 120;
const EXIT_DISTANCE = 640;
const EXIT_DURATION_MS = 240;
// Tap and drag-up on the place bar both do the exact same thing (open the
// sheet), so there's no reason to classify the gesture at all: any release
// counts as "open" unless the finger dragged the bar down past this many
// px, which reads as the user backing out of the press. Earlier versions
// tried to separately recognize "tap" (small distance) vs "drag up" (past a
// higher threshold) — but a tap on a real touchscreen routinely reports
// 10-30px of finger jitter, and any gap between the two thresholds became a
// dead zone where genuine taps did nothing.
const BAR_OPEN_DRAG_THRESHOLD = 60;

function likesStorageKey(deviceId: string): string {
  return `roameo_reel_likes_${deviceId || "anon"}`;
}

function loadLikedIds(deviceId: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(likesStorageKey(deviceId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Persist a reel like to localStorage, device-scoped. Best-effort. */
function persistLike(deviceId: string, reelId: string) {
  if (typeof window === "undefined") return;
  try {
    const liked = new Set(loadLikedIds(deviceId));
    liked.add(reelId);
    window.localStorage.setItem(likesStorageKey(deviceId), JSON.stringify(Array.from(liked)));
  } catch {
    // localStorage unavailable (private mode / blocked) — like just won't persist.
  }
}

function formatCount(n: number | null): string {
  if (n == null) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function platformLabel(platform: string | null): string | null {
  if (!platform) return null;
  const lower = platform.toLowerCase();
  if (lower.includes("tiktok")) return "TikTok";
  if (lower.includes("instagram") || lower === "ig") return "Instagram";
  return platform;
}

export type ReelViewerProps = {
  reels: SocialPost[];
  startIndex: number;
  places: Place[];
  /** Active trip id, for card_signals/saved_items rows — null when there's
   * no active trip (the "every reel, no destination filter" fallback). */
  tripId: string | null;
};

/**
 * Full-bleed swipeable reel stack. Dependency-free pointer-drag gesture
 * (pointer events + CSS transform, no framer-motion): drag right past the
 * threshold = like (persisted to localStorage, device-scoped) and advance;
 * drag left = skip and advance. Visible Like/Skip buttons cover
 * accessibility and non-touch input. A bottom "place bar" is its own
 * pointer target — drag it up (or tap it) to navigate to the resolved
 * place's own /place/[id] page (v1.1 W3: content always opens a page, never
 * a sheet), or to a maps search when no place resolved for this reel.
 */
export function ReelViewer({ reels, startIndex, places, tripId }: ReelViewerProps) {
  const router = useRouter();
  // ReelViewer only ever mounts client-side (the page above gates on an
  // async data fetch before rendering it), so it's safe to read the device
  // id directly here rather than through the SSR-deferred useDeviceId hook.
  const [deviceId] = useState(() => getDeviceId());
  const [index, setIndex] = useState(Math.max(startIndex, 0));
  const [likedIds, setLikedIds] = useState<Set<string>>(() => new Set(loadLikedIds(deviceId)));
  const [phase, setPhase] = useState<"idle" | "dragging" | "exiting">("idle");
  const [dragX, setDragX] = useState(0);
  const pointerId = useRef<number | null>(null);
  const startX = useRef(0);

  const [barDragY, setBarDragY] = useState(0);
  const barPointerId = useRef<number | null>(null);
  const barStartY = useRef(0);

  function commitSwipe(action: "like" | "skip") {
    if (phase === "exiting") return;
    const current = reels[index];
    if (action === "like" && current) {
      persistLike(deviceId, current.id);
      setLikedIds((prev) => {
        const next = new Set(prev);
        next.add(current.id);
        return next;
      });
      // Feed the ranker: a "like" is a real signal now, not just local
      // storage. Resolved-place likes are what lib/now/generators.ts's
      // reel_echo generator looks for (card_type REEL_LIKE_CARD_TYPE,
      // subject_type "place"); a placeless reel still leaves a trail via
      // subject_type "reel" even though no generator reads that yet.
      if (deviceId) {
        const likedPlace = resolvePlaceForReel(current, places);
        void recordCardSignal({
          device_id: deviceId,
          trip_id: tripId,
          card_type: REEL_LIKE_CARD_TYPE,
          subject_type: likedPlace ? "place" : "reel",
          subject_id: likedPlace ? likedPlace.id : current.id,
          action: "saved",
        });
      }
    }
    setPhase("exiting");
    setDragX(action === "like" ? EXIT_DISTANCE : -EXIT_DISTANCE);
    window.setTimeout(() => {
      setIndex((i) => i + 1);
      setDragX(0);
      setPhase("idle");
    }, EXIT_DURATION_MS);
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (phase === "exiting") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerId.current = e.pointerId;
    startX.current = e.clientX;
    setPhase("dragging");
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (phase !== "dragging" || e.pointerId !== pointerId.current) return;
    setDragX(e.clientX - startX.current);
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (phase !== "dragging" || e.pointerId !== pointerId.current) return;
    pointerId.current = null;
    const dx = e.clientX - startX.current;
    if (dx > SWIPE_THRESHOLD) {
      commitSwipe("like");
    } else if (dx < -SWIPE_THRESHOLD) {
      commitSwipe("skip");
    } else {
      setPhase("idle");
      setDragX(0);
    }
  }

  // A genuine pointercancel (the browser reclaiming the gesture — e.g. it
  // decided this was a system/back-swipe, or the touch strayed onto the
  // cross-origin video iframe and lost capture) must NEVER be treated like a
  // committed pointerup: cancel events aren't guaranteed real coordinates
  // (some browsers report clientX/Y as 0), so reusing handlePointerUp's dx
  // math here could read as a huge accidental swipe and silently like/skip a
  // reel the user never actually swiped. Just snap back to idle.
  function handlePointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.pointerId !== pointerId.current) return;
    pointerId.current = null;
    setPhase("idle");
    setDragX(0);
  }

  // Bottom place-bar gesture: its own pointer target so a vertical drag/tap
  // here never bubbles into the card's horizontal like/skip handlers above.
  function handleBarPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    barPointerId.current = e.pointerId;
    barStartY.current = e.clientY;
    setBarDragY(0);
  }

  function handleBarPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (barPointerId.current !== e.pointerId) return;
    setBarDragY(Math.min(0, e.clientY - barStartY.current));
  }

  // Tap and drag-up on the place bar both navigate to the resolved place's
  // own detail page (v1.1 W3 — content always opens a page, never a sheet;
  // this replaces the old slide-up PlaceDetailSheet). When a reel has no
  // resolved Place, there's no page to route to, so this falls back to the
  // same "search on maps" deep-link PlaceDetailSheet used to offer for that
  // case, opened directly instead of via a sheet.
  function handleBarPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (barPointerId.current !== e.pointerId) return;
    barPointerId.current = null;
    const dy = e.clientY - barStartY.current;
    setBarDragY(0);
    if (dy < BAR_OPEN_DRAG_THRESHOLD) {
      if (place) {
        router.push(`/place/${place.id}`);
      } else {
        const query = current.location ?? current.caption ?? current.destination ?? "";
        if (query) window.open(buildSearchMapUrl(query), "_blank", "noopener");
      }
    }
  }

  // Same reasoning as handlePointerCancel above: a cancelled bar gesture
  // must not be able to trigger navigation off of stale/zeroed coordinates.
  function handleBarPointerCancel(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (barPointerId.current !== e.pointerId) return;
    barPointerId.current = null;
    setBarDragY(0);
  }

  if (reels.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center text-on-surface-variant">
        <Icon name="videocam_off" size={32} />
        <p className="text-body-md">No reels here yet.</p>
        <Link href="/" className="text-label-md font-medium text-secondary">
          Back to Home
        </Link>
      </div>
    );
  }

  if (index >= reels.length) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center text-on-surface-variant">
        <Icon name="check_circle" size={32} />
        <p className="text-body-md">You&rsquo;re all caught up.</p>
        <p className="text-label-sm">{likedIds.size} liked this session</p>
        <Link href="/" className="text-label-md font-medium text-secondary">
          Back to Home
        </Link>
      </div>
    );
  }

  const current = reels[index];
  const upcoming = reels[index + 1];
  const badge = platformLabel(current.platform);
  const rotation = dragX / 20;
  const likeOpacity = Math.min(Math.max(dragX / SWIPE_THRESHOLD, 0), 1);
  const skipOpacity = Math.min(Math.max(-dragX / SWIPE_THRESHOLD, 0), 1);

  const place = resolvePlaceForReel(current, places);
  const placeName = place?.name ?? current.location ?? current.author_handle ?? "This spot";
  const subtitleParts = place
    ? [place.category, place.rating != null ? `★${place.rating}` : null].filter(
        (v): v is string => !!v
      )
    : [badge, current.author_handle].filter((v): v is string => !!v);
  const subtitle = subtitleParts.join(" • ");

  return (
    // Card stage + a solid action strip below it, rather than chrome floating
    // over the video. Deliberate: TikTok's embed renders its cookie-consent
    // sheet (and its own player controls, including the volume toggle
    // VideoEmbed's sound fallback points at) across the *bottom half* of the
    // iframe. Anything we overlay down there swallows those taps — which is
    // exactly what the old floating place bar did, leaving visitors unable to
    // answer the consent prompt at all. The banner's position tracks the
    // iframe height, so no fixed offset is safe; keeping our chrome off the
    // player entirely is the only durable fix. It also matches the swipe
    // stack's Tinder-style card + action row idiom.
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        {/* Peek at the next card in the stack, static (no embed) to avoid double video loads. */}
        {upcoming ? (
          <div className="absolute inset-4 scale-95 overflow-hidden rounded-2xl opacity-60">
            {(() => {
              const peekPoster = proxiedThumbnailUrl({
                platform: upcoming.platform,
                videoUrl: upcoming.video_url,
                thumbnailUrl: upcoming.thumbnail_url ?? upcoming.image_url,
              });
              return peekPoster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={peekPoster}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full bg-surface-container" />
              );
            })()}
          </div>
        ) : null}

        {/* Draggable top card */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          style={{
            transform: `translateX(${dragX}px) rotate(${rotation}deg)`,
            transition: phase === "dragging" ? "none" : `transform ${EXIT_DURATION_MS}ms ease`,
          }}
          className="absolute inset-0 touch-none select-none"
        >
          <VideoEmbed
            platform={current.platform}
            videoUrl={current.video_url}
            thumbnailUrl={current.thumbnail_url ?? current.image_url}
            caption={current.caption}
          />

          {/* The TikTok/Instagram iframe fills the whole card and swallows
              pointer events before they ever reach this div's onPointer*
              handlers above — a cross-origin iframe owns any touch that
              lands on it; there's no way to observe that gesture or forward
              a tap into it afterward. So the split has to be binary per
              pixel, and the top/bottom half boundary isn't arbitrary: the
              action-strip comment below established that TikTok's own
              controls and its cookie-consent sheet only ever render in the
              bottom *half* of the iframe, never the top. Covering exactly
              the top half gives swipe the biggest safe surface — including
              where users naturally grab the card — without ever sitting on
              top of that bottom-half native chrome. z-10 so it stays under
              the explicit z-20 sound/open buttons above. */}
          <div className="absolute inset-x-0 top-0 z-10 h-1/2" />

          {badge ? (
            <span className="pointer-events-none absolute left-4 top-4 flex items-center gap-1 rounded-full bg-black/60 px-3 py-1 text-label-sm font-semibold text-white backdrop-blur-sm">
              <Icon name="play_circle" filled size={14} />
              {badge}
            </span>
          ) : null}

          {/* LIKE / SKIP stamps that fade in as the drag crosses the threshold */}
          <span
            style={{ opacity: likeOpacity }}
            className="pointer-events-none absolute right-6 top-8 rounded-lg border-4 border-secondary-container px-3 py-1 text-headline-sm font-black uppercase tracking-wide text-secondary-container rotate-[-12deg]"
          >
            Like
          </span>
          <span
            style={{ opacity: skipOpacity }}
            className="pointer-events-none absolute left-6 top-8 rounded-lg border-4 border-white px-3 py-1 text-headline-sm font-black uppercase tracking-wide text-white rotate-[12deg]"
          >
            Skip
          </span>
        </div>
      </div>

      {/* RoameoCard-parity row: primary contextual action / Ask Roameo / Save.
          Added alongside (not replacing) the like/skip swipe mechanic below —
          keyed (prefixed) so its saved/added state resets per-reel. */}
      <ReelActionRow key={`action-${current.id}`} reel={current} place={place} deviceId={deviceId} tripId={tripId} />

      {/* Action strip — place bar + Like/Skip, below the player so none of it
          can intercept taps meant for the embed. */}
      <div className="flex shrink-0 items-center gap-3 px-4 pb-4 pt-3">
        {/* Place bar keeps its own pointer target (see handleBar* above): drag
            up or tap navigates to the place's detail page. */}
        <div
          onPointerDown={handleBarPointerDown}
          onPointerMove={handleBarPointerMove}
          onPointerUp={handleBarPointerUp}
          onPointerCancel={handleBarPointerCancel}
          style={{ transform: `translateY(${barDragY}px)` }}
          className="flex min-w-0 flex-1 touch-none select-none items-center gap-2 rounded-2xl bg-surface-container px-3 py-2.5 text-on-surface"
        >
          <Icon name="keyboard_arrow_up" size={18} className="shrink-0 opacity-60" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-label-md font-bold">{placeName}</p>
            {subtitle ? (
              <p className="truncate text-[11px] text-on-surface-variant">{subtitle}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Icon
              name="favorite"
              filled={likedIds.has(current.id)}
              size={16}
              className={likedIds.has(current.id) ? "text-secondary" : "opacity-60"}
            />
            <span className="text-[11px] font-bold">{formatCount(current.likes)}</span>
          </div>
        </div>

        <button
          type="button"
          aria-label="Skip"
          onClick={() => commitSwipe("skip")}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-primary shadow-sm transition-transform active:scale-90"
        >
          <Icon name="close" size={24} />
        </button>
        <button
          type="button"
          aria-label="Like"
          onClick={() => commitSwipe("like")}
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container shadow-md transition-transform active:scale-90"
        >
          <Icon name="favorite" filled size={26} />
        </button>
      </div>
    </div>
  );
}

type ReelActionRowProps = {
  reel: SocialPost;
  place: Place | null;
  deviceId: string;
  tripId: string | null;
};

/**
 * The three RoameoCard actions Reels was missing (plan-v1-home-pivot.md §8):
 * primary contextual verb / Ask Roameo / Save. The swipe/heart "like" stays
 * the reel's own core interaction (handled by commitSwipe above, in
 * ReelViewer) — this is purely additive, sitting just above that action
 * strip. Mirrors components/roameo/Card.tsx's own action semantics (same
 * helpers: buildAskRoameoHref, saveItem/unsaveItem, createItem,
 * recordCardSignal) rather than rendering RoameoCard itself, since a
 * Candidate-shaped wrapper would duplicate the photo/header this full-bleed
 * video card already has.
 *
 * A reel with no resolved place has no subject Ask Roameo or "Add to today"
 * can act on, so both are hidden — only Save is offered, falling back to
 * `subject_type: "reel"` (a valid CardSubjectType) so even a placeless like
 * still has somewhere to go.
 */
function ReelActionRow({ reel, place, deviceId, tripId }: ReelActionRowProps) {
  const pathname = usePathname();
  const [saved, setSaved] = useState(false);
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);

  const subjectType: CardSubjectType = place ? "place" : "reel";
  const subjectId = place ? place.id : reel.id;
  const subjectName = place?.name ?? reel.location ?? reel.author_handle ?? "This spot";
  const coords = place && place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null;

  // Seed the Save toggle's current state for this reel/place.
  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    isSaved(deviceId, subjectType, subjectId)
      .then((v) => {
        if (!cancelled) setSaved(v);
      })
      .catch((err) => console.error("[reels] saved lookup failed", err));
    return () => {
      cancelled = true;
    };
  }, [deviceId, subjectType, subjectId]);

  function signal(action: "opened" | "saved" | "planned") {
    if (!deviceId) return;
    void recordCardSignal({
      device_id: deviceId,
      trip_id: tripId,
      card_type: REEL_ACTION_CARD_TYPE,
      subject_type: subjectType,
      subject_id: subjectId,
      action,
    });
  }

  async function handleToggleSave() {
    if (!deviceId || busy) return;
    setBusy(true);
    try {
      if (saved) {
        await unsaveItem(deviceId, subjectType, subjectId);
        setSaved(false);
      } else {
        await saveItem({
          device_id: deviceId,
          trip_id: tripId,
          subject_type: subjectType,
          subject_id: subjectId,
          note: null,
        });
        setSaved(true);
        signal("saved");
      }
    } catch (err) {
      console.error("[reels] save toggle failed", err);
    } finally {
      setBusy(false);
    }
  }

  async function handleAddToday() {
    if (!deviceId || !tripId || !place || added || busy) return;
    setBusy(true);
    try {
      const now = new Date();
      await createItem(deviceId, {
        trip_id: tripId,
        place_id: place.id,
        title: place.name,
        category: place.category,
        location: place.station ?? place.name,
        day_date: now.toISOString().slice(0, 10),
        time_label: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        starts_at: now.toISOString(),
      });
      setAdded(true);
      signal("planned");
    } catch (err) {
      console.error("[reels] add to today failed", err);
    } finally {
      setBusy(false);
    }
  }

  const askHref = place
    ? buildAskRoameoHref({ type: "place", id: place.id, name: subjectName, coords, returnTo: pathname })
    : null;

  return (
    <div className="flex shrink-0 items-center gap-2 px-4 pt-1">
      {place ? (
        <button
          type="button"
          onClick={() => void handleAddToday()}
          disabled={busy || added || !tripId}
          className="flex shrink-0 items-center gap-1 rounded-full bg-secondary-container px-3 py-1.5 text-label-sm font-semibold text-on-secondary-container transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          <Icon name={added ? "check" : "add"} size={16} />
          {added ? "Added" : "Add to today"}
        </button>
      ) : null}
      {askHref ? (
        <Link
          href={askHref}
          onClick={() => signal("opened")}
          className="flex shrink-0 items-center gap-1 rounded-full border border-outline-variant/60 px-3 py-1.5 text-label-sm font-semibold text-primary transition-colors hover:bg-surface-container"
        >
          <Icon name="chat" size={16} />
          Ask Roameo
        </Link>
      ) : null}
      <button
        type="button"
        aria-label={saved ? "Remove from saved" : "Save"}
        onClick={() => void handleToggleSave()}
        disabled={busy}
        className="ml-auto flex shrink-0 items-center justify-center rounded-full border border-outline-variant/60 p-1.5 text-primary transition-colors hover:bg-surface-container disabled:opacity-60"
      >
        <Icon name={saved ? "bookmark" : "bookmark_add"} filled={saved} size={16} />
      </button>
    </div>
  );
}

export default ReelViewer;
