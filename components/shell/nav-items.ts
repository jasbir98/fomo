/**
 * Shared nav data for BottomNav (phones) and SideNav (desktop), so the two
 * can never drift on icons, colours or what counts as "active".
 *
 * Each tab carries its own colour. Class strings are written out in full (not
 * built from a colour name) so Tailwind's scanner sees them.
 *  - `text`:   icon + active label colour (AA on white)
 *  - `pill`:   tinted pill behind the icon when active (~12%)
 */
export type NavItem = { href: string; icon: string; label: string; text: string; pill: string };

export const NAV_FEED: NavItem = {
  href: "/",
  icon: "local_activity",
  label: "Feed",
  text: "text-brand-orange-ink",
  pill: "bg-brand-orange-ink/12",
};
export const NAV_SAVED: NavItem = {
  href: "/saved",
  icon: "bookmark",
  label: "Saved",
  text: "text-cat-nightlife",
  pill: "bg-cat-nightlife/12",
};
export const NAV_DEALS: NavItem = {
  href: "/deals",
  icon: "sell",
  label: "Deals",
  text: "text-cat-sports",
  pill: "bg-cat-sports/12",
};
export const NAV_EXPLORE: NavItem = {
  href: "/explore",
  icon: "explore",
  label: "Explore",
  text: "text-accent",
  pill: "bg-accent/12",
};

/** BottomNav's two halves, either side of the centre Fomo FAB. */
export const LEFT: NavItem[] = [NAV_FEED, NAV_SAVED];
export const RIGHT: NavItem[] = [NAV_DEALS, NAV_EXPLORE];

/** SideNav's primary list, in desktop reading order. */
export const PRIMARY: NavItem[] = [NAV_FEED, NAV_DEALS, NAV_EXPLORE, NAV_SAVED];

export function isActive(pathname: string, href: string) {
  // The statically built home page is prerendered as "/index" (its RSC tree is
  // ["", "index"]), and React doesn't patch a class mismatch on hydration, so
  // without this Feed only lit up after the first client-side navigation.
  if (href === "/") return pathname === "/" || pathname === "/index";
  return pathname === href || pathname.startsWith(`${href}/`);
}
