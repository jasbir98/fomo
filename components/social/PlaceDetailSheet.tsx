"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { getCurrentTrip, createItem, deleteItem, listItems } from "@/lib/db";
import { buildDirectionsUrl, buildSearchMapUrl } from "@/lib/maps/links";
import { bestTimeForCategory } from "@/lib/social/reel-place";
import type { Place, SocialPost } from "@/lib/types";
import { Button, Icon } from "@/components/ui";

const CLOSE_DRAG_THRESHOLD = 80;

type ParsedTip = { label: string | null; text: string };
type AddState = "idle" | "adding" | "added" | "removing" | "error";

/** Place.tips is jsonb: an array of plain strings ("Label: text") or {label,text} objects. */
function parseTips(raw: unknown): ParsedTip[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): ParsedTip | null => {
      if (typeof entry === "string") {
        const idx = entry.indexOf(": ");
        if (idx > 0 && idx < 40) {
          return { label: entry.slice(0, idx), text: entry.slice(idx + 2) };
        }
        return { label: null, text: entry };
      }
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const text = typeof obj.text === "string" ? obj.text : null;
        if (!text) return null;
        return { label: typeof obj.label === "string" ? obj.label : null, text };
      }
      return null;
    })
    .filter((t): t is ParsedTip => t !== null);
}

function platformLabel(platform: string | null): string | null {
  if (!platform) return null;
  const lower = platform.toLowerCase();
  if (lower.includes("tiktok")) return "TikTok";
  if (lower.includes("instagram") || lower === "ig") return "Instagram";
  return platform;
}

function formatCount(n: number | null): string {
  if (n == null) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

export type PlaceDetailSheetProps = {
  open: boolean;
  onClose: () => void;
  reel: SocialPost;
  place: Place | null;
  deviceId: string;
};

/**
 * Tinder-style slide-up detail sheet for the reel currently on top of the
 * ReelViewer stack. Covers ~85% of the card height, dependency-free drag
 * gesture on its own top handle: drag down past CLOSE_DRAG_THRESHOLD closes
 * it, otherwise it springs back open. Backdrop click / X button also close.
 */
export function PlaceDetailSheet({ open, onClose, reel, place, deviceId }: PlaceDetailSheetProps) {
  const router = useRouter();
  const [addState, setAddState] = useState<AddState>("idle");
  const [itemId, setItemId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragY, setDragY] = useState(0);
  const pointerId = useRef<number | null>(null);
  const startY = useRef(0);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Seed "already added" state each time the sheet opens for a place, so a
  // place added in a previous visit shows "Remove" instead of resetting to
  // a clickable "Add" that would otherwise have no path back to removing it.
  useEffect(() => {
    if (!open || !place || !deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const trip = await getCurrentTrip(deviceId);
        if (!trip || cancelled) return;
        const items = await listItems(deviceId, trip.id);
        const match = items.find(
          (it) => it.title?.trim().toLowerCase() === place.name?.trim().toLowerCase()
        );
        if (cancelled) return;
        if (match) {
          setAddState("added");
          setItemId(match.id);
        } else {
          setAddState("idle");
          setItemId(null);
        }
      } catch (err) {
        console.error("Failed to check itinerary status", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, place, deviceId]);

  function handleHandlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerId.current = e.pointerId;
    startY.current = e.clientY;
    setDragging(true);
  }

  function handleHandlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (!dragging || pointerId.current !== e.pointerId) return;
    setDragY(Math.max(0, e.clientY - startY.current));
  }

  function handleHandlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    e.stopPropagation();
    if (!dragging || pointerId.current !== e.pointerId) return;
    pointerId.current = null;
    setDragging(false);
    const shouldClose = dragY > CLOSE_DRAG_THRESHOLD;
    setDragY(0);
    if (shouldClose) onClose();
  }

  async function handleAddToTrip() {
    if (!deviceId || !place || addState === "adding" || addState === "added") return;
    setAddState("adding");
    try {
      const trip = await getCurrentTrip(deviceId);
      if (!trip) {
        setAddState("idle");
        router.push("/plan/new-trip");
        return;
      }
      const created = await createItem(deviceId, {
        trip_id: trip.id,
        place_id: place.id,
        title: place.name,
        category: place.category,
        location: place.station ?? place.name,
        day_date: trip.start_date,
      });
      setItemId(created.id);
      setAddState("added");
    } catch (err) {
      console.error("Failed to add place to trip", err);
      setAddState("error");
    }
  }

  /** Un-add: reuses `deleteItem` from lib/db/items.ts (same function the
   * chat and map "Add to itinerary" flows now use to remove) rather than a
   * new bespoke removal path. */
  async function handleRemoveFromTrip() {
    if (!deviceId || !itemId || addState === "removing") return;
    setAddState("removing");
    try {
      await deleteItem(deviceId, itemId);
      setItemId(null);
      setAddState("idle");
    } catch (err) {
      console.error("Failed to remove place from trip", err);
      setAddState("error");
    }
  }

  function openDirections() {
    if (!place) return;
    const url = buildDirectionsUrl(place);
    if (url) window.open(url, "_blank", "noopener");
  }

  function openMapSearch() {
    const query = reel.location ?? reel.caption ?? reel.destination ?? "";
    if (!query) return;
    window.open(buildSearchMapUrl(query), "_blank", "noopener");
  }

  const directionsUrl = place ? buildDirectionsUrl(place) : null;
  const tips = place ? parseTips(place.tips) : [];
  const badge = platformLabel(reel.platform);

  return (
    <div
      className={`absolute inset-0 z-20 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close place details"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        style={dragging ? { transform: `translateY(${dragY}px)`, transition: "none" } : undefined}
        className={`absolute inset-x-0 bottom-0 flex h-[85%] flex-col rounded-t-3xl bg-surface-container-lowest shadow-[0_-8px_32px_rgba(3,22,50,0.24)] transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        {/* Close button — kept a SIBLING of the drag handle (not a child) so the
            handle's setPointerCapture on pointerdown can't retarget the click
            away from this button and swallow it. */}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-surface-container text-on-surface-variant"
        >
          <Icon name="close" size={18} />
        </button>

        {/* Drag handle */}
        <div
          onPointerDown={handleHandlePointerDown}
          onPointerMove={handleHandlePointerMove}
          onPointerUp={handleHandlePointerUp}
          onPointerCancel={handleHandlePointerUp}
          className="relative shrink-0 touch-none select-none pt-3 pb-1"
        >
          <div className="flex justify-center">
            <span className="h-1.5 w-10 rounded-full bg-outline-variant" aria-hidden="true" />
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          {place ? (
            <div className="flex flex-col gap-5">
              <div>
                <h2 className="text-headline-sm text-on-surface">{place.name ?? "Place"}</h2>
                <div className="mt-1 flex items-center gap-2 text-label-md text-on-surface-variant">
                  {place.rating != null ? (
                    <span className="flex items-center gap-1 text-secondary">
                      <Icon name="star" filled size={16} />
                      {place.rating}
                    </span>
                  ) : null}
                  {place.rating != null && place.category ? <span>•</span> : null}
                  {place.category ? <span>{place.category}</span> : null}
                </div>
              </div>

              {/* Roameo suggestion: best time to go */}
              <div className="flex items-start gap-3 rounded-xl border-l-4 border-secondary-container bg-primary p-4 text-on-primary">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-container">
                  <Icon name="smart_toy" size={18} className="text-on-primary-container" />
                </div>
                <div>
                  <p className="mb-1 text-label-md opacity-80">Best time to go</p>
                  <p className="text-body-md font-medium">
                    {bestTimeForCategory(place.category)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-t border-outline-variant/30 pt-4">
                <div className="flex items-center gap-3">
                  <Icon name="schedule" className="text-primary" />
                  <div>
                    <p className="text-label-sm text-on-surface-variant">Hours</p>
                    <p className="text-label-md text-on-surface">{place.hours ?? "—"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Icon name="train" className="text-primary" />
                  <div>
                    <p className="text-label-sm text-on-surface-variant">Station</p>
                    <p className="text-label-md text-on-surface">
                      {place.station ?? place.address ?? "—"}
                    </p>
                  </div>
                </div>
              </div>

              {tips.length > 0 ? (
                <div>
                  <h3 className="mb-3 text-label-md font-semibold text-on-surface">
                    Roameo&rsquo;s Tips
                  </h3>
                  <div className="flex flex-col gap-2">
                    {tips.map((tip, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-3 rounded-xl border border-outline-variant/40 bg-surface-container-lowest p-3"
                      >
                        <Icon name="tips_and_updates" size={18} className="mt-0.5 text-secondary" />
                        <div>
                          {tip.label ? (
                            <p className="mb-0.5 text-label-sm text-on-surface-variant">
                              {tip.label}
                            </p>
                          ) : null}
                          <p className="text-body-md text-on-surface">{tip.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {addState === "added" ? (
                <div className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-on-primary">
                  <Icon name="check_circle" filled size={18} className="text-secondary-container" />
                  <p className="flex-1 text-label-md">Added to your trip.</p>
                </div>
              ) : null}
              {addState === "error" ? (
                <div className="rounded-xl bg-error-container px-4 py-2.5 text-label-md text-on-error-container">
                  Couldn&rsquo;t add to trip. Try again.
                </div>
              ) : null}

              <div className="flex gap-3 pb-1">
                <Button
                  variant="orange"
                  fullWidth
                  leadingIcon="directions"
                  onClick={openDirections}
                  disabled={!directionsUrl}
                >
                  Get Directions
                </Button>
                <Button
                  variant={addState === "added" ? "danger" : "outline"}
                  leadingIcon={addState === "added" ? "delete" : "add_circle"}
                  onClick={addState === "added" ? handleRemoveFromTrip : handleAddToTrip}
                  disabled={addState === "adding" || addState === "removing"}
                >
                  {addState === "added"
                    ? "Remove"
                    : addState === "adding"
                      ? "Adding…"
                      : addState === "removing"
                        ? "Removing…"
                        : "Add"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <h2 className="text-headline-sm text-on-surface">
                  {reel.location ?? reel.author_handle ?? "This spot"}
                </h2>
                <div className="mt-1 flex items-center gap-2 text-label-md text-on-surface-variant">
                  {badge ? <span>{badge}</span> : null}
                  {badge && reel.author_handle ? <span>•</span> : null}
                  {reel.author_handle ? <span>{reel.author_handle}</span> : null}
                </div>
              </div>

              {reel.caption ? (
                <p className="text-body-md text-on-surface-variant">{reel.caption}</p>
              ) : null}

              <div className="flex items-center gap-2 text-label-md text-on-surface-variant">
                <Icon name="favorite" size={18} className="text-secondary" />
                {formatCount(reel.likes)} likes
              </div>

              <Button variant="orange" fullWidth leadingIcon="map" onClick={openMapSearch}>
                Search on maps
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default PlaceDetailSheet;
