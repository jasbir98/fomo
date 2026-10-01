"use client";

import type { ExploreLayer } from "@/lib/explore/types";
import { LAYER_PIN_TYPES, PIN_TYPE_STYLE } from "@/lib/explore/pin-style";
import { Icon } from "@/components/ui";

const LAYER_OPTIONS: { value: ExploreLayer; label: string; icon?: string }[] = [
  { value: "everything", label: "All" },
  { value: "places", label: "Places", icon: PIN_TYPE_STYLE.place.icon },
  { value: "deals", label: "Deals", icon: PIN_TYPE_STYLE.deal.icon },
  { value: "events", label: "Events", icon: PIN_TYPE_STYLE.event.icon },
  { value: "free", label: "Free", icon: PIN_TYPE_STYLE.free.icon },
];

export interface LayerSwitchProps {
  value: ExploreLayer;
  onChange: (layer: ExploreLayer) => void;
}

/**
 * The "All · Places · Deals · Events · Free" map layer control, plus a
 * small colour-swatch legend underneath naming whichever pin type(s) the
 * current layer shows — same colours `MapCanvas` paints its markers with
 * (`PIN_TYPE_STYLE`), so the legend and the map never disagree.
 *
 * Five equal-width segments that always fit the row (no horizontal scroll):
 * icons are dropped below 480px (phones) and labels truncate as a last resort.
 */
export function LayerSwitch({ value, onChange }: LayerSwitchProps) {
  const legendTypes = LAYER_PIN_TYPES[value];
  return (
    <div className="flex flex-col gap-2">
      <div role="tablist" className="flex items-center gap-0.5 rounded-full bg-surface-container p-1">
        {LAYER_OPTIONS.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(opt.value)}
              className={`inline-flex min-h-10 min-w-0 flex-1 items-center justify-center gap-1 rounded-full px-1.5 text-label-md font-medium transition-colors duration-200 ${
                active ? "bg-primary text-on-primary shadow-sm" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {/* Wrapped: Icon sets its own inline display, which beats a utility class on it. */}
              {opt.icon ? (
                <span className="shrink-0 max-[479px]:hidden">
                  <Icon name={opt.icon} size={16} filled={active} />
                </span>
              ) : null}
              <span className="truncate">{opt.label}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        {legendTypes.map((type) => (
          <span key={type} className="flex items-center gap-1.5 text-label-sm text-on-surface-variant">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-full border border-white shadow-sm"
              style={{ backgroundColor: PIN_TYPE_STYLE[type].color }}
            />
            {PIN_TYPE_STYLE[type].label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default LayerSwitch;
