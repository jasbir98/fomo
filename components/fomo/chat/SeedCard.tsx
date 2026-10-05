import Link from "next/link";
import { Icon } from "@/components/ui";
import { hrefForSeed, type ChatSeed } from "@/lib/chat-seed";
import type { SeedAttachment } from "@/lib/fomo-chat/useFomoChat";

const SEED_ICON: Partial<Record<ChatSeed["type"], string>> = {
  happening: "sell",
  event: "event",
};

/**
 * The "what is this conversation about" card — used both as the pending
 * context divider (full size, centered) and as the compact chip attached
 * above a user bubble once the seed has been sent (see `UserBubble`). Tap
 * target is the item's own detail page when `hrefForSeed` can derive one
 * reliably for this type; otherwise it's inert (no href to guess at).
 */
export function SeedCard({
  seed,
  compact = false,
  className = "",
}: {
  seed: SeedAttachment;
  compact?: boolean;
  className?: string;
}) {
  const href = hrefForSeed(seed);
  const content = (
    <div
      className={`flex items-center gap-2.5 rounded-xl border border-outline-variant/60 bg-surface-container-lowest ${compact ? "p-2" : "p-2.5"} ${className}`}
    >
      <div
        className={`flex shrink-0 items-center justify-center rounded-lg bg-primary-fixed text-primary ${compact ? "h-7 w-7" : "h-9 w-9"}`}
      >
        <Icon name={SEED_ICON[seed.type] ?? "location_on"} size={compact ? 15 : 18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-label-md font-bold text-primary">{seed.name}</p>
        {seed.city ? <p className="truncate text-label-sm text-on-surface-variant">{seed.city}</p> : null}
      </div>
    </div>
  );
  if (!href) return content;
  return (
    <Link href={href} className="block transition-opacity hover:opacity-80">
      {content}
    </Link>
  );
}
