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
  // Material Symbols Outlined axis ranges: opsz 20–48, wght 100–700, FILL 0–1, GRAD -50–200
  // Clamp optical size to the valid font axis range. Sizes below 20 will be rendered
  // clamped by the browser anyway; we make it explicit here.
  const opszClamped = size ? Math.max(20, Math.min(48, size)) : 24;
  return (
    <span
      className={`material-symbols-outlined select-none leading-none ${className}`}
      aria-hidden="true"
      style={{
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' ${weight}, 'GRAD' 0, 'opsz' ${opszClamped}`,
        ...(size ? { fontSize: size } : null),
        ...style,
      }}
    >
      {name}
    </span>
  );
}

export default Icon;
