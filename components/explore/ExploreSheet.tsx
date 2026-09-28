"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ExplorePin } from "@/lib/explore/types";
import { PIN_TYPE_STYLE, directionsUrlForPin, subjectTypeForPin } from "@/lib/explore/pin-style";
import { CITY } from "@/lib/city";
import { useSaved } from "@/lib/useSaved";
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
 * Save and Ask Fomo render whenever `subjectTypeForPin` resolves a
 * `CardSubjectType` — place, provider-event and `happenings`-backed
 * (`/happening/<id>`) pins all do.
 */
export function ExploreSheet({ pin, onClose }: ExploreSheetProps) {
  const pathname = usePathname();
  // Shared saved store (lib/useSaved.ts): starts in the real state for every
  // pin, and a signed-out tap goes to sign-in and back.
  const { isSaved, toggle } = useSaved();

  const subjectType = pin ? subjectTypeForPin(pin) : null;
  const saved = pin && subjectType ? isSaved(subjectType, pin.id) : false;

  async function handleToggleSave() {
    if (!pin || !subjectType) return;
    await toggle(subjectType, pin.id);
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
