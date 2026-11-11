import Link from "next/link";
import { Icon } from "@/components/ui";
import { RADAR_NAME, RADAR_PATH } from "@/lib/radar/types";

/**
 * "Under the radar" badge plus the one-line reason, for an approved pick.
 * Renders nothing without a reason, so a place with no pick (or a database
 * that has not run supabase/add_place_radar.sql) shows no trace of it.
 */
export function RadarBadge({ why }: { why: string | null | undefined }) {
  const line = why?.trim();
  if (!line) return null;
  return (
    <div className="mb-4 flex flex-col gap-1.5 rounded-xl bg-primary-container/60 px-4 py-3">
      <Link
        href={RADAR_PATH}
        className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-label-sm font-semibold text-on-primary"
      >
        <Icon name="explore" size={14} />
        {RADAR_NAME}
      </Link>
      <p className="text-body-md text-on-surface">{line}</p>
    </div>
  );
}
