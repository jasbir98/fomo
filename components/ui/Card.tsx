import type { ElementType, ComponentPropsWithoutRef, ReactNode } from "react";

export type CardProps<T extends ElementType = "div"> = {
  as?: T;
  /** Left 4px Voyager-navy accent bar (active/upcoming itinerary cards). */
  accent?: boolean;
  /** Remove inner padding (for edge-to-edge media cards). */
  noPadding?: boolean;
  children?: ReactNode;
  className?: string;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "children" | "className">;

/**
 * White surface card: generous radius, no border — a soft diffuse
 * navy-tinted shadow (--shadow-level-1) does the job of separating it from
 * the page instead, matching the mockup's glass-panel treatment (no visible
 * outline; see app/globals.css's elevation doc comment for the source).
 * Polymorphic via `as` (button/a/div). Optional left navy accent bar.
 */
export function Card<T extends ElementType = "div">({
  as,
  accent = false,
  noPadding = false,
  children,
  className = "",
  ...props
}: CardProps<T>) {
  const Component = (as ?? "div") as ElementType;
  return (
    <Component
      className={`relative overflow-hidden rounded-2xl bg-surface-container-lowest shadow-level-1 ${
        noPadding ? "" : "p-3.5"
      } ${accent ? "pl-5" : ""} ${className}`}
      {...props}
    >
      {accent ? (
        <span className="absolute left-0 top-0 bottom-0 w-1 bg-primary" aria-hidden="true" />
      ) : null}
      {children}
    </Component>
  );
}

export default Card;
