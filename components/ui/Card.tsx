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
 * White surface card: 16px radius, subtle border + soft shadow.
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
      className={`relative overflow-hidden rounded-lg bg-surface-container-lowest border border-outline-variant/60 shadow-[0_2px_8px_rgba(3,22,50,0.05)] ${
        noPadding ? "" : "p-4"
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
