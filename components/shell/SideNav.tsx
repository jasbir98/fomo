"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useSignedIn } from "@/lib/useSaved";
import { FomoFace } from "../onboarding/Characters";
import { FomoLogo } from "../ui/FomoLogo";
import { Icon } from "../ui/Icon";
import { UserAvatar } from "./UserAvatar";
import { NAV_SAVED, PRIMARY, isActive, type NavItem } from "./nav-items";

/** Secondary destinations, below the primary tabs. No per-tab colour: they take the neutral navy tint. */
const BROWSE: NavItem[] = [
  { href: "/whats-on", icon: "event", label: "What's on", text: "text-primary", pill: "bg-primary/10" },
  { href: "/book-early", icon: "confirmation_number", label: "Book early", text: "text-primary", pill: "bg-primary/10" },
  { href: "/free", icon: "redeem", label: "Free any time", text: "text-primary", pill: "bg-primary/10" },
  { href: "/weekend", icon: "weekend", label: "This weekend", text: "text-primary", pill: "bg-primary/10" },
];
const TIP: NavItem = { href: "/tip", icon: "lightbulb", label: "Suggest a tip", text: "text-primary", pill: "bg-primary/10" };
/** Saved left the primary tabs for "For you" on 12 Oct 2026; it sits with Tip and Profile now, in the same neutral tint. */
const SAVED: NavItem = { ...NAV_SAVED, text: "text-primary", pill: "bg-primary/10" };
const PROFILE: NavItem = { href: "/profile", icon: "person", label: "Profile", text: "text-primary", pill: "bg-primary/10" };

/** SSR-safe matchMedia subscription (false on the server and until hydrated). */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

/**
 * One row. Two layouts off the same markup, switched by breakpoint:
 *  - lg (80px rail): a centred 48px icon-only target, named by `aria-label`
 *    and a native `title` tooltip.
 *  - xl (240px rail): full-width pill row, icon + label.
 * The active pill reuses BottomNav's per-tab tint (`item.pill`) so a tab reads
 * the same colour on every form factor.
 */
function NavLink({
  item,
  active,
  tooltip,
  avatar = false,
}: {
  item: NavItem;
  active: boolean;
  tooltip: boolean;
  /** Draw the signed-in user's avatar in place of the icon (Profile row). */
  avatar?: boolean;
}) {
  return (
    <Link
      href={item.href}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      title={tooltip ? item.label : undefined}
      className={`flex h-12 w-12 items-center justify-center gap-3 rounded-full transition-colors hover:bg-surface-container xl:w-full xl:justify-start xl:px-4 ${
        active ? item.pill : ""
      }`}
    >
      {avatar ? (
        <span className={`flex shrink-0 rounded-full ${active ? "ring-2 ring-primary ring-offset-2 ring-offset-surface-container-lowest" : ""}`}>
          <UserAvatar size={32} />
        </span>
      ) : (
        <span className={`flex shrink-0 items-center justify-center ${item.text} ${active ? "" : "opacity-85"}`}>
          <Icon name={item.icon} filled={active} size={26} />
        </span>
      )}
      <span
        className={`hidden truncate text-label-md font-semibold xl:inline ${
          active ? item.text : "text-on-surface-variant"
        }`}
      >
        {item.label}
      </span>
    </Link>
  );
}

/**
 * Desktop side navigation (lg and up; BottomNav takes the phone). A fixed
 * left rail whose width comes from the `--sidenav-w` custom property
 * (app/globals.css: 80px at lg, 240px at xl) — the same variable AppShell uses
 * for the content's left padding, so the two can't disagree.
 *
 * Layout top to bottom: logo, the raised "Ask Fomo" action, the four primary
 * tabs (the same data BottomNav renders, from ./nav-items), a Browse group of
 * secondary pages, then Saved, Suggest a tip and Profile/Sign in pinned to the
 * bottom. z-50, the same layer as BottomNav, above the sticky headers (40).
 * Labelled "Main" rather than "Primary" so the landmark name doesn't repeat
 * BottomNav's (hidden at this size, but cheap insurance).
 */
export function SideNav() {
  const pathname = usePathname();
  const signedIn = useSignedIn();
  const fomoActive = isActive(pathname, "/fomo");
  // At xl the labels are visible, so a native tooltip would just repeat them.
  const isXl = useMediaQuery("(min-width: 80rem)");
  const tooltip = !isXl;

  return (
    <nav
      aria-label="Main"
      className="fixed inset-y-0 left-0 z-50 hidden w-[var(--sidenav-w)] flex-col items-center overflow-y-auto border-r border-hairline bg-surface-container-lowest px-3 pb-4 [scrollbar-width:none] lg:flex [&::-webkit-scrollbar]:hidden"
    >
      <Link
        href="/"
        aria-label="Fomo home"
        className="flex h-16 shrink-0 items-center justify-center rounded-lg xl:w-full xl:justify-start xl:px-4"
      >
        {/* Wrapped rather than classed directly: FomoLogo sets its own `inline-flex`,
            which would fight a `hidden` passed through className. */}
        <span className="xl:hidden">
          <FomoLogo size={32} markOnly />
        </span>
        <span className="hidden xl:inline-flex">
          <FomoLogo size={32} />
        </span>
      </Link>

      <Link
        href="/fomo"
        aria-label="Ask Fomo"
        aria-current={fomoActive ? "page" : undefined}
        title={tooltip ? "Ask Fomo" : undefined}
        className="mt-1 flex h-14 w-14 shrink-0 items-center justify-center gap-2.5 rounded-full bg-primary text-on-primary shadow-[0_6px_20px_rgba(27,54,93,0.3)] transition-transform hover:scale-105 active:scale-95 xl:h-12 xl:w-full xl:justify-start xl:px-4 xl:hover:scale-100"
      >
        <FomoFace mood={fomoActive ? "grin" : "wow"} className="h-9 w-9 shrink-0 xl:h-8 xl:w-8" />
        <span className="hidden text-label-md font-bold xl:inline">Ask Fomo</span>
      </Link>

      <ul role="list" className="mt-4 flex w-full flex-col items-center gap-1">
        {PRIMARY.map((item) => (
          <li key={item.href} className="xl:w-full">
            <NavLink item={item} active={isActive(pathname, item.href)} tooltip={tooltip} />
          </li>
        ))}
      </ul>

      {/* lg: a plain divider. xl: the divider is replaced by a group heading. */}
      <div aria-hidden="true" className="my-3 h-px w-8 shrink-0 bg-hairline xl:hidden" />
      <p className="mt-5 hidden w-full px-4 pb-1 text-label-sm uppercase text-on-surface-variant xl:block">Browse</p>
      <ul role="list" aria-label="Browse" className="flex w-full flex-col items-center gap-1">
        {BROWSE.map((item) => (
          <li key={item.href} className="xl:w-full">
            <NavLink item={item} active={isActive(pathname, item.href)} tooltip={tooltip} />
          </li>
        ))}
      </ul>

      <ul role="list" className="mt-auto flex w-full flex-col items-center gap-1 pt-4">
        <li className="xl:w-full">
          <NavLink item={SAVED} active={isActive(pathname, SAVED.href)} tooltip={tooltip} />
        </li>
        <li className="xl:w-full">
          <NavLink item={TIP} active={isActive(pathname, TIP.href)} tooltip={tooltip} />
        </li>
        <li className="xl:w-full">
          {signedIn === null ? (
            // Auth state hasn't resolved — same footprint as the resolved
            // states, and not a link, so a signed-out click can't land on the
            // account-gated /profile a beat before we know better (see AppHeader).
            <span aria-hidden="true" className="flex h-12 w-12 items-center justify-center xl:w-full xl:justify-start xl:px-4">
              <span className="h-8 w-8 animate-pulse rounded-full bg-surface-container" />
            </span>
          ) : signedIn === false ? (
            <Link
              href="/signin"
              aria-label="Sign in"
              title={tooltip ? "Sign in" : undefined}
              className="flex h-12 w-12 items-center justify-center gap-2.5 rounded-full bg-primary text-on-primary transition-opacity hover:opacity-90 xl:w-full xl:px-4"
            >
              <Icon name="login" size={24} />
              <span className="hidden text-label-md font-bold xl:inline">Sign in</span>
            </Link>
          ) : (
            <NavLink item={PROFILE} active={isActive(pathname, PROFILE.href)} tooltip={tooltip} avatar />
          )}
        </li>
      </ul>
    </nav>
  );
}

export default SideNav;
