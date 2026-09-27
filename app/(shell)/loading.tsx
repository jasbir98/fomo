import { FomoLoader } from "@/components/ui";

/**
 * Route-level loading UI for every page under the `(shell)` group — Next.js
 * renders this automatically while a segment's own page (or a layout above
 * it) suspends, e.g. on first navigation into the group before any page's
 * own client-side data fetch has even mounted. Individual pages still own
 * their own in-page loading states (skeleton rows, FomoLoader on a detail
 * page) for the fetch *they* kick off after mounting — this only covers the
 * gap before that.
 */
export default function ShellLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <FomoLoader />
    </div>
  );
}
