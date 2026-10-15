"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Icon, PageHeader } from "@/components/ui";
import { closeDetail } from "@/lib/detail-overlay/store";
import type { ListPage } from "@/lib/seo/breadcrumbs";

/**
 * How a detail renders: `page` is the real route (phone UI below lg, two-column
 * page at lg); `modal` is the desktop overlay (components/detail/
 * DetailOverlayProvider.tsx), which only ever exists at lg and up.
 */
export type DetailPresentation = "page" | "modal";

export interface DetailProps {
  id: string;
  presentation?: DetailPresentation;
}

/**
 * Top bar for every state of a detail (loading, error, not found, loaded).
 * Page: the app's sticky PageHeader with its back button. Modal: a sticky bar
 * inside the dialog with the title, the same actions, and a close X — the
 * PageHeader's back button calls router.back(), which isn't what a modal wants.
 */
export function DetailTopBar({
  presentation,
  title,
  action,
}: {
  presentation: DetailPresentation;
  title?: ReactNode;
  action?: ReactNode;
}) {
  if (presentation === "page") return <PageHeader title={title} showBack action={action} />;
  return (
    <header className="sticky top-0 z-40 flex min-h-14 items-center gap-2 border-b border-hairline bg-background/95 pl-6 pr-3 backdrop-blur-sm">
      {title ? (
        <h2 className="flex-1 truncate text-headline-sm text-primary">{title}</h2>
      ) : (
        <div className="flex-1" />
      )}
      {action ? <div className="shrink-0">{action}</div> : null}
      <button
        type="button"
        aria-label="Close"
        onClick={closeDetail}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
      >
        <Icon name="close" />
      </button>
    </header>
  );
}

/**
 * The two-column grid wrapper. Below lg it is `display: contents`, so its
 * children (hero, content, aside) are direct flex items of the page root —
 * exactly the phone DOM layout from before the desktop work. At lg it becomes
 * a 12-column grid: hero + content in cols 1-7, the aside in cols 8-12.
 * The `1fr` second row soaks up any extra height so a tall aside never opens
 * a gap between the hero and the content cards.
 */
export function detailGridClass(presentation: DetailPresentation): string {
  return `contents lg:grid lg:grid-cols-12 lg:grid-rows-[auto_1fr] lg:gap-x-8 lg:gap-y-4 ${
    presentation === "modal" ? "lg:px-6" : "lg:mx-auto lg:w-full lg:max-w-[1200px] lg:px-8"
  }`;
}

/** Hero section: full-bleed 256px on phones; a rounded 360px tile in the left column at lg. */
export const DETAIL_HERO_CLASS =
  "relative h-64 w-full overflow-hidden lg:col-span-7 lg:h-[360px] lg:rounded-xl";

/** Content-card column: phone gutters below lg, the left column (no extra gutter) at lg. */
export const DETAIL_CONTENT_CLASS = "flex flex-col gap-4 px-4 lg:col-span-7 lg:px-0";

/**
 * The mobile sticky bottom CTA bar, with lg overrides that turn it into a
 * plain static block so the same single element sits inside the aside.
 */
export const DETAIL_CTA_BAR_CLASS =
  "sticky bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 flex flex-col gap-2 border-t border-outline-variant/40 bg-surface-container-lowest/95 px-4 py-4 backdrop-blur-md shadow-[0_-4px_16px_rgba(3,22,50,0.08)] lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-none";

/** A card that exists only in the desktop aside (the phone layout has its own equivalent). */
export const ASIDE_CARD_CLASS = "hidden rounded-2xl bg-surface-container-lowest p-5 shadow-level-1 lg:block";

/**
 * Right-hand aside. Below lg it is `display: contents` and adds nothing: the
 * CTA bar inside it stays a direct child of the page root, sticky to the
 * bottom as before, and the `hidden lg:block` cards inside it stay hidden.
 * At lg it is a sticky column (cols 8-12, spanning both grid rows) that holds
 * the summary, the CTA group, the When card and the location tile.
 */
export function DetailAside({ presentation, children }: { presentation: DetailPresentation; children: ReactNode }) {
  // Page: sits under the sticky top bar. Modal: under the dialog's own 56px bar.
  const stick =
    presentation === "modal"
      ? "lg:top-[72px] lg:max-h-[calc(100dvh-48px-72px-16px)]"
      : "lg:top-[calc(var(--topbar-h)+16px)] lg:max-h-[calc(100dvh-var(--topbar-h)-32px)]";
  return (
    <div
      className={`contents lg:-m-1 lg:flex lg:flex-col lg:gap-4 lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1 lg:self-start lg:overflow-y-auto lg:p-1 lg:sticky ${stick}`}
    >
      {children}
    </div>
  );
}

/**
 * "More in What's on": a plain link from a detail page up to the list it
 * belongs under. The same list is the page's BreadcrumbList parent
 * (lib/seo/breadcrumbs.ts), so crawlers and people see one hierarchy.
 */
export function MoreInLink({ list }: { list: ListPage }) {
  return (
    <Link
      href={list.path}
      className="inline-flex min-h-11 items-center gap-1 self-start text-label-md font-semibold text-secondary"
    >
      More in {list.name}
      <Icon name="arrow_forward" size={16} />
    </Link>
  );
}
