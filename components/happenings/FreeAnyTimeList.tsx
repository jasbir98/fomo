"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon, NavCard, SeeAllButton, SmartImage } from "@/components/ui";
import { categoryDefaultImage } from "@/lib/happenings/category-style";
import { PriceTag } from "@/components/happenings/PriceTag";
import type { PriceLabel } from "@/lib/happenings/price-label";
import type { FreeAnyTimeItem } from "@/lib/happenings/feed-types";

/** Every row in this zone is free by construction (see the route's
 *  `buildFreeAnyTime` — a `kind: "happening"` `recurrence: {type:"always"}`
 *  catalog row, or a live `places` row with `price_level === 0`), so there's
 *  no `is_free` field to read off `FreeAnyTimeItem` — this is the one fixed
 *  price label every row shares, routed through the same `PriceTag` every
 *  other card uses rather than a bespoke span. */
const FREE_LABEL: PriceLabel = { text: "FREE", kind: "free" };

export interface FreeAnyTimeListProps {
  items: FreeAnyTimeItem[];
}

/** Cards shown on Home before the "See all" link takes over — matches the
 *  SECTION_CAP other Home sections use (app/(shell)/page.tsx); this zone
 *  used to show its first 6 (and, before that, its full — sometimes 60+ —
 *  list), which was exactly the "too much outside" noise the Home
 *  decluttering pass called out. The full list, with its own filters, now
 *  lives at /free (app/(shell)/free/page.tsx). */
const INITIAL_COUNT = 5;

/** Exported so /free can reuse the exact same row rendering for its full,
 *  filtered list instead of duplicating this markup. */
export function FreeAnyTimeRow({ item }: { item: FreeAnyTimeItem }) {
  const [imgError, setImgError] = useState(false);
  const showImage = item.imageUrl && !imgError;
  const href = item.kind === "happening" ? `/happening/${item.id}` : `/place/${item.id}`;

  return (
    <NavCard
      href={href}
      ariaLabel={item.name}
      className="flex cursor-pointer items-center gap-3.5 rounded-2xl bg-surface-container-lowest p-3.5 shadow-level-1 transition-shadow hover:shadow-level-2"
    >
      <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-hairline bg-surface-container">
        {showImage ? (
          <SmartImage
            src={item.imageUrl}
            alt=""
            width={64}
            height={64}
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : item.category ? (
          <SmartImage
            src={categoryDefaultImage(item.category)}
            alt=""
            width={64}
            height={64}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Icon name="location_on" size={22} className="text-outline" />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="mb-0.5 flex items-center justify-between gap-1">
          <h5 className="truncate text-label-lg font-bold text-on-surface">{item.name}</h5>
          <PriceTag label={FREE_LABEL} variant="compact" />
        </div>
        {item.description ? (
          <p className="line-clamp-1 text-label-sm text-on-surface-variant">{item.description}</p>
        ) : null}
        {item.locationLine ? (
          <span className="mt-1 flex items-center gap-0.5 truncate text-label-sm text-on-surface-variant">
            <Icon name="location_on" size={13} className="shrink-0 text-secondary" />
            <span className="truncate">{item.locationLine}</span>
          </span>
        ) : null}
      </div>
    </NavCard>
  );
}

/**
 * The trailing "Free any time" zone — thumbnail rows for things that are
 * free every day, not tied to any date bucket (permanently-free happenings
 * plus free, `price_level === 0` live `places` rows — see
 * app/api/feed/route.ts's `buildFreeAnyTime`). No save button per row: a
 * `place` item could wire into the existing save flow, but a mixed
 * happening/place list would need a per-row subject-type branch for a zone
 * the mockup itself doesn't put a bookmark on, so this stays read-only.
 *
 * Home only ever shows its first INITIAL_COUNT rows plus a "See all" link to
 * /free (its own page, with its own type/area filters and an Ask Fomo
 * button) — replaces the old in-place "Show all N" expander per the Home
 * declutter follow-up ("give Book early / Free any time their own pages
 * instead of growing Home in place").
 */
export function FreeAnyTimeList({ items }: FreeAnyTimeListProps) {
  if (items.length === 0) return null;

  const visible = items.slice(0, INITIAL_COUNT);

  return (
    <section className="flex flex-col gap-3 pt-2">
      <div className="flex items-start justify-between gap-2 px-1">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Icon name="all_inclusive" size={20} className="text-accent" />
            <h3 className="text-headline-sm font-extrabold tracking-tight text-on-surface">Free any time</h3>
          </div>
          <p className="text-label-sm text-on-surface-variant">Edinburgh classics with £0 admission</p>
        </div>
        <Link
          href="/free"
          className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-container-lowest/80 px-2.5 py-1 text-label-sm font-semibold text-primary backdrop-blur-sm transition-opacity hover:opacity-80"
        >
          See all
          <Icon name="chevron_right" size={16} />
        </Link>
      </div>

      <div className="flex flex-col gap-2.5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4">
        {visible.map((item) => (
          <FreeAnyTimeRow key={`${item.kind}-${item.id}`} item={item} />
        ))}
      </div>

      <SeeAllButton href="/free" total={items.length} shown={INITIAL_COUNT} />
    </section>
  );
}

export default FreeAnyTimeList;
