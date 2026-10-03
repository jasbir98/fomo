"use client";

import { Icon } from "@/components/ui";
import { buildSearchMapUrl } from "@/lib/maps/links";
import type { ExplorePlaceCard } from "@/lib/explore/useExploreState";

/**
 * Loading / no-matches feedback floating over the map — offset below
 * MapStage's own "Search this area" pill (same top-centre slot) so the two
 * never overlap when both are showing. Shared by the phone page and the
 * desktop workspace.
 */
export function MapStatusPill({ loading, onWiden }: { loading: boolean; onWiden: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-surface-container-lowest/95 px-4 py-2 text-label-md text-on-surface shadow-lg backdrop-blur-sm">
        {loading ? (
          <>
            <Icon name="progress_activity" size={16} className="animate-spin text-primary" />
            <span>Loading…</span>
          </>
        ) : (
          <>
            <Icon name="search_off" size={16} className="text-on-surface-variant" />
            <span>No matches here</span>
            <button type="button" onClick={onWiden} className="font-semibold text-primary hover:underline">
              Widen search
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The small dismissible card for a fresh Google search pick (no Fomo pin, so no detail page). */
export function PlaceCardOverlay({ card, onDismiss }: { card: ExplorePlaceCard; onDismiss: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-3 shadow-lg">
        <Icon name="place" size={20} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-label-lg font-semibold text-on-surface">{card.name ?? "Unnamed place"}</p>
          {card.address ? <p className="truncate text-label-sm text-on-surface-variant">{card.address}</p> : null}
          <a
            href={buildSearchMapUrl(card.address ?? card.name ?? `${card.lat},${card.lng}`)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-label-sm font-semibold text-primary hover:underline"
          >
            Open in Google Maps
            <Icon name="open_in_new" size={14} />
          </a>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="shrink-0 text-on-surface-variant transition-colors hover:text-primary"
        >
          <Icon name="close" size={18} />
        </button>
      </div>
    </div>
  );
}
