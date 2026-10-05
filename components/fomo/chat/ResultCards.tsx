import type { MouseEvent } from "react";
import Link from "next/link";
import { Icon, SmartImage } from "@/components/ui";
import type { ChatItem, ChatPlace } from "@/lib/fomo-ai";

/** Hover/highlight wiring the desktop workspace layers on; every field is optional and mobile passes none. */
export interface ResultCardInteraction {
  /** Called with this card's key on pointer enter and `null` on leave. */
  onHover?: (key: string | null) => void;
  /** True when this card's key is the highlighted one (e.g. its map marker is hovered). */
  highlighted?: boolean;
}

/** Key a catalogue item card is hovered/highlighted by (and carries as `data-result-key`). */
export function itemResultKey(item: ChatItem): string {
  return `item:${item.kind}:${item.id}`;
}

/** Key a Google place card is hovered/highlighted by (and carries as `data-result-key`). */
export function placeResultKey(place: ChatPlace): string {
  return `place:${place.id}`;
}

/** A real catalogue item the reply pointed at — links to its own page. */
export function ChatItemCard({
  item,
  onHover,
  highlighted = false,
  onItemClick,
}: { item: ChatItem; onItemClick?: (href: string, e: MouseEvent<HTMLAnchorElement>) => void } & ResultCardInteraction) {
  const key = itemResultKey(item);
  const base =
    "flex items-center gap-3 rounded-xl border border-outline-variant/50 bg-surface-container-lowest p-2.5 shadow-[0_1px_3px_rgba(3,22,50,0.05)] transition-colors hover:bg-surface-container-low";
  return (
    <Link
      href={item.href}
      data-result-key={key}
      onClick={onItemClick ? (e) => onItemClick(item.href, e) : undefined}
      onMouseEnter={onHover ? () => onHover(key) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      className={highlighted ? `${base} ring-2 ring-primary` : base}
    >
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-surface-container">
        <SmartImage src={item.image_url} alt="" width={56} height={56} className="h-full w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-label-md font-bold text-on-surface">{item.title}</p>
        {item.subtitle ? <p className="truncate text-label-sm text-on-surface-variant">{item.subtitle}</p> : null}
      </div>
      {item.badge ? (
        <span className="shrink-0 rounded-full bg-surface-container px-2.5 py-1 text-label-sm font-extrabold text-primary">
          {item.badge}
        </span>
      ) : null}
      <Icon name="chevron_right" size={18} className="shrink-0 text-on-surface-variant" />
    </Link>
  );
}

const FOOD_TYPE = /restaurant|cafe|café|coffee|takeout|takeaway|bakery|food|diner|bistro|eatery|pizza|brunch|dessert|ice cream|sandwich|deli|curry|noodle|sushi|kebab|chippy|fish and chips/i;

/** "4.5 (1.2k)" style rating text; null when Google gave no rating. */
function ratingText(place: ChatPlace): string | null {
  if (place.rating === null) return null;
  const count = place.ratingCount;
  const countText =
    count === null ? "" : ` (${count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k` : count})`;
  return `★ ${place.rating.toFixed(1)}${countText}`;
}

/** The disclosure Google attaches to its summaries (the first one present). */
export function placeDisclosure(places: ChatPlace[]): string {
  return places.find((p) => p.summary && p.summaryDisclosure)?.summaryDisclosure ?? "Summarized with Gemini";
}

/** A Google Maps venue the reply pointed at — opens its Maps page in a new tab. */
export function ChatPlaceCard({ place, onHover, highlighted = false }: { place: ChatPlace } & ResultCardInteraction) {
  const key = placeResultKey(place);
  const facts = [
    ratingText(place),
    place.priceText,
    place.openNow === true ? "Open now" : place.openNow === false ? "Closed now" : null,
  ].filter(Boolean);
  const body = (
    <>
      <div
        className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-lg ${
          place.type && FOOD_TYPE.test(place.type) ? "bg-secondary-container/60 text-on-secondary-container" : "bg-primary-fixed text-primary"
        }`}
      >
        <Icon name={place.type && FOOD_TYPE.test(place.type) ? "restaurant" : "place"} size={24} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-label-md font-bold text-on-surface">{place.name}</p>
        {facts.length > 0 ? <p className="text-label-sm text-on-surface-variant">{facts.join(" · ")}</p> : null}
        {place.summary ? <p className="line-clamp-2 text-label-sm text-on-surface-variant">{place.summary}</p> : null}
      </div>
      <Icon name="open_in_new" size={18} className="shrink-0 text-on-surface-variant" />
    </>
  );
  const base =
    "flex items-center gap-3 rounded-xl border border-outline-variant/50 bg-surface-container-lowest p-2.5 shadow-[0_1px_3px_rgba(3,22,50,0.05)] transition-colors hover:bg-surface-container-low";
  const className = highlighted ? `${base} ring-2 ring-primary` : base;
  const hoverProps = {
    "data-result-key": key,
    onMouseEnter: onHover ? () => onHover(key) : undefined,
    onMouseLeave: onHover ? () => onHover(null) : undefined,
  };
  if (!place.mapsUrl)
    return (
      <div className={className} {...hoverProps}>
        {body}
      </div>
    );
  return (
    <a href={place.mapsUrl} target="_blank" rel="noopener noreferrer" className={className} {...hoverProps}>
      {body}
    </a>
  );
}
