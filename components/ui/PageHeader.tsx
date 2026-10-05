"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icon";

export type PageHeaderProps = {
  title?: ReactNode;
  /** Show a leading back button (defaults to router.back()). */
  showBack?: boolean;
  /** Override the back-button behavior. */
  onBack?: () => void;
  /** Right-aligned action slot (button, avatar, etc). */
  action?: ReactNode;
  /** Center the title instead of left-aligning it. */
  centerTitle?: boolean;
  className?: string;
};

/**
 * Sticky top app bar: optional back button (arrow_back → router.back()),
 * title (left or centered), optional right action slot. `lg:px-8` matches
 * AppHeader's desktop gutters so the two line up with page content.
 */
export function PageHeader({
  title,
  showBack = false,
  onBack,
  action,
  centerTitle = false,
  className = "",
}: PageHeaderProps) {
  const router = useRouter();
  const handleBack = onBack ?? (() => router.back());

  return (
    <header
      className={`sticky top-0 z-40 flex items-center gap-2 bg-background/90 backdrop-blur-sm px-4 min-h-[52px] pt-safe lg:px-8 ${className}`}
    >
      {showBack ? (
        <button
          type="button"
          aria-label="Go back"
          onClick={handleBack}
          className="-ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container-low"
        >
          <Icon name="arrow_back" />
        </button>
      ) : null}
      {title ? (
        <h1
          className={`text-headline-sm text-primary truncate ${
            centerTitle ? "flex-1 text-center" : "flex-1"
          }`}
        >
          {title}
        </h1>
      ) : (
        <div className="flex-1" />
      )}
      {/* Balance the layout when back + centered title are both present */}
      {centerTitle && showBack && !action ? <div className="h-10 w-10 shrink-0" /> : null}
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export default PageHeader;
