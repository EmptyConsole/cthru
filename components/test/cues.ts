import type { ScannerStatus } from "@/lib/gap/types";

/** Which little animation goes with a cue. */
export type CueAnim = "aim" | "slide" | "steady" | "loading" | "none";
export type CueTone = "neutral" | "good" | "warn" | "bad";

export interface Cue {
  id: string;
  title: string;
  detail?: string;
  anim: CueAnim;
  tone: CueTone;
  /** 0..1 progress to show under the cue (model download, lock-on). */
  progress?: number;
}

/** Gap narrower than this fraction of the frame should be scanned from closer in. */
const CLOSER_BELOW = 0.08;
/** Gap wider than this fraction of the frame should be scanned from farther away. */
const FARTHER_ABOVE = 0.3;
/** After this long without finding anything, suggest picking the gap by hand. */
const SUGGEST_DRAG_AFTER_MS = 6000;
/** How long the "keep sweeping" cue stays up once recording is going well. */
const SWEEP_CUE_MS = 4000;

export interface CueInput {
  status: ScannerStatus | null;
  isDemo: boolean;
  /** The depth model is the active detector and is still downloading. */
  modelLoading: boolean;
  modelProgress: number;
  /** ms spent searching without a candidate. */
  searchingFor: number;
  /** ms since recording last started (Infinity while not recording). */
  recordingFor: number;
}

/**
 * The one instruction to show in the viewfinder right now, or null when the
 * scan is going well and the user doesn't need to be told anything.
 * Ordered by what blocks progress first.
 */
export function pickCue(i: CueInput): Cue | null {
  const st = i.status;
  if (i.modelLoading) {
    return {
      id: "loading",
      title: "Getting the AI ready",
      detail: `${Math.round(i.modelProgress * 100)}% · downloaded once, then saved on this device`,
      anim: "loading",
      tone: "neutral",
      progress: i.modelProgress,
    };
  }
  if (!st) return null;
  if (!st.scanning) return { id: "paused", title: "Paused", detail: "Tap Resume to keep building the picture", anim: "none", tone: "neutral" };
  if (st.rotating) {
    return { id: "rotating", title: "Slide, don't turn", detail: "Move sideways and keep the same distance", anim: "slide", tone: "bad" };
  }

  const hasGap = st.gap != null || st.candidate != null;
  if (hasGap && st.gapWidthFrac > 0 && st.gapWidthFrac < CLOSER_BELOW) {
    return { id: "closer", title: "Move closer", detail: "The gap is too thin to see much through it", anim: "none", tone: "warn" };
  }
  if (hasGap && st.gapWidthFrac > FARTHER_ABOVE) {
    return { id: "farther", title: "Move back a little", detail: "The gap fills too much of the view", anim: "none", tone: "warn" };
  }

  if (st.phase === "searching") {
    if (!st.candidate) {
      return {
        id: "aim",
        title: "Point at a narrow gap",
        detail:
          i.searchingFor > SUGGEST_DRAG_AFTER_MS
            ? "Not finding it? Drag across the gap to pick it yourself"
            : "Hold the phone upright, so the gap runs up the screen",
        anim: "aim",
        tone: "neutral",
      };
    }
    if (st.quality < st.threshold) {
      return {
        id: "faint",
        title: "Gap is too faint",
        detail: "Add light, move closer, or drag across it to record anyway",
        anim: "none",
        tone: "warn",
      };
    }
    if (st.awaitingParallax) {
      return { id: "confirm", title: "Slide sideways a little", detail: "to check it's a real opening", anim: "slide", tone: "neutral" };
    }
    return { id: "locking", title: "Gap found", detail: "Hold steady…", anim: "steady", tone: "good", progress: st.lockProgress };
  }

  // Tracking.
  if (!st.recording) {
    if (st.awaitingParallax) {
      return {
        id: "confirm",
        title: "Now slide sideways",
        detail: "Recording starts once the view through the gap shifts",
        anim: "slide",
        tone: "neutral",
      };
    }
    return { id: "faded", title: "Gap got faint", detail: "Hold steady and keep it in view", anim: "steady", tone: "warn" };
  }
  if (st.unstable) return { id: "steady", title: "Hold steady", detail: "Keep the gap in view", anim: "steady", tone: "warn" };
  if (st.hint.startsWith("Can't")) {
    return { id: "nomatch", title: "Slow down", detail: st.hint, anim: "slide", tone: "warn" };
  }
  if (st.framesUsed < 12) {
    return {
      id: "slide",
      title: i.isDemo ? "Stitching the demo" : "Slide slowly sideways",
      detail: i.isDemo ? "The virtual camera slides by itself" : "Left and right, at the same distance",
      anim: "slide",
      tone: "good",
    };
  }
  if (i.recordingFor < SWEEP_CUE_MS) {
    return { id: "sweep", title: "Looking good", detail: "Sweep back and forth to fill in the picture", anim: "slide", tone: "good" };
  }
  return null;
}

export type PillTone = "idle" | "found" | "locked" | "rec" | "paused";

/** The short state label at the top of the viewfinder. */
export function statusPill(st: ScannerStatus | null, isDemo: boolean): { label: string; tone: PillTone } {
  if (!st) return { label: "Starting…", tone: "idle" };
  if (st.phase === "searching") {
    return st.candidate ? { label: "Gap found", tone: "found" } : { label: "Looking for a gap", tone: "idle" };
  }
  if (!st.scanning) return { label: "Paused", tone: "paused" };
  if (st.recording) {
    if (isDemo) return { label: "Stitching", tone: "rec" };
    return { label: st.forced ? "REC · picked by hand" : "REC", tone: "rec" };
  }
  return { label: "Gap locked", tone: "locked" };
}
