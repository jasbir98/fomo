import type { Place } from "@/lib/types";

/** A place the owner has approved as "Under the radar". `radar_why` is always a non-empty line here. */
export type RadarPick = Place & {
  radar_why: string;
  radar_picked_at: string;
};

export const RADAR_NAME = "Under the radar";
export const RADAR_PATH = "/under-the-radar";
/** Longest reason line `scripts/radar.ts` accepts without a warning. */
export const RADAR_WHY_MAX_CHARS = 110;
