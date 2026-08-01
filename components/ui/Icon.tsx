import type { CSSProperties } from "react";

export type IconProps = {
  /** Material Symbols Outlined ligature name, e.g. "home", "auto_awesome". */
  name: string;
  /** Render the filled variant (FILL 1). */
  filled?: boolean;
  /** Optical weight 100–700 (default 400). */
  weight?: number;
  /** Optical size / font-size in px (default inherits, 24). */
  size?: number;
  className?: string;
  style?: CSSProperties;
};

/**
 * Material Symbols Outlined wrapper. The font is loaded globally.
 * Use `size` for pixel sizing or pass a `text-[Npx]` className.
 */
export function Icon({
  name,
  filled = false,
  weight = 400,
  size,
  className = "",
  style,
}: IconProps) {
  return (
    <span
      className={`material-symbols-outlined select-none leading-none ${className}`}
      aria-hidden="true"
      style={{
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' ${weight}, 'GRAD' 0, 'opsz' ${size ?? 24}`,
        ...(size ? { fontSize: size } : null),
        ...style,
      }}
    >
      {name}
    </span>
  );
}

export default Icon;
