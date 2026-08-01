"use client";

import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
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

export type BottomSheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
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
export function BottomSheet({ open, onClose, title, children, className = "" }: BottomSheetProps) {
  const mounted = useMounted();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[60] flex items-end justify-center transition-opacity duration-200 ${
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
        role="dialog"
        aria-modal="true"
        className={`relative w-full max-w-[480px] rounded-t-xl bg-surface-container-lowest pb-safe shadow-[0_-8px_32px_rgba(3,22,50,0.18)] transition-transform duration-300 ${
          open ? "translate-y-0" : "translate-y-full"
        } ${className}`}
      >
        <div className="flex justify-center pt-3 pb-1">
          <span className="h-1.5 w-10 rounded-full bg-outline-variant" aria-hidden="true" />
        </div>
        {title ? (
          <h2 className="px-5 pb-2 pt-1 text-headline-sm text-on-surface">{title}</h2>
        ) : null}
        <div className="px-5 pb-5 pt-2">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export default BottomSheet;
