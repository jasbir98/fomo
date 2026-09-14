"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../ui/Icon";

type NavItem = { href: string; icon: string; label: string };

const LEFT: NavItem[] = [
  { href: "/", icon: "local_activity", label: "Feed" },
  { href: "/reels", icon: "play_circle", label: "Reels" },
];
const RIGHT: NavItem[] = [
  { href: "/deals", icon: "sell", label: "Deals" },
  { href: "/explore", icon: "explore", label: "Explore" },
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
      className={`flex w-16 flex-col items-center justify-center gap-0.5 rounded-full py-1 transition-colors ${
        active ? "text-secondary-container" : "text-on-surface-variant hover:text-on-surface"
      }`}
    >
      <Icon name={item.icon} filled={active} size={24} />
      <span className="text-label-sm font-semibold">{item.label}</span>
    </Link>
  );
}

/**
 * Canonical Fomo bottom navigation: Feed · Reels · [Fomo FAB] · Deals · Explore.
 * Fixed to the bottom of the max-w-[480px] phone column; the centre Fomo FAB
 * is a raised 64px button. Deals took Saved's slot in the Home decluttering
 * pass — Deals & Offers is now its own full page (app/(shell)/deals/page.tsx)
 * instead of a Home section, and Saved moved into Profile (/saved now just
 * redirects there). The last tab was renamed Map -> Explore (same map view,
 * app/(shell)/explore/page.tsx); `/map` still works as a redirect for old
 * links. Visual styling here predates the Modern Maritime re-skin and is
 * revisited in that pass.
 */
export function BottomNav() {
  const pathname = usePathname();
  const fomoActive = isActive(pathname, "/fomo");

  return (
    <nav
      className="fixed bottom-0 left-1/2 z-50 w-full max-w-[480px] -translate-x-1/2 bg-surface-container-lowest pb-safe shadow-[0_-6px_20px_rgba(0,32,70,0.08)]"
      aria-label="Primary"
    >
      <div className="relative flex h-[64px] items-center justify-between px-4">
        <div className="flex flex-1 justify-around">
          {LEFT.map((item) => (
            <NavTab key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </div>

        {/* Center Fomo FAB — raised above the bar */}
        <div className="flex w-16 shrink-0 justify-center">
          <Link
            href="/fomo"
            aria-label="Fomo"
            aria-current={fomoActive ? "page" : undefined}
            className={`absolute -top-6 flex h-16 w-16 flex-col items-center justify-center rounded-full bg-primary text-on-primary shadow-[0_6px_20px_rgba(27,54,93,0.35)] ring-4 ring-background transition-transform active:scale-95 ${
              fomoActive ? "text-secondary-container" : ""
            }`}
          >
            <Icon name="auto_awesome" filled size={28} />
            <span className="text-[10px] font-semibold leading-none mt-0.5">Fomo</span>
          </Link>
        </div>

        <div className="flex flex-1 justify-around">
          {RIGHT.map((item) => (
            <NavTab key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </div>
      </div>
    </nav>
  );
}

export default BottomNav;
