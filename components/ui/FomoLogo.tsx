export type FomoLogoProps = {
  /** "light" for pale backgrounds (navy text), "dark" for navy/photo backgrounds (white text). */
  tone?: "light" | "dark";
  /** Mark size in px; the wordmark scales with it. */
  size?: number;
  /** Hide the wordmark and show only the mark. */
  markOnly?: boolean;
  className?: string;
};

/**
 * Brand lockup: the app icon as a mark (public/icons/icon.svg — navy tile,
 * ring, orange dot) beside a lowercase "fomo" wordmark whose last "o" is that
 * same orange dot. One component so the sign-in, welcome and app bars agree.
 */
export function FomoLogo({ tone = "light", size = 28, markOnly = false, className = "" }: FomoLogoProps) {
  const ink = tone === "dark" ? "#ffffff" : "#031632";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`} aria-label="Fomo" role="img">
      <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className="shrink-0">
        <rect width="512" height="512" rx="128" fill="#031632" />
        {tone === "dark" ? (
          <rect x="6" y="6" width="500" height="500" rx="122" fill="none" stroke="#ffffff" strokeOpacity="0.18" strokeWidth="12" />
        ) : null}
        <circle cx="256" cy="256" r="158" fill="none" stroke="#2a3f63" strokeWidth="18" />
        <circle cx="256" cy="256" r="96" fill="#fc8a40" />
      </svg>
      {markOnly ? null : (
        <span
          aria-hidden="true"
          className="inline-flex items-baseline font-extrabold lowercase leading-none tracking-[-0.04em]"
          style={{ color: ink, fontSize: size * 0.86 }}
        >
          fom
          <span
            className="ml-[0.05em] inline-block rounded-full"
            style={{ width: "0.52em", height: "0.52em", background: "#fc8a40" }}
          />
        </span>
      )}
    </span>
  );
}
