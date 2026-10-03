"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useFocusTrap } from "@/components/ui/useFocusTrap";
import {
  DESKTOP_MEDIA_QUERY,
  closeDetail,
  parseDetailHref,
  resetDetail,
  setDetailOverlayEnabled,
  syncDetailFromHistory,
  tryOpenDetail,
  useDetailOverlay,
  type DetailKind,
} from "@/lib/detail-overlay/store";
import { HappeningDetail } from "./HappeningDetail";
import { EventDetail } from "./EventDetail";
import { PlaceDetail } from "./PlaceDetail";

const noopSubscribe = () => () => {};
/** SSR-safe "past hydration" check (same trick as BottomSheet) so the portal never renders on the server. */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
}

const DIALOG_LABEL: Record<DetailKind, string> = {
  happening: "Deal details",
  event: "Event details",
  place: "Place details",
};

function pathOf(href: string): string {
  return href.split(/[?#]/)[0].replace(/\/$/, "");
}

/**
 * Desktop detail modal. Mounted once in AppShell. Wires the store in
 * lib/detail-overlay/store.ts to the page: enables it, listens for Back/Forward,
 * turns plain clicks on detail links into overlay opens, closes the overlay if
 * the app navigates elsewhere underneath it, and renders the dialog.
 */
export function DetailOverlayProvider() {
  const { target } = useDetailOverlay();
  const pathname = usePathname();
  const mounted = useMounted();
  const panelRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef(target);

  useEffect(() => {
    setDetailOverlayEnabled(true);
    return () => setDetailOverlayEnabled(false);
  }, []);

  useEffect(() => {
    window.addEventListener("popstate", syncDetailFromHistory);
    return () => window.removeEventListener("popstate", syncDetailFromHistory);
  }, []);

  // Capture-phase so it sees the click before next/link does. Only
  // preventDefault (never stopPropagation): next/link's onClick bails when
  // `defaultPrevented`, but cards' own onClick handlers on the same anchor
  // (preview-cache writes, `card_opened` analytics) must still run.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;
      const href = anchor.href;
      if (!parseDetailHref(href)) return;
      if (tryOpenDetail(href)) e.preventDefault();
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // The overlay is desktop-only: if the window shrinks below lg while it's
  // open, close it (pops our history entries) rather than rendering the phone
  // layout inside a dialog.
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const onChange = () => {
      if (!mq.matches) closeDetail();
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Keep the latest target readable from the pathname effect below without
  // making that effect re-run when the target changes: right after
  // tryOpenDetail pushes, our target is new but Next's pathname hasn't caught
  // up yet, and that transient mismatch must not read as "navigated away".
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  // The app navigated somewhere else underneath the overlay (a sidebar link, a
  // "Back to Home" inside the dialog): the entries we pushed are behind the user.
  useEffect(() => {
    const current = targetRef.current;
    if (current && pathOf(current.href) !== pathname.replace(/\/$/, "")) resetDetail();
  }, [pathname]);

  const open = target !== null;

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Lock body scroll while open (same approach as BottomSheet).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useFocusTrap(open, panelRef);

  // Each new target starts at the top of the panel.
  const href = target?.href;
  useEffect(() => {
    if (href) panelRef.current?.scrollTo({ top: 0 });
  }, [href]);

  if (!mounted || !target) return null;

  return createPortal(
    <div className="fixed inset-0 z-[65] flex items-center justify-center">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={closeDetail}
        className="absolute inset-0 bg-primary/40 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={DIALOG_LABEL[target.kind]}
        tabIndex={-1}
        className="relative max-h-[calc(100dvh-48px)] w-[min(1040px,calc(100vw-48px))] overflow-y-auto overscroll-contain rounded-xl bg-background shadow-level-3 focus:outline-none"
      >
        {target.kind === "happening" ? (
          <HappeningDetail key={target.href} id={target.id} presentation="modal" />
        ) : target.kind === "event" ? (
          <EventDetail key={target.href} id={target.id} presentation="modal" />
        ) : (
          <PlaceDetail key={target.href} id={target.id} presentation="modal" />
        )}
      </div>
    </div>,
    document.body
  );
}

export default DetailOverlayProvider;
