"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

/** True when the key press is going to a text-entry control, where "/" is just a character. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** An open modal (BottomSheet and friends keep closed ones mounted under `aria-hidden`). */
function modalIsOpen(): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => !el.closest('[aria-hidden="true"]'));
}

/**
 * Global desktop keyboard shortcuts, mounted once in AppShell. Renders nothing.
 *
 * "/" jumps to search, the same convention as GitHub/YouTube. Pages with an
 * AppHeader carry an inline search field marked `data-desktop-search`
 * (components/shell/AppHeader.tsx): focus that. Pages without one (they use
 * PageHeader) have nowhere to focus, so go to /search instead. Only active at
 * lg and up (>=1024px) — on a phone there's no hardware keyboard to speak of
 * and the header's search icon is the entry point.
 *
 * Stays out of the way when "/" is meant literally: while typing in a field,
 * with Ctrl/Cmd/Alt held, or while a modal is open.
 */
export function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 64rem)");

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!desktop.matches || isTypingTarget(e.target) || modalIsOpen()) return;

      const field =
        pathname.startsWith("/search")
          ? document.querySelector<HTMLInputElement>('input[type="search"]')
          : document.querySelector<HTMLInputElement>("[data-desktop-search]");
      // getClientRects() is empty for display:none, i.e. a field hidden by a breakpoint.
      if (field && field.getClientRects().length > 0) {
        e.preventDefault();
        field.focus();
        field.select();
        return;
      }
      if (pathname.startsWith("/search")) return;
      e.preventDefault();
      router.push("/search");
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [router, pathname]);

  return null;
}

export default KeyboardShortcuts;
