"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getCurrentTrip, createItem, deleteItem, listItems } from "@/lib/db";
import type { EventItem, Trip } from "@/lib/types";
import {
  eventDayDate,
  formatEventPrice,
  formatEventTime,
  formatEventWhen,
} from "@/lib/events/format";
import { BottomSheet, Button, Chip, Icon } from "@/components/ui";

type AddState = "idle" | "adding" | "added" | "removing" | "error";

export type EventDetailSheetProps = {
  open: boolean;
  onClose: () => void;
  event: EventItem | null;
  deviceId: string;
};

/**
 * BottomSheet-based event detail: hero image, when/where, description, a
 * "Get tickets" external link, and Add to trip. Modelled on
 * components/social/PlaceDetailSheet.tsx's add-to-trip shape (AddState
 * machine + mount effect that re-derives "already added").
 *
 * Unlike a place (always filed on trip.start_date), an event has a fixed
 * date — eventDayDate(event.starts_at) can fall outside the trip's
 * start_date..end_date window, in which case the Add button is disabled
 * with "Outside your trip dates" rather than silently filing it on the
 * wrong day.
 */
export function EventDetailSheet({ open, onClose, event, deviceId }: EventDetailSheetProps) {
  const router = useRouter();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [addState, setAddState] = useState<AddState>("idle");
  const [itemId, setItemId] = useState<string | null>(null);

  // Re-derive trip + "already added" every time the sheet opens for an
  // event, so an event added on a previous visit shows "Remove" instead of
  // resetting to a clickable "Add" with no path back.
  useEffect(() => {
    if (!open || !event || !deviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const currentTrip = await getCurrentTrip(deviceId);
        if (cancelled) return;
        setTrip(currentTrip);
        if (!currentTrip) {
          setAddState("idle");
          setItemId(null);
          return;
        }
        const items = await listItems(deviceId, currentTrip.id);
        if (cancelled) return;
        const dayDate = eventDayDate(event.starts_at);
        const match = items.find(
          (it) =>
            it.title?.trim().toLowerCase() === event.name.trim().toLowerCase() &&
            it.day_date === dayDate
        );
        if (match) {
          setAddState("added");
          setItemId(match.id);
        } else {
          setAddState("idle");
          setItemId(null);
        }
      } catch (err) {
        console.error("[events] failed to check itinerary status", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, event, deviceId]);

  const dayDate = event ? eventDayDate(event.starts_at) : "";
  const outsideTripDates =
    !!trip &&
    !!trip.start_date &&
    !!trip.end_date &&
    !!dayDate &&
    (dayDate < trip.start_date || dayDate > trip.end_date);

  async function handleAddToTrip() {
    if (!deviceId || !event || addState === "adding" || addState === "added" || outsideTripDates) return;
    setAddState("adding");
    try {
      const currentTrip = trip ?? (await getCurrentTrip(deviceId));
      if (!currentTrip) {
        setAddState("idle");
        onClose();
        router.push("/plan/new-trip");
        return;
      }
      const created = await createItem(deviceId, {
        trip_id: currentTrip.id,
        place_id: event.place_id,
        title: event.name,
        category: "activity",
        location: event.venue_name ?? event.address,
        day_date: eventDayDate(event.starts_at),
        time_label: formatEventTime(event.starts_at),
      });
      setItemId(created.id);
      setAddState("added");
    } catch (err) {
      console.error("[events] add to trip failed", err);
      setAddState("error");
    }
  }

  /** Un-add: reuses deleteItem from lib/db/items.ts — no new removal path. */
  async function handleRemoveFromTrip() {
    if (!deviceId || !itemId || addState === "removing") return;
    setAddState("removing");
    try {
      await deleteItem(deviceId, itemId);
      setItemId(null);
      setAddState("idle");
    } catch (err) {
      console.error("[events] remove from trip failed", err);
      setAddState("error");
    }
  }

  const price = event ? formatEventPrice(event) : "";

  return (
    <BottomSheet open={open} onClose={onClose} title={event?.name ?? ""}>
      {event ? (
        <div className="flex flex-col gap-4">
          <div className="relative h-[160px] w-full overflow-hidden rounded-xl bg-surface-container">
            {event.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={event.image_url}
                alt={event.name}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Icon name="event" size={32} className="text-outline" />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-body-md text-on-surface">
              <Icon name="schedule" size={18} className="text-primary" />
              {formatEventWhen(event.starts_at, event.ends_at)}
            </p>
            {event.venue_name || event.address ? (
              <p className="flex items-start gap-2 text-body-md text-on-surface-variant">
                <Icon name="location_on" size={18} className="mt-0.5 shrink-0 text-primary" />
                {[event.venue_name, event.address].filter(Boolean).join(" — ")}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              {event.category ? (
                <Chip
                  label={event.category}
                  className="pointer-events-none min-h-[28px] px-3 text-[11px] capitalize"
                />
              ) : null}
              {price ? (
                <span className="text-label-md font-semibold text-primary">{price}</span>
              ) : null}
            </div>
          </div>

          {event.description ? (
            <p className="text-body-md text-on-surface-variant">{event.description}</p>
          ) : null}

          {outsideTripDates && addState !== "added" ? (
            <p className="text-label-sm text-on-surface-variant">
              This event falls outside your trip dates, so it can&rsquo;t be added to the
              itinerary.
            </p>
          ) : null}

          {addState === "added" ? (
            <div className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-on-primary">
              <Icon name="check_circle" filled size={18} className="text-secondary-container" />
              <p className="flex-1 text-label-md">Added to your trip.</p>
            </div>
          ) : null}
          {addState === "error" ? (
            <div className="rounded-xl bg-error-container px-4 py-2.5 text-label-md text-on-error-container">
              Couldn&rsquo;t update your trip. Try again.
            </div>
          ) : null}

          <div className="flex gap-3 pb-1">
            {event.ticket_url ? (
              <a
                href={event.ticket_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-secondary-container px-6 text-label-md font-semibold text-on-secondary-container shadow-sm transition-opacity hover:opacity-90"
              >
                <Icon name="confirmation_number" size={18} />
                Get tickets
              </a>
            ) : null}
            <Button
              variant={addState === "added" ? "danger" : "outline"}
              leadingIcon={addState === "added" ? "delete" : "add_circle"}
              onClick={addState === "added" ? handleRemoveFromTrip : handleAddToTrip}
              disabled={
                addState === "adding" ||
                addState === "removing" ||
                (addState !== "added" && outsideTripDates)
              }
            >
              {outsideTripDates && addState !== "added"
                ? "Outside your trip dates"
                : addState === "added"
                  ? "Remove"
                  : addState === "adding"
                    ? "Adding…"
                    : addState === "removing"
                      ? "Removing…"
                      : "Add to trip"}
            </Button>
          </div>
        </div>
      ) : null}
    </BottomSheet>
  );
}

export default EventDetailSheet;
