import { FomoBuddy, type FomoMood, type FomoPose } from "@/components/onboarding/Characters";

export type FomoSpotProps = {
  mood?: FomoMood;
  pose?: FomoPose;
  /** Size it here (e.g. "h-24 w-24"); the art keeps its aspect ratio inside. */
  className?: string;
};

/**
 * Small full-body Fomo with a floor shadow and a gentle float — the in-app
 * spot illustration for empty, error and offline states, so "nothing here"
 * reads as Fomo shrugging rather than a grey system icon. Decorative only:
 * the state's own copy carries the meaning.
 */
export function FomoSpot({ mood = "meh", pose = "shrug", className = "h-24 w-24" }: FomoSpotProps) {
  return (
    <svg viewBox="-80 -72 160 150" className={`shrink-0 ${className}`} aria-hidden="true">
      <ellipse cx={0} cy={70} rx={34} ry={5} fill="#1b365d" opacity={0.1} />
      <g className="fomo-float">
        <FomoBuddy mood={mood} pose={pose} />
      </g>
    </svg>
  );
}

export default FomoSpot;
