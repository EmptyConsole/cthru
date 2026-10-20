/** A single-channel image, values 0..255, row-major. */
export interface GrayFrame {
  data: Float32Array;
  width: number;
  height: number;
}

/** Minimal ImageData-like shape so the core works outside the browser (tests). */
export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * A vertical gap in analysis-pixel coordinates.
 * `left`/`right` are the boundaries between the occluder and the opening
 * (pixel centres sit on integers, so a boundary between pixel 9 and 10 is 9.5).
 */
export interface Gap {
  left: number;
  right: number;
}

export type Phase = "searching" | "tracking";

export interface ScannerStatus {
  phase: Phase;
  scanning: boolean;
  /** Frames are being added to the picture right now. */
  recording: boolean;
  /** The gap was picked by hand, so it records regardless of quality. */
  forced: boolean;
  /** Smoothed 0..1 quality of the tracked gap (or the current candidate while searching). */
  quality: number;
  /** Quality needed before recording starts. */
  threshold: number;
  /** Gap currently being tracked (analysis px). */
  gap: Gap | null;
  /** Best candidate while searching (analysis px). */
  candidate: Gap | null;
  /** 0..1 progress towards auto-locking the candidate. */
  lockProgress: number;
  /** 0..1 edge strength of the tracked/candidate gap. */
  confidence: number;
  /** NCC score of the last registration, or null if none ran. */
  matchScore: number | null;
  /** Width of the reconstructed area, in multiples of the gap width. */
  coverage: number;
  /** Frames integrated into the mosaic. */
  framesUsed: number;
  /** Smoothed motion of background content relative to the gap (analysis px/frame, + = rightwards). */
  revealRate: number;
  /** The user is turning the device instead of sliding it. */
  rotating: boolean;
  /** Recording waits for parallax confirmation. */
  requireParallax: boolean;
  /** Parallax score of the tracked gap / candidate: inside moves differently from the sides (-1..1). */
  parallax: number;
  /** How much parallax evidence has been observed for it, 0..1. */
  parallaxConf: number;
  /** It has shown parallax: the view through it really shifts against its edges. */
  parallaxConfirmed: boolean;
  /** Recording is held back until parallax is confirmed. */
  awaitingParallax: boolean;
  hint: string;
}
