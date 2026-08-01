"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useDeviceId } from "@/lib/device";
import { deleteTrip, listTrips, setActiveTrip } from "@/lib/db";
import type { Trip } from "@/lib/types";
import { BottomSheet, ConfirmDialog, Icon } from "@/components/ui";

function tripDates(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  const short = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  if (start && end) return `${short(start)} – ${short(end)}`;
  return short((start ?? end) as string);
}

/**
 * Header trip switcher. Renders the current trip's name as a tappable label
 * that opens a bottom sheet listing every trip for the device. Selecting a
 * different trip flips the active trip via `setActiveTrip` and reloads so every
 * surface (home / map / plan / chat) re-reads the new active trip on mount.
 * A "New trip" row links into the create-trip flow.
 */
export function TripSwitcher({ currentTrip }: { currentTrip: Trip | null }) {
  const deviceId = useDeviceId();
  const [open, setOpen] = useState(false);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Trip | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Load the trip list lazily when the sheet is first opened.
  useEffect(() => {
    if (!open || !deviceId) return;
    let cancelled = false;
    listTrips(deviceId)
      .then((rows) => {
        if (!cancelled) setTrips(rows);
      })
      .catch((err) => console.error("[TripSwitcher] listTrips failed", err));
    return () => {
      cancelled = true;
    };
  }, [open, deviceId]);

  async function pick(tripId: string) {
    if (!deviceId || switching) return;
    if (tripId === currentTrip?.id) {
      setOpen(false);
      return;
    }
    setSwitching(tripId);
    try {
      await setActiveTrip(deviceId, tripId);
      // Full reload: every screen loads the active trip in a mount effect, so a
      // reload is the simplest reliable way to propagate the switch app-wide.
      window.location.reload();
    } catch (err) {
      console.error("[TripSwitcher] setActiveTrip failed", err);
      setSwitching(null);
    }
  }

  async function handleDelete() {
    if (!deviceId || !pendingDelete || deleting) return;
    const deletedId = pendingDelete.id;
    const wasActive = deletedId === currentTrip?.id;
    setDeleting(true);
    try {
      await deleteTrip(deviceId, deletedId);
      setTrips((prev) => prev.filter((t) => t.id !== deletedId));
      setPendingDelete(null);
      if (wasActive) {
        // Active trip changed (or there's none left) — reload so every
        // surface re-reads it, same as switching trips above.
        window.location.reload();
        return;
      }
    } catch (err) {
      console.error("[TripSwitcher] deleteTrip failed", err);
    } finally {
      setDeleting(false);
    }
  }

  const label = currentTrip?.name ?? currentTrip?.destination ?? "Current Trip";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex max-w-full items-center gap-1 text-headline-sm text-primary transition-opacity hover:opacity-80"
        aria-haspopup="dialog"
      >
        <span className="truncate">{label}</span>
        <Icon name="expand_more" size={20} className="shrink-0 text-on-surface-variant" />
      </button>

      <BottomSheet open={open} onClose={() => setOpen(false)} title="Your trips">
        <div className="flex flex-col gap-2">
          {trips.map((trip) => {
            const active = trip.id === currentTrip?.id;
            const dates = tripDates(trip.start_date, trip.end_date);
            return (
              <div
                key={trip.id}
                className={`flex items-center gap-1 rounded-xl border p-1.5 transition-colors ${
                  active
                    ? "border-primary bg-primary-fixed/40"
                    : "border-outline-variant/60 bg-surface-container-lowest hover:bg-surface-container-low"
                }`}
              >
                <button
                  type="button"
                  onClick={() => pick(trip.id)}
                  disabled={switching !== null}
                  aria-current={active ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1.5 text-left disabled:opacity-60"
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                      active ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant"
                    }`}
                  >
                    <Icon name={active ? "luggage" : "location_on"} size={20} filled={active} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-label-lg font-bold text-primary">
                      {trip.name ?? trip.destination ?? "Untitled trip"}
                    </span>
                    <span className="truncate text-label-sm text-on-surface-variant">
                      {[trip.destination, dates].filter(Boolean).join(" • ") || "No details yet"}
                    </span>
                  </span>
                  {switching === trip.id ? (
                    <Icon name="progress_activity" size={20} className="animate-spin text-primary" />
                  ) : active ? (
                    <Icon name="check_circle" size={20} filled className="text-primary" />
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${trip.name ?? trip.destination ?? "trip"}`}
                  onClick={() => setPendingDelete(trip)}
                  disabled={switching !== null}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-error-container hover:text-on-error-container disabled:opacity-40"
                >
                  <Icon name="delete" size={18} />
                </button>
              </div>
            );
          })}

          <Link
            href="/plan/new-trip"
            onClick={() => setOpen(false)}
            className="mt-1 flex items-center gap-3 rounded-xl border border-dashed border-outline-variant p-3 text-left transition-colors hover:bg-surface-container-low"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
              <Icon name="add" size={22} />
            </span>
            <span className="text-label-lg font-bold text-primary">New trip</span>
          </Link>
        </div>
      </BottomSheet>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this trip?"
        description={`This permanently removes "${
          pendingDelete?.name ?? pendingDelete?.destination ?? "this trip"
        }" and its itinerary. This can't be undone.`}
        confirmLabel="Delete trip"
        danger
        busy={deleting}
        onCancel={() => {
          if (!deleting) setPendingDelete(null);
        }}
        onConfirm={handleDelete}
      />
    </>
  );
}

export default TripSwitcher;
