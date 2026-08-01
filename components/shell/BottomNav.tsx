"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../ui/Icon";

type NavItem = { href: string; icon: string; label: string };

const LEFT: NavItem[] = [
  { href: "/", icon: "home", label: "Home" },
  { href: "/reels", icon: "movie", label: "Reels" },
];
const RIGHT: NavItem[] = [
  { href: "/plan", icon: "calendar_month", label: "Plan" },
  { href: "/map", icon: "map", label: "Map" },
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
 * Canonical Roameo bottom navigation: Home · Reels · [Roameo FAB] · Plan · Map.
 * Fixed to the bottom of the max-w-[480px] phone column. Active tab = Sunset
 * Orange; the center Roameo FAB is a raised 64px navy button.
 */
export function BottomNav() {
  const pathname = usePathname();
  const roameoActive = isActive(pathname, "/roameo");

  return (
    <nav
      className="fixed bottom-0 left-1/2 z-50 w-full max-w-[480px] -translate-x-1/2 border-t border-outline-variant/60 bg-surface-container-lowest pb-safe shadow-[0_-4px_16px_rgba(3,22,50,0.08)]"
      aria-label="Primary"
    >
      <div className="relative flex h-[64px] items-center justify-between px-4">
        <div className="flex flex-1 justify-around">
          {LEFT.map((item) => (
            <NavTab key={item.href} item={item} active={isActive(pathname, item.href)} />
          ))}
        </div>

        {/* Center Roameo FAB — raised above the bar */}
        <div className="flex w-16 shrink-0 justify-center">
          <Link
            href="/roameo"
            aria-label="Roameo"
            aria-current={roameoActive ? "page" : undefined}
            className={`absolute -top-6 flex h-16 w-16 flex-col items-center justify-center rounded-full bg-primary text-on-primary shadow-[0_6px_20px_rgba(3,22,50,0.35)] ring-4 ring-background transition-transform active:scale-95 ${
              roameoActive ? "text-secondary-container" : ""
            }`}
          >
            <Icon name="auto_awesome" filled size={28} />
            <span className="text-[10px] font-semibold leading-none mt-0.5">Roameo</span>
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
