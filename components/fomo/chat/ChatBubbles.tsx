import { FomoFace, type FomoMood } from "@/components/onboarding/Characters";
import type { SeedAttachment } from "@/lib/fomo-chat/useFomoChat";
import { renderInlineMarkdown } from "./markdown";
import { SeedCard } from "./SeedCard";

/** Fomo's face beside its replies; "hmm" while a reply is still coming. */
export function FomoAvatar({ mood = "grin" }: { mood?: FomoMood }) {
  return <FomoFace mood={mood} className="mb-1 h-8 w-8 shrink-0 drop-shadow-sm" />;
}

/** Three-dot "thinking" indicator shown while a reply is streaming but no text has arrived yet. */
export function ThinkingDots({ label }: { label?: string | null }) {
  return (
    <div
      role="status"
      aria-label={label ?? "Fomo is thinking"}
      className="flex items-center gap-1 rounded-xl rounded-tl-sm border border-outline-variant/50 bg-surface px-5 py-4 shadow-[0_1px_3px_rgba(3,22,50,0.05)]"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-outline motion-reduce:animate-none"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
      {label ? <span className="ml-2 text-label-md text-on-surface-variant">{label}</span> : null}
    </div>
  );
}

export function UserBubble({ text, seed }: { text: string; seed?: SeedAttachment }) {
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
      {/* Compact attachment chip for the item this turn was asked about — only on the turn that carries it (see `pendingSeed`/`send`). */}
      {seed ? <SeedCard seed={seed} compact className="w-full max-w-[220px]" /> : null}
      <div className="rounded-xl rounded-tr-sm bg-primary px-5 py-3 text-on-primary shadow-sm">
        {/* ph-mask: PostHog session replay masks text inside this class by
            default (maskTextClass, posthog-js) — a user's own chat message
            is free-text and must never render as plain text in a replay.
            See instrumentation-client.ts's session_recording doc comment. */}
        <p className="ph-mask whitespace-pre-wrap text-body-md">{renderInlineMarkdown(text)}</p>
      </div>
    </div>
  );
}
