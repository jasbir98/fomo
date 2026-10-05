import type { MouseEvent, ReactNode } from "react";
import type { AiReplyBlock } from "@/lib/fomo-ai";
import { FomoAvatar } from "./ChatBubbles";
import { renderInlineMarkdown } from "./markdown";
import { ChatItemCard, ChatPlaceCard, itemResultKey, placeDisclosure, placeResultKey } from "./ResultCards";

export function AssistantTurn({
  messageId,
  blocks,
  onQuickReply,
  onItemHover,
  highlightedKey = null,
  onItemClick,
  footer,
}: {
  messageId: string;
  blocks: AiReplyBlock[];
  onQuickReply: (option: string) => void;
  /** Desktop only: called with a result card's key on pointer enter, `null` on leave. */
  onItemHover?: (key: string | null) => void;
  /** Desktop only: key of the card to ring (see `itemResultKey` / `placeResultKey`). */
  highlightedKey?: string | null;
  /** Desktop only: called when a catalogue item card is clicked, before the link navigates. */
  onItemClick?: (href: string, e: MouseEvent<HTMLAnchorElement>) => void;
  /** Desktop only: rendered after the last block (e.g. a "Show on map" chip). */
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        const key = `${messageId}:${i}`;
        if (block.kind === "text") {
          return (
            <div key={key} className="flex max-w-[90%] items-end gap-2 self-start">
              <FomoAvatar />
              <div className="rounded-xl rounded-tl-sm border border-outline-variant/50 bg-surface px-5 py-4 text-on-surface shadow-[0_1px_3px_rgba(3,22,50,0.05)]">
                {/* ph-mask: see UserBubble's matching comment above — the
                    assistant's reply text is generated from (and can quote)
                    the user's own message, so it's masked the same way. */}
                <p className="ph-mask whitespace-pre-wrap text-body-md">{renderInlineMarkdown(block.text)}</p>
              </div>
            </div>
          );
        }
        if (block.kind === "items") {
          return (
            <div key={key} className="ml-10 flex max-w-[400px] flex-col gap-2 self-stretch">
              {block.reason ? <p className="px-1 text-label-sm italic text-on-surface-variant">{block.reason}</p> : null}
              {block.items.map((item) => (
                <ChatItemCard
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  onHover={onItemHover}
                  highlighted={highlightedKey === itemResultKey(item)}
                  onItemClick={onItemClick}
                />
              ))}
            </div>
          );
        }
        if (block.kind === "places") {
          return (
            <div key={key} className="ml-10 flex max-w-[400px] flex-col gap-2 self-stretch">
              {block.reason ? <p className="px-1 text-label-sm italic text-on-surface-variant">{block.reason}</p> : null}
              {block.places.map((place) => (
                <ChatPlaceCard
                  key={place.id}
                  place={place}
                  onHover={onItemHover}
                  highlighted={highlightedKey === placeResultKey(place)}
                />
              ))}
              {/* Google requires this attribution, and the disclosure for any summary shown. */}
              <p className="px-1 text-label-sm text-on-surface-variant">
                Results from {block.attribution}
                {block.places.some((p) => p.summary) ? ` · ${placeDisclosure(block.places)}` : ""}
              </p>
            </div>
          );
        }
        if (block.kind === "quick_replies") {
          return (
            <div key={key} className="ml-10 flex w-full max-w-[400px] flex-col gap-1.5 self-start">
              <p className="px-1 text-label-sm font-medium text-on-surface-variant">
                {block.quick_replies.prompt ?? "Try one of these:"}
              </p>
              <div className="flex flex-wrap gap-2">
                {block.quick_replies.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onQuickReply(option)}
                    className="whitespace-nowrap rounded-full border border-outline-variant/60 bg-surface px-4 py-2 text-label-sm font-semibold text-on-surface-variant transition-colors hover:bg-surface-container"
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          );
        }
        if (block.kind === "rich_card") {
          // Trip-era history: show the name and text only — the photo and
          // rating on these cards were model-generated, not real.
          return (
            <div
              key={key}
              className="ml-10 max-w-[340px] self-start rounded-xl border border-outline-variant/50 bg-surface-container-lowest px-4 py-3"
            >
              <p className="text-label-md font-bold text-on-surface">{block.card.name}</p>
              {block.card.description ? (
                <p className="mt-0.5 line-clamp-2 text-label-sm text-on-surface-variant">{block.card.description}</p>
              ) : null}
            </div>
          );
        }
        // Trip-era itinerary proposals have nothing to act on any more.
        return null;
      })}
      {footer}
    </div>
  );
}
