"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

const noopSubscribe = () => () => {};
/** SSR-safe "are we on the client, past hydration" check without a setState-in-effect. */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Accessible name for the dialog when `title` isn't a plain string (or is absent) — falls back to "Dialog". Ignored when `title` is a string, which is used directly via aria-labelledby. */
  ariaLabel?: string;
};

/**
 * Slide-up bottom modal sheet with backdrop + drag-handle affordance.
 * Stays within the max-w-[480px] phone column. Esc / backdrop click closes.
 *
 * Portals to document.body: `position: fixed` is scoped to the nearest
 * ancestor with a transform/filter/backdrop-filter (a CSS containing-block
 * rule, not a bug in this component) — several of this app's sticky headers
 * use `backdrop-blur`, and a caller invoking this sheet from inside one of
 * those (e.g. TripSwitcher rendering it inside its header) would otherwise
 * get the "fixed" overlay pinned to the header's own small box instead of
 * the viewport. Portaling sidesteps that regardless of call site.
 */
export function BottomSheet({ open, onClose, title, children, className = "", ariaLabel }: BottomSheetProps) {
  const mounted = useMounted();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleIsString = typeof title === "string";

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open — restores whatever inline value (if any)
  // was there before, so this nests harmlessly if something else also sets it.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Focus trap: move focus into the panel on open, cycle Tab/Shift+Tab
  // within it, and hand focus back out on close.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusables()[0];
    (first ?? panel).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    panel.addEventListener("keydown", onKeyDown);
    return () => {
      panel.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[60] flex items-end justify-center transition-opacity duration-200 motion-reduce:transition-none ${
        open ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        tabIndex={open ? 0 : -1}
        onClick={onClose}
        className="absolute inset-0 bg-primary/40 backdrop-blur-[2px]"
      />
      {/* Sheet */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleIsString ? titleId : undefined}
        aria-label={!titleIsString ? (ariaLabel ?? "Dialog") : undefined}
        tabIndex={-1}
        className={`relative flex max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] w-full max-w-[480px] flex-col rounded-t-xl bg-surface-container-lowest shadow-[0_-8px_32px_rgba(3,22,50,0.18)] transition-transform duration-300 motion-reduce:transition-none focus:outline-none ${
          open ? "translate-y-0" : "translate-y-full"
        } ${className}`}
      >
        <div className="flex shrink-0 justify-center pt-3 pb-1">
          <span className="h-1.5 w-10 rounded-full bg-outline-variant" aria-hidden="true" />
        </div>
        {title ? (
          <h2 id={titleIsString ? titleId : undefined} className="shrink-0 px-4 pb-2 pt-1 text-headline-sm text-on-surface">
            {title}
          </h2>
        ) : null}
        {/* Only this body scrolls; handle + title stay pinned. Body scroll on the page is
            locked while open, so without an inner scroller tall sheets spilled off
            the top of short phones. Bottom safe-area lives here so the last
            control clears the home indicator when scrolled to the end. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}

export default BottomSheet;
