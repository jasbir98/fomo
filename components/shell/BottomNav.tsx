"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FomoFace } from "../onboarding/Characters";
import { Icon } from "../ui/Icon";

/**
 * Each tab carries its own colour. Class strings are written out in full (not
 * built from a colour name) so Tailwind's scanner sees them.
 *  - `text`:   icon + active label colour (AA on white)
 *  - `pill`:   tinted pill behind the icon when active (~12%)
 */
type NavItem = { href: string; icon: string; label: string; text: string; pill: string };

const LEFT: NavItem[] = [
  { href: "/", icon: "local_activity", label: "Feed", text: "text-brand-orange-ink", pill: "bg-brand-orange-ink/12" },
  { href: "/saved", icon: "bookmark", label: "Saved", text: "text-cat-nightlife", pill: "bg-cat-nightlife/12" },
];
const RIGHT: NavItem[] = [
  { href: "/deals", icon: "sell", label: "Deals", text: "text-cat-sports", pill: "bg-cat-sports/12" },
  { href: "/explore", icon: "explore", label: "Explore", text: "text-accent", pill: "bg-accent/12" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavTab({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 transition-colors"
    >
      <span
        className={`flex h-8 w-14 items-center justify-center rounded-full transition-colors ${item.text} ${
          active ? item.pill : "opacity-85"
        }`}
      >
        <Icon name={item.icon} filled={active} size={26} />
      </span>
      <span
        className={`max-w-full truncate text-label-sm font-semibold leading-none ${
          active ? item.text : "text-on-surface-variant"
        }`}
      >
        {item.label}
      </span>
    </Link>
  );
}

/**
 * Canonical Fomo bottom navigation: Feed · Saved · [Fomo FAB] · Deals · Explore.
 * Reels left the nav on 2026-09-26 (no Edinburgh reels yet; reels live on the
 * Instagram account) — /reels still works as a page. Saved points at /saved,
 * its own dedicated page (app/(shell)/saved/page.tsx).
 * Fixed to the bottom of the max-w-[480px] phone column; the centre Fomo FAB
 * is a raised 64px button wearing the mascot's face (components/onboarding/
 * Characters.tsx), which grins while you're chatting with it. Deals took
 * Saved's slot in the Home decluttering pass — Deals & Offers is now its own
 * full page (app/(shell)/deals/page.tsx) instead of a Home section. The last tab was
 * renamed Map -> Explore (same map view, app/(shell)/explore/page.tsx); `/map`
 * still works as a redirect for old links.
 */
export function BottomNav() {
  const pathname = usePathname();
  const fomoActive = isActive(pathname, "/fomo");

  return (
    <nav
      className="fixed bottom-0 left-1/2 z-50 w-full max-w-[480px] -translate-x-1/2 bg-surface-container-lowest pb-safe shadow-[0_-6px_20px_rgba(0,32,70,0.08)]"
      aria-label="Primary"
    >
      <div className="relative flex h-[64px] items-center px-2">
        <div className="flex min-w-0 flex-1">
          {LEFT.map((item) => (
            <NavTab key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </div>

        {/* Center Fomo FAB — raised above the bar */}
        <div className="flex w-[72px] shrink-0 justify-center">
          <Link
            href="/fomo"
            aria-label="Ask Fomo"
            aria-current={fomoActive ? "page" : undefined}
            className="absolute -top-6 flex h-16 w-16 flex-col items-center justify-center rounded-full bg-primary text-on-primary shadow-[0_6px_20px_rgba(27,54,93,0.35)] ring-4 ring-background transition-transform active:scale-95"
          >
            <FomoFace mood={fomoActive ? "grin" : "wow"} className="h-9 w-9" />
            <span className="text-label-sm font-semibold leading-none">Fomo</span>
          </Link>
        </div>

        <div className="flex min-w-0 flex-1">
          {RIGHT.map((item) => (
            <NavTab key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </div>
      </div>
    </nav>
  );
}

export default BottomNav;
