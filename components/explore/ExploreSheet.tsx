"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ExplorePin } from "@/lib/explore/types";
import { PIN_TYPE_STYLE, directionsUrlForPin, subjectTypeForPin } from "@/lib/explore/pin-style";
import { CITY } from "@/lib/city";
import { isSaved, recordCardSignal, saveItem, unsaveItem } from "@/lib/db";
import { supabaseBrowserAuth } from "@/lib/supabase/client";
import { buildAskFomoHref } from "@/lib/chat-seed";
import { BottomSheet, Icon, SmartImage } from "@/components/ui";

export interface ExploreSheetProps {
  pin: ExplorePin | null;
  onClose: () => void;
}

/** "Sat 27 Sep · 7:30 PM" in the city's own timezone — starts_at only ever appears on dated deal/event pins. */
function formatStartsAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: CITY.timezone,
  }).format(d);
}

/**
 * Marker-tap detail sheet. Handles all four `ExplorePin` types off the
 * lightweight pin payload alone (no extra fetch) — see lib/explore/types.ts's
 * header for why the pin contract stays small; "View full details" is the
 * escape hatch for a place/happening/event's full page.
 *
 * Save and Ask Fomo only render when `subjectTypeForPin` resolves a real
 * `CardSubjectType` (place or provider-event pins) — a deal/free/event pin
 * backed by a `happenings` row (href `/happening/<id>`) has no
 * `CardSubjectType` to hand those helpers, so it gets Directions + View
 * details only, same as the task brief's "keep actions where helpers support
 * the subject type" instruction. Its own detail page has its own Save action.
 */
export function ExploreSheet({ pin, onClose }: ExploreSheetProps) {
  const db = supabaseBrowserAuth();
  const pathname = usePathname();
  const [saved, setSaved] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);

  const subjectType = pin ? subjectTypeForPin(pin) : null;

  // Reset the (stale, previous pin's) saved flag the instant a new pin is
  // selected — the "adjust state during render" pattern (see
  // lib/useProgressiveReveal.ts's own prevTotal reset for the same trick)
  // rather than a `setSaved(false)` inside the effect below, which React's
  // lint rightly flags as a synchronous setState-in-effect (it'd cascade an
  // extra render on every pin change for no benefit over doing it here).
  const [resetForPinId, setResetForPinId] = useState<string | null>(null);
  if (pin && pin.id !== resetForPinId) {
    setResetForPinId(pin.id);
    setSaved(false);
  }

  // The real (possibly-true) saved status — async, so it can only ever
  // follow the render-time reset above, never replace it.
  useEffect(() => {
    if (!pin || !subjectType) return;
    let cancelled = false;
    isSaved(db, subjectType, pin.id)
      .then((v) => {
        if (!cancelled) setSaved(v);
      })
      .catch((err) => console.error("[explore] saved lookup failed", err));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `db` is a stable client instance per mount, re-running on it would refire the lookup for no reason.
  }, [pin, subjectType]);

  async function handleToggleSave() {
    if (!pin || !subjectType || saveBusy) return;
    setSaveBusy(true);
    try {
      if (saved) {
        await unsaveItem(db, subjectType, pin.id);
        setSaved(false);
      } else {
        await saveItem(db, { subject_type: subjectType, subject_id: pin.id, note: null });
        setSaved(true);
        void recordCardSignal(db, {
          card_type: "map",
          subject_type: subjectType,
          subject_id: pin.id,
          action: "saved",
        });
      }
    } catch (err) {
      console.error("[explore] save toggle failed", err);
    } finally {
      setSaveBusy(false);
    }
  }

  const askHref =
    pin && subjectType
      ? buildAskFomoHref({
          type: subjectType,
          id: pin.id,
          name: pin.title,
          coords: { lat: pin.lat, lng: pin.lng },
          returnTo: pathname,
        })
      : null;

  const style = pin ? PIN_TYPE_STYLE[pin.type] : null;

  return (
    <BottomSheet open={pin !== null} onClose={onClose} title={pin?.title ?? ""}>
      {pin && style ? (
        <div className="flex flex-col gap-3">
          <div className="relative h-[140px] w-full overflow-hidden rounded-xl bg-surface-container">
            {pin.image ? (
              <SmartImage
                src={pin.image}
                alt={pin.title}
                width={480}
                height={140}
                sizes="(max-width: 480px) 100vw, 480px"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Icon name={style.icon} size={28} className="text-outline" />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-label-sm text-on-surface-variant">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-white"
              style={{ backgroundColor: style.color }}
            >
              <Icon name={style.icon} size={14} />
              {style.label}
            </span>
            {pin.category ? <span>{pin.category}</span> : null}
            {pin.badge ? <span className="font-semibold text-secondary">{pin.badge}</span> : null}
          </div>

          {pin.starts_at ? (
            <p className="flex items-center gap-2 text-body-md text-on-surface-variant">
              <Icon name="schedule" size={18} className="shrink-0 text-primary" />
              {formatStartsAt(pin.starts_at)}
            </p>
          ) : null}

          <div className="mt-1 flex flex-wrap items-center gap-2">
            {askHref ? (
              <Link
                href={askHref}
                onClick={() =>
                  void recordCardSignal(db, {
                    card_type: "map",
                    subject_type: subjectType as NonNullable<typeof subjectType>,
                    subject_id: pin.id,
                    action: "opened",
                  })
                }
                className="flex min-h-[44px] flex-1 basis-[45%] items-center justify-center gap-2 rounded-xl border border-outline-variant px-4 text-label-md font-semibold text-primary transition-opacity hover:opacity-90"
              >
                <Icon name="chat" size={18} />
                Ask Fomo
              </Link>
            ) : null}
            <a
              href={directionsUrlForPin(pin)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Get directions"
              className="flex min-h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-outline-variant text-primary transition-opacity hover:opacity-90"
            >
              <Icon name="directions" size={20} />
            </a>
            {subjectType ? (
              <button
                type="button"
                aria-label={saved ? "Remove from saved" : "Save"}
                onClick={handleToggleSave}
                disabled={saveBusy}
                className="flex min-h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl border border-outline-variant text-primary transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                <Icon name={saved ? "bookmark" : "bookmark_add"} filled={saved} size={20} />
              </button>
            ) : null}
          </div>

          <Link
            href={pin.href}
            className="text-center text-label-md font-semibold text-primary hover:underline"
          >
            View full details
          </Link>
        </div>
      ) : null}
    </BottomSheet>
  );
}

export default ExploreSheet;
