import type { ReactNode } from "react";

/**
 * Hand-drawn SVG Fomo (the orange logo dot, grown a face and limbs) for
 * sign-in, the nav button and Ask Fomo, plus the sign-in skyline. (The
 * welcome slides' scenes and supporting cast went with app/welcome.)
 *
 * Pure SVG + the `fomo-*` animation classes in app/globals.css, so there are
 * no image assets to fetch. Animated groups always sit *inside* a positioned
 * group (see `At`): a CSS transform on an SVG element replaces its
 * `transform` attribute, so position and animation can't share an element.
 * Colours are literal rather than theme tokens — this is illustration, and
 * ORANGE is the app icon's own dot (public/icons/icon.svg).
 */

const NAVY = "#1b365d";
const ORANGE = "#fc8a40";
const ORANGE_DEEP = "#e8702a";
const YELLOW = "#ffc93c";
const PURPLE = "#7c5cff";
const GREEN = "#3f9d6b";
const RED = "#ef5350";
const SKY = "#6aa9e9";
const TONGUE = "#ff7a8a";

type AtProps = { x: number; y: number; r?: number; s?: number; anim?: string; children: ReactNode };

/** Place + rotate + scale, with an optional animation class on an inner group. */
function At({ x, y, r = 0, s = 1, anim, children }: AtProps) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
      {anim ? <g className={anim}>{children}</g> : children}
    </g>
  );
}

function Sparkle({ size = 8, color = YELLOW }: { size?: number; color?: string }) {
  const q = size * 0.18;
  return (
    <path
      d={`M0 ${-size}Q${q} ${-q} ${size} 0Q${q} ${q} 0 ${size}Q${-q} ${q} ${-size} 0Q${-q} ${-q} 0 ${-size}Z`}
      fill={color}
    />
  );
}

// ---------------------------------------------------------------------------
// Fomo
// ---------------------------------------------------------------------------

export type FomoMood = "wow" | "grin" | "gasp" | "meh" | "hmm";
export type FomoPose = "cheer" | "hold" | "run" | "wave" | "shrug" | "none";

const ARMS: Record<FomoPose, string[]> = {
  cheer: ["M-40 -4Q-58 -18 -60 -40", "M40 -4Q58 -18 60 -40"],
  hold: ["M-42 8Q-58 18 -52 32", "M42 -6Q60 -24 62 -48"],
  run: ["M-40 4Q-58 14 -68 4", "M40 -8Q56 -32 50 -58"],
  wave: ["M-42 8Q-56 22 -50 36", "M42 -6Q62 -20 66 -42"],
  shrug: ["M-42 6Q-60 6 -64 -8", "M42 6Q60 6 64 -8"],
  none: [],
};

const HANDS: Record<FomoPose, [number, number][]> = {
  cheer: [[-60, -44], [60, -44]],
  hold: [[-52, 34], [62, -52]],
  run: [[-70, 2], [50, -62]],
  wave: [[-50, 38], [66, -46]],
  shrug: [[-66, -12], [66, -12]],
  none: [],
};

/** Where the pupils look, per mood: up for wow, down for meh, up-right for hmm. */
const LOOK: Record<FomoMood, [number, number]> = {
  wow: [0, -8],
  grin: [0, -3],
  gasp: [0, -3],
  meh: [0, 1],
  hmm: [4, -8],
};

/**
 * Fomo, centred on its body (radius ~48; feet reach y≈66, raised hands y≈-62).
 * wow/grin/gasp carry the onboarding scenes; meh is for "nothing here" states,
 * hmm for Ask Fomo thinking. Pose "none" drops the limbs (see FomoFace).
 */
export function FomoBuddy({ mood = "grin", pose = "wave" }: { mood?: FomoMood; pose?: FomoPose }) {
  const limb = { stroke: NAVY, strokeWidth: 5, strokeLinecap: "round" as const, fill: "none" };
  const pupil = mood === "gasp" ? 3.5 : 5.5;
  const [lookX, lookY] = LOOK[mood];

  return (
    <g>
      {pose === "none" ? null : pose === "run" ? (
        <>
          <path d="M-12 40Q-24 52 -38 50" {...limb} />
          <ellipse cx={-42} cy={49} rx={9} ry={5} fill={NAVY} transform="rotate(-20 -42 49)" />
          <path d="M12 40Q22 52 22 64" {...limb} />
          <ellipse cx={27} cy={66} rx={9} ry={5} fill={NAVY} />
        </>
      ) : (
        <>
          <path d="M-14 40L-16 58" {...limb} />
          <path d="M14 40L16 58" {...limb} />
          <ellipse cx={-20} cy={61} rx={9} ry={5} fill={NAVY} />
          <ellipse cx={20} cy={61} rx={9} ry={5} fill={NAVY} />
        </>
      )}
      {ARMS[pose].map((d) => (
        <path key={d} d={d} {...limb} />
      ))}
      {HANDS[pose].map(([hx, hy]) => (
        <circle key={`${hx},${hy}`} cx={hx} cy={hy} r={6} fill={NAVY} />
      ))}

      {/* Body, drawn after the limbs so shoulders and hips tuck behind it. */}
      <path d="M0 -48C29 -48 48 -27 48 0C48 29 27 46 0 46C-27 46 -48 29 -48 0C-48 -27 -29 -48 0 -48Z" fill={ORANGE} />
      <path d="M-42 16C-32 38 -8 45 10 42C-12 36 -32 28 -42 16Z" fill={ORANGE_DEEP} opacity={0.55} />
      <ellipse cx={-20} cy={-29} rx={12} ry={6} fill="#fff" opacity={0.4} transform="rotate(-35 -20 -29)" />

      {mood === "gasp" ? (
        <g stroke={NAVY} strokeWidth={3} strokeLinecap="round" fill="none">
          <path d="M-26 -26Q-16 -35 -6 -28" />
          <path d="M6 -28Q16 -35 26 -26" />
        </g>
      ) : mood === "hmm" ? (
        <path d="M6 -30Q16 -37 26 -31" stroke={NAVY} strokeWidth={3} strokeLinecap="round" fill="none" />
      ) : null}

      <g className="fomo-blink">
        <ellipse cx={-16} cy={-6} rx={11} ry={13} fill="#fff" />
        <ellipse cx={16} cy={-6} rx={11} ry={13} fill="#fff" />
        <circle cx={-14 + lookX} cy={lookY} r={pupil} fill={NAVY} />
        <circle cx={18 + lookX} cy={lookY} r={pupil} fill={NAVY} />
        <circle cx={-12 + lookX} cy={lookY - 2} r={1.8} fill="#fff" />
        <circle cx={20 + lookX} cy={lookY - 2} r={1.8} fill="#fff" />
        {mood === "meh" ? (
          // Heavy lids: body-coloured bars over the top of each eye.
          <>
            <rect x={-28} y={-20} width={24} height={11} fill={ORANGE} />
            <rect x={4} y={-20} width={24} height={11} fill={ORANGE} />
          </>
        ) : null}
      </g>

      <ellipse cx={-33} cy={12} rx={7} ry={4} fill="#ff5a5a" opacity={0.3} />
      <ellipse cx={33} cy={12} rx={7} ry={4} fill="#ff5a5a" opacity={0.3} />

      {mood === "grin" ? (
        <>
          <path d="M-13 13Q0 32 13 13Z" fill={NAVY} />
          <path d="M-6 19Q0 14 6 19Q0 24 -6 19Z" fill={TONGUE} />
        </>
      ) : mood === "wow" ? (
        <>
          <ellipse cx={0} cy={20} rx={7} ry={9} fill={NAVY} />
          <ellipse cx={0} cy={25} rx={4} ry={2.5} fill={TONGUE} />
        </>
      ) : mood === "meh" ? (
        <path d="M-9 21Q-4.5 17 0 21T9 21" stroke={NAVY} strokeWidth={3} strokeLinecap="round" fill="none" />
      ) : mood === "hmm" ? (
        <ellipse cx={7} cy={21} rx={4} ry={3.5} fill={NAVY} />
      ) : (
        <>
          <ellipse cx={0} cy={21} rx={9} ry={10} fill={NAVY} />
          <ellipse cx={0} cy={26} rx={5} ry={3} fill={TONGUE} />
        </>
      )}
    </g>
  );
}

/** Fomo's face alone (no limbs), sized by className — chat avatars and the nav button. */
export function FomoFace({ mood = "grin", className = "" }: { mood?: FomoMood; className?: string }) {
  return (
    <svg viewBox="-50 -50 100 100" className={className} aria-hidden="true">
      <FomoBuddy mood={mood} pose="none" />
    </svg>
  );
}

const NIGHT_SKYLINE =
  "M0 150L0 118L18 118L18 104L30 104L30 114L46 114L46 96L52 88L58 96L58 114L74 114L74 106L88 106L88 120L104 120L104 98L112 98L112 90L120 90L120 98L128 98L128 122L150 122L150 112C170 104 186 100 200 98L200 80L207 80L207 74L213 74L213 80L220 80L220 66L224 58L228 66L228 80L242 80L242 72L248 72L248 76L254 76L254 72L260 72L260 80L270 80L270 74L276 74L276 80L282 80L282 100C292 106 300 114 304 122L320 122L320 102L326 94L332 102L332 110L346 110L346 118L360 118L360 150Z";

/**
 * Sign-in hero (viewBox 360×150): Edinburgh by night — castle skyline, moon,
 * stars and a string of festival lights. Fomo appears separately, peeking
 * over the form card.
 */
export function SigninSkyline() {
  const bulbs = [ORANGE, YELLOW, PURPLE, GREEN, RED, SKY, ORANGE, YELLOW, PURPLE];
  return (
    <svg viewBox="0 0 360 150" preserveAspectRatio="xMidYMax slice" className="h-full w-full" aria-hidden="true">
      <circle cx={300} cy={34} r={16} fill="#fff4d6" />
      <circle cx={294} cy={30} r={3} fill="#f0dfb2" />
      <circle cx={304} cy={40} r={2} fill="#f0dfb2" />
      {[
        [30, 30, 0], [72, 18, 1], [120, 40, 2], [170, 16, 0], [236, 26, 1], [340, 60, 2], [256, 50, 0],
      ].map(([x, y, d]) => (
        <At key={`${x},${y}`} x={x} y={y} anim={`fomo-twinkle${d ? ` fomo-delay-${d}` : ""}`}>
          <Sparkle size={d === 1 ? 5 : 4} color="#ffffff" />
        </At>
      ))}
      <path d="M-4 58Q90 96 180 70T364 66" stroke="#ffffff" strokeOpacity={0.35} strokeWidth={1.5} fill="none" />
      {bulbs.map((c, n) => {
        const x = 20 + n * 40;
        const y = n < 4 ? 62 + [4, 12, 16, 14][n] : [72, 70, 66, 64, 64][n - 4];
        return (
          <At key={n} x={x} y={y + 6} anim={`fomo-twinkle fomo-delay-${n % 3}`}>
            <circle r={4.5} fill={c} />
          </At>
        );
      })}
      <path d={NIGHT_SKYLINE} fill="#ffffff" opacity={0.08} transform="translate(-20 6)" />
      <path d={NIGHT_SKYLINE} fill="#0b1a33" opacity={0.55} />
      <g fill={YELLOW} opacity={0.8}>
        <rect x={214} y={88} width={4} height={6} rx={1} />
        <rect x={234} y={92} width={4} height={6} rx={1} />
        <rect x={262} y={88} width={4} height={6} rx={1} />
        <rect x={108} y={106} width={3} height={5} rx={1} />
        <rect x={52} y={104} width={3} height={5} rx={1} />
        <rect x={326} y={114} width={3} height={5} rx={1} />
      </g>
    </svg>
  );
}

/**
 * Fomo's top half, hands gripping a ledge at y=0 — sits on the top edge of
 * the sign-in card. viewBox -64 -70 128 78; the body is clipped at the ledge.
 */
export function FomoPeek({ mood = "grin" }: { mood?: FomoMood }) {
  return (
    <svg viewBox="-64 -70 128 78" className="h-full w-full" aria-hidden="true">
      <defs>
        <clipPath id="fomo-peek-ledge">
          <rect x={-64} y={-70} width={128} height={70} />
        </clipPath>
      </defs>
      <g clipPath="url(#fomo-peek-ledge)">
        <g transform="translate(0 -18)">
          <FomoBuddy mood={mood} pose="none" />
        </g>
      </g>
      {[-38, 38].map((hx) => (
        <g key={hx} transform={`translate(${hx} 0)`}>
          <ellipse cx={0} cy={-2} rx={11} ry={7} fill={NAVY} />
          <g stroke="#ffffff" strokeOpacity={0.35} strokeWidth={1.5} strokeLinecap="round">
            <path d="M-4 -6V0" />
            <path d="M0 -7V0" />
            <path d="M4 -6V0" />
          </g>
        </g>
      ))}
    </svg>
  );
}
