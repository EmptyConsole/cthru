import type { CueAnim } from "./cues";
import css from "./scan.module.css";

/**
 * The idea in one picture: two near boards with a gap, and the scene behind
 * sliding past as the device moves. The phone slides one way, the scene
 * through the gap shifts the other.
 */
export function GapHero({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 150" className={className} role="img" aria-label="A phone slides sideways in front of a narrow gap, revealing the scene behind it">
      <defs>
        <clipPath id="hero-gap">
          <rect x="104" y="14" width="32" height="96" />
        </clipPath>
        <linearGradient id="hero-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      {/* The hidden scene, only visible through the gap. */}
      <g clipPath="url(#hero-gap)">
        <g className={css.reveal}>
          <rect x="40" y="14" width="160" height="96" fill="url(#hero-sky)" />
          <circle cx="92" cy="40" r="10" fill="#fde68a" />
          <path d="M40 110 L78 64 L102 88 L128 56 L164 98 L200 70 V110 Z" fill="#34d399" />
          <path d="M40 110 L70 90 L110 104 L150 86 L200 104 V110 Z" fill="#065f46" />
        </g>
      </g>
      {/* The two near boards. */}
      <rect x="20" y="10" width="84" height="104" rx="6" className="fill-control-hover" />
      <rect x="136" y="10" width="84" height="104" rx="6" className="fill-control-hover" />
      <rect x="104" y="14" width="32" height="96" fill="none" stroke="#f43f5e" strokeWidth="2.5" />
      {/* The phone sliding along. */}
      <g className={css.slide}>
        <rect x="104" y="120" width="32" height="24" rx="5" className="fill-foreground" />
        <circle cx="120" cy="132" r="4" className="fill-background" />
      </g>
      <path d="M92 132 h-14 M82 128 l-4 4 4 4 M148 132 h14 M158 128 l4 4 -4 4" className="stroke-faint" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The small animation that goes with a viewfinder cue. */
export function CueArt({ anim, progress }: { anim: CueAnim; progress?: number }) {
  if (anim === "none") return null;
  if (anim === "loading") {
    const p = Math.max(0.04, progress ?? 0);
    return (
      <svg viewBox="0 0 36 36" className="h-9 w-9 shrink-0" aria-hidden>
        <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
        <circle
          cx="18"
          cy="18"
          r="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${p * 94.2} 94.2`}
          transform="rotate(-90 18 18)"
        />
      </svg>
    );
  }
  if (anim === "aim") {
    return (
      <svg viewBox="0 0 36 36" className="h-9 w-9 shrink-0" aria-hidden>
        <rect x="3" y="4" width="11" height="28" rx="2" fill="currentColor" opacity="0.5" />
        <rect x="22" y="4" width="11" height="28" rx="2" fill="currentColor" opacity="0.5" />
        <rect className={css.aim} x="15.5" y="5" width="5" height="26" rx="1" fill="none" stroke="#fbbf24" strokeWidth="2" />
      </svg>
    );
  }
  if (anim === "steady") {
    return (
      <svg viewBox="0 0 36 36" className="h-9 w-9 shrink-0" aria-hidden>
        <rect x="11" y="5" width="14" height="26" rx="3" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M5 12v12M31 12v12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.6" />
      </svg>
    );
  }
  // slide
  return (
    <svg viewBox="0 0 44 36" className="h-9 w-11 shrink-0" aria-hidden>
      <g className={css.slide}>
        <rect x="15" y="6" width="14" height="24" rx="3" fill="none" stroke="currentColor" strokeWidth="2.5" />
      </g>
      <path d="M3 18h6M6 15l-3 3 3 3M41 18h-6M38 15l3 3-3 3" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
    </svg>
  );
}

/** Top-down view: two positions looking through a gap see different parts of the scene. */
export function GeometryDiagram() {
  return (
    <svg viewBox="0 0 280 200" className="w-full" role="img" aria-label="Top-down diagram: two phone positions looking through a gap see different parts of the scene behind">
      <rect x="10" y="12" width="260" height="16" rx="3" fill="#7c3aed" opacity="0.6" />
      <text x="140" y="24" textAnchor="middle" fontSize="10" fill="#f5f3ff">
        hidden scene
      </text>
      <rect x="10" y="96" width="118" height="10" fill="#a16207" />
      <rect x="152" y="96" width="118" height="10" fill="#a16207" />
      <text x="140" y="122" textAnchor="middle" fontSize="10" fill="currentColor">
        gap
      </text>
      <polygon points="128,101 152,101 105,28 58,28" fill="#34d399" opacity="0.18" />
      <polygon points="128,101 152,101 222,28 175,28" fill="#fbbf24" opacity="0.18" />
      <polyline points="200,176 128,101 58,28" fill="none" stroke="#34d399" strokeWidth="1.5" />
      <polyline points="200,176 152,101 105,28" fill="none" stroke="#34d399" strokeWidth="1.5" />
      <polyline points="80,176 128,101 175,28" fill="none" stroke="#fbbf24" strokeWidth="1.5" />
      <polyline points="80,176 152,101 222,28" fill="none" stroke="#fbbf24" strokeWidth="1.5" />
      <circle cx="200" cy="180" r="7" fill="#34d399" />
      <circle cx="80" cy="180" r="7" fill="#fbbf24" />
      <text x="200" y="198" textAnchor="middle" fontSize="10" fill="#34d399">
        phone on the right
      </text>
      <text x="80" y="198" textAnchor="middle" fontSize="10" fill="#fbbf24">
        phone on the left
      </text>
    </svg>
  );
}
