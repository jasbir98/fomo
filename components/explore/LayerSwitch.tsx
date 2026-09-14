"use client";

import type { ExploreLayer } from "@/lib/explore/types";
import { LAYER_PIN_TYPES, PIN_TYPE_STYLE } from "@/lib/explore/pin-style";
import { SegmentedControl, type SegmentOption } from "@/components/ui";

const LAYER_OPTIONS: SegmentOption<ExploreLayer>[] = [
  { value: "everything", label: "Everything" },
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
 * The "Everything · Places · Deals · Events · Free" map layer control, plus a
 * small colour-swatch legend underneath naming whichever pin type(s) the
 * current layer shows — same colours `MapCanvas` paints its markers with
 * (`PIN_TYPE_STYLE`), so the legend and the map never disagree.
 */
export function LayerSwitch({ value, onChange }: LayerSwitchProps) {
  const legendTypes = LAYER_PIN_TYPES[value];
  return (
    <div className="flex flex-col gap-2">
      <div className="-mx-5 overflow-x-auto px-5 [&::-webkit-scrollbar]:hidden">
        <SegmentedControl value={value} options={LAYER_OPTIONS} onChange={onChange} />
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
