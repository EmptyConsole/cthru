import {
  computeEdgeProfile,
  detectGap,
  gapQuality,
  pairMotion,
  trackGap,
  type EdgeProfile,
  type MotionEvidence,
} from "./edges";
import { Accumulator } from "./mosaic";
import { MotionEstimator, type MotionResult } from "./motion";
import { registerStrip } from "./registration";
import type { Gap, GrayFrame, Phase, RGBAImage, ScannerStatus } from "./types";

export interface ScannerOptions {
  /** Analysis frame size. */
  width: number;
  height: number;
  /** Colour frame pixels per analysis pixel. */
  colorScale: number;
  /** Consecutive stable, good-enough detections needed before auto-locking. */
  autoLockFrames?: number;
  /** Initial recording threshold, see `GapScanner.threshold`. */
  threshold?: number;
  /** See `GapScanner.requireParallax`. Defaults to true. */
  requireParallax?: boolean;
}

/** Returns colour pixels for colour-frame columns [sx0, sx1), full height. */
export type ColorStripProvider = (sx0: number, sx1: number) => RGBAImage;

export interface MosaicView {
  image: RGBAImage;
  /** Where the current gap strip sits in `image`, in image pixels (null if unknown). */
  window: { x: number; width: number } | null;
}

const LOST_AFTER = 15;
const MIN_TRACK_CONFIDENCE = 0.15;
/** Frames the quality must stay at/above the threshold before recording (re)starts. */
const ARM_FRAMES = 5;
/** Frames below (threshold - QUALITY_HYSTERESIS) before recording pauses. */
const DISARM_FRAMES = 10;
const QUALITY_HYSTERESIS = 0.08;
/** Give up on a tracked gap that stays below the threshold this long, and look for a better one. */
const GIVE_UP_FRAMES = 90;
export const DEFAULT_THRESHOLD = 0.5;
/** Per-frame learning rate of the parallax evidence map (scaled by how much differential motion the frame shows). */
const MOTION_RATE = 0.2;
/** Parallax score / confidence a gap needs (for CONFIRM_FRAMES frames) to count as confirmed. */
const CONFIRM_SCORE = 0.2;
const CONFIRM_CONF = 0.25;
const CONFIRM_FRAMES = 3;

const smoothstep = (x: number, lo: number, hi: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * Builds a wide picture of what is behind a vertical gap.
 *
 * Geometry: the occluder is close, the hidden scene is further away. Sliding
 * the device moves the near occluder (and so the gap) more than the far scene,
 * so the scene slides *relative to the gap* and different slices of it become
 * visible. Sliding right reveals what is further left — the opposite of a
 * normal panorama. Because each slice is placed where its content matches the
 * mosaic (not in sweep order), the result has the scene's true orientation.
 */
export class GapScanner {
  readonly width: number;
  readonly height: number;
  readonly colorScale: number;
  readonly colorWidth: number;
  readonly colorHeight: number;

  phase: Phase = "searching";
  /** User-controlled pause switch. */
  scanning = true;
  /**
   * Minimum gap quality (0..1) needed before frames are recorded into the
   * picture. Auto-locking needs it too; a gap the user picks by hand skips it.
   */
  threshold: number;
  /** Frames are currently being added to the picture (gap good enough, or picked by hand). */
  recording = false;
  /** Increments every time recording starts — lets the UI give feedback (e.g. a vibration). */
  recordStarts = 0;
  /**
   * Only record once sliding the device has shown that the view through the
   * gap shifts relative to its edges (parallax). This is what tells a real
   * opening from a rectangle on the wall that merely looks like one.
   */
  requireParallax: boolean;
  /** The current gap / candidate has shown parallax. */
  parallaxConfirmed = false;
  /** Latest motion analysis (for debugging overlays). */
  lastMotion: MotionResult | null = null;
  /** Per-column parallax evidence, kept aligned with the occluder as it moves. */
  readonly motionMap: MotionEvidence;
  gap: Gap | null = null;
  candidate: Gap | null = null;
  lastProfile: EdgeProfile | null = null;
  /** Strip columns [x0, x1) used in the most recent frame. */
  lastStrip: [number, number] | null = null;

  private readonly autoLockFrames: number;
  private candidateStreak = 0;
  /** Consecutive frames whose best detection disagreed with the current candidate. */
  private candidateMisses = 0;
  private confidence = 0;
  private lostFrames = 0;
  /** The last unlock happened because tracking failed (not because the user asked). */
  private lostTrack = false;
  /** The last unlock happened because the gap never got good enough. */
  private rejected = false;
  /** The gap was picked by the user, so it records regardless of quality. */
  private forced = false;
  /** Smoothed gap quality of the tracked gap or current candidate. */
  private quality = 0;
  private aboveStreak = 0;
  private belowStreak = 0;
  private weakFrames = 0;
  private readonly motionEst: MotionEstimator;
  /** How far the occluder moved in the image this frame (px, + = right). */
  private occluderShift = 0;
  private parallax = { score: 0, conf: 0 };
  private confirmStreak = 0;
  private refuteStreak = 0;

  private gray: Accumulator;
  private color: Accumulator;
  /** Mosaic position of frame (0,0) for the last registered frame. */
  private pos = { x: 0, y: 0 };
  private posValid = false;
  private vel = 0;
  private needGlobal = false;
  private regFails = 0;
  /** Frames to register without painting, after re-acquiring our place in the mosaic. */
  private settle = 0;
  private matchScore: number | null = null;
  private framesUsed = 0;

  private prevGapMid: number | null = null;
  private absGapMotion = 0;
  private absReveal = 0;
  private revealRate = 0;

  constructor(opts: ScannerOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.colorScale = opts.colorScale;
    this.colorWidth = Math.round(opts.width * opts.colorScale);
    this.colorHeight = Math.round(opts.height * opts.colorScale);
    this.autoLockFrames = opts.autoLockFrames ?? 8;
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.requireParallax = opts.requireParallax ?? true;
    this.motionEst = new MotionEstimator(opts.width, opts.height);
    this.motionMap = { evidence: new Float32Array(opts.width), confidence: new Float32Array(opts.width) };
    this.gray = this.makeGray();
    this.color = this.makeColor();
  }

  private makeGray() {
    return new Accumulator({ channels: 1, frameWidth: this.width, frameHeight: this.height });
  }

  private makeColor() {
    return new Accumulator({ channels: 3, frameWidth: this.colorWidth, frameHeight: this.colorHeight });
  }

  setScanning(on: boolean) {
    this.scanning = on;
  }

  /** User-selected gap (e.g. by dragging across it). */
  setManualGap(gap: Gap) {
    const left = Math.max(1, Math.min(gap.left, gap.right));
    const right = Math.min(this.width - 2, Math.max(gap.left, gap.right));
    if (right - left < 3) return;
    this.lockOnto({ left, right }, true);
  }

  unlock(lost = false) {
    this.lostTrack = lost;
    this.rejected = false;
    this.phase = "searching";
    this.recording = false;
    this.forced = false;
    this.aboveStreak = 0;
    this.belowStreak = 0;
    this.weakFrames = 0;
    this.gap = null;
    this.candidate = null;
    this.candidateStreak = 0;
    this.prevGapMid = null;
    this.lastStrip = null;
    this.resetParallax();
    if (!this.gray.isEmpty) this.needGlobal = true;
  }

  private resetParallax() {
    this.parallaxConfirmed = false;
    this.confirmStreak = 0;
    this.refuteStreak = 0;
  }

  resetMosaic() {
    this.gray = this.makeGray();
    this.color = this.makeColor();
    this.posValid = false;
    this.vel = 0;
    this.needGlobal = false;
    this.regFails = 0;
    this.settle = 0;
    this.matchScore = null;
    this.framesUsed = 0;
    this.absGapMotion = 0;
    this.absReveal = 0;
    this.revealRate = 0;
  }

  private lockOnto(gap: Gap, forced: boolean) {
    this.phase = "tracking";
    this.forced = forced;
    this.rejected = false;
    this.lostTrack = false;
    this.belowStreak = 0;
    this.weakFrames = 0;
    // A hand-picked gap is a new gap; an auto-locked one keeps the parallax it showed as a candidate.
    if (forced) this.resetParallax();
    // Auto-locking already required the quality to clear the threshold.
    if (forced || this.recordingAllowed) this.startRecording();
    else this.recording = false;
    this.gap = gap;
    this.candidate = null;
    this.candidateStreak = 0;
    this.lostFrames = 0;
    this.prevGapMid = null;
    if (!this.gray.isEmpty) this.needGlobal = true;
  }

  private startRecording() {
    if (!this.recording) this.recordStarts++;
    this.recording = true;
    this.aboveStreak = 0;
    this.belowStreak = 0;
  }

  /** Besides quality: has the gap shown parallax (if that's required)? */
  private get recordingAllowed() {
    return !this.requireParallax || this.parallaxConfirmed;
  }

  /** Recording gate with hysteresis, so a borderline gap doesn't flicker on and off. */
  private updateRecording() {
    if (this.forced) {
      if (!this.recording) this.startRecording();
      return;
    }
    const q = this.quality;
    if (this.recording) {
      this.belowStreak = q < this.threshold - QUALITY_HYSTERESIS ? this.belowStreak + 1 : 0;
      if (this.belowStreak >= DISARM_FRAMES || !this.recordingAllowed) {
        this.recording = false;
        this.aboveStreak = 0;
      }
    } else {
      this.aboveStreak = q >= this.threshold ? this.aboveStreak + 1 : 0;
      if (this.aboveStreak >= ARM_FRAMES && this.recordingAllowed) this.startRecording();
    }
    // A gap that never gets good enough is probably not a real gap: look for another.
    this.weakFrames = !this.recording && q < this.threshold ? this.weakFrames + 1 : 0;
    if (this.weakFrames > GIVE_UP_FRAMES) {
      this.unlock();
      this.rejected = true;
    }
  }

  /**
   * Update the per-column parallax evidence. The map is shifted with the
   * occluder each frame, so evidence stays attached to the same place on the
   * wall (and so to the same gap) while the device moves.
   */
  private updateMotion(frame: GrayFrame) {
    const m = this.motionEst.update(frame);
    this.lastMotion = m;
    const { evidence: E, confidence: C } = this.motionMap;
    const w = this.width;
    if (!m || m.reliability < 0.3) {
      // We don't know how things moved: keep the map but trust it less.
      this.occluderShift = 0;
      if (m) for (let x = 0; x < w; x++) C[x] *= 0.5;
      return;
    }
    // Current column x shows what was at previous column x + dx.
    this.occluderShift = -m.dx;
    if (m.dx !== 0) {
      const e2 = new Float32Array(w);
      const c2 = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        const xp = x + m.dx;
        const i = Math.floor(xp);
        const f = xp - i;
        if (i >= 0 && i + 1 < w) {
          e2[x] = E[i] * (1 - f) + E[i + 1] * f;
          c2[x] = C[i] * (1 - f) + C[i + 1] * f;
        }
      }
      E.set(e2);
      C.set(c2);
    }
    for (let x = 0; x < w; x++) C[x] *= 0.997;

    // Learn only from frames that actually show differential motion somewhere
    // (sliding, not standing still or just turning), relative to the strongest.
    // Seeing parallax counts quickly. *Not* seeing it counts slowly and only
    // when something else in the frame clearly moves differently — otherwise
    // merely pausing at the end of a sweep would erase a real gap's evidence.
    const kUp = MOTION_RATE * smoothstep(m.activity, 0.12, 0.35);
    const kDown = 0.3 * MOTION_RATE * smoothstep(m.activity, 0.3, 0.6);
    if (kUp <= 0) return;
    const norm = Math.max(m.activity, 0.25);
    for (let x = 0; x < w; x++) {
      const obs = m.observed[x];
      if (obs <= 0) continue;
      const n = Math.min(1, m.change[x] / norm);
      const k = (n > E[x] ? kUp : kDown) * obs;
      E[x] += k * (n - E[x]);
      C[x] += kUp * obs * (1 - C[x]);
    }
  }

  /** Track whether the gap at columns `cols` has shown parallax. */
  private updateParallax(cols: [number, number]) {
    const pm = pairMotion(this.motionMap, cols[0], cols[1]);
    this.parallax = pm;
    if (!this.parallaxConfirmed) {
      this.confirmStreak = pm.conf >= CONFIRM_CONF && pm.score >= CONFIRM_SCORE ? this.confirmStreak + 1 : 0;
      if (this.confirmStreak >= CONFIRM_FRAMES) this.parallaxConfirmed = true;
    } else {
      // Strong evidence that it doesn't move differently after all.
      this.refuteStreak = pm.conf >= 0.5 && pm.score < 0.05 ? this.refuteStreak + 1 : 0;
      if (this.refuteStreak > 30) this.resetParallax();
    }
  }

  processFrame(frame: GrayFrame, getColorStrip: ColorStripProvider): void {
    this.updateMotion(frame);
    const profile = computeEdgeProfile(frame);
    this.lastProfile = profile;

    if (this.phase === "searching") {
      this.search(profile);
      return;
    }

    const prev = this.gap!;
    const tr = trackGap(profile, prev, this.motionMap, this.occluderShift);
    if (!tr || tr.confidence < MIN_TRACK_CONFIDENCE || tr.gap.right - tr.gap.left < 3) {
      this.confidence = tr?.confidence ?? 0;
      this.quality *= 0.85;
      this.lastStrip = null;
      if (++this.lostFrames > LOST_AFTER) this.unlock(true);
      return;
    }
    this.lostFrames = 0;
    this.confidence = tr.confidence;
    this.quality += 0.25 * (gapQuality(profile, tr.cols[0], tr.cols[1], this.motionMap) - this.quality);
    this.updateParallax(tr.cols);
    this.updateRecording();
    if (this.phase !== "tracking") return;
    // Smooth small jitter, but follow real jumps immediately.
    const jump = Math.abs(tr.gap.left - prev.left) + Math.abs(tr.gap.right - prev.right);
    const a = jump > 4 ? 1 : 0.65;
    this.gap = {
      left: prev.left + a * (tr.gap.left - prev.left),
      right: prev.right + a * (tr.gap.right - prev.right),
    };

    const mid = (this.gap.left + this.gap.right) / 2;
    const gapShift = this.prevGapMid === null ? 0 : mid - this.prevGapMid;
    this.prevGapMid = mid;

    const gw = this.gap.right - this.gap.left;
    const margin = Math.max(1, gw * 0.15);
    const x0 = Math.ceil(this.gap.left + margin);
    const x1 = Math.floor(this.gap.right - margin) + 1;
    if (x1 - x0 < 3) {
      this.lastStrip = null;
      return;
    }
    this.lastStrip = [x0, x1];
    if (this.scanning && this.recording) this.integrate(frame, getColorStrip, x0, x1, gapShift);
  }

  private search(profile: EdgeProfile) {
    const det = detectGap(profile, {}, this.motionMap);
    if (!det || det.confidence < 0.2) {
      this.candidate = null;
      this.candidateStreak = 0;
      this.confidence = det?.confidence ?? 0;
      this.quality *= 0.8;
      return;
    }
    const raw = det.quality;
    const tol = Math.max(3, this.width * 0.03);
    // The candidate moves with the occluder.
    const sh = this.occluderShift;
    const c = this.candidate ? { left: this.candidate.left + sh, right: this.candidate.right + sh } : null;
    if (c) this.candidate = c;
    if (c && Math.abs(c.left - det.gap.left) < tol && Math.abs(c.right - det.gap.right) < tol) {
      // Follow the gap closely: it moves while the user aims the device.
      this.candidate = {
        left: c.left + 0.7 * (det.gap.left - c.left),
        right: c.right + 0.7 * (det.gap.right - c.right),
      };
      this.quality += 0.3 * (raw - this.quality);
      this.candidateMisses = 0;
    } else if (c && raw < this.quality + 0.1 && ++this.candidateMisses < 3) {
      // A one-off disagreement with a candidate that isn't clearly better: keep ours.
      return;
    } else {
      // A different candidate: start judging it afresh.
      this.candidateMisses = 0;
      this.candidateStreak = 0;
      this.candidate = det.gap;
      this.quality = raw;
      this.resetParallax();
    }
    this.updateParallax(det.cols);
    this.confidence = det.confidence;
    // Only a candidate that is stable *and* good enough counts towards locking.
    this.candidateStreak = this.quality >= this.threshold ? this.candidateStreak + 1 : 0;
    if (this.candidateStreak >= this.autoLockFrames) this.lockOnto(this.candidate, false);
  }

  private integrate(frame: GrayFrame, getColorStrip: ColorStripProvider, x0: number, x1: number, gapShift: number) {
    const S = this.colorScale;

    if (this.gray.isEmpty) {
      this.pos = { x: 0, y: 0 };
    } else {
      const sw = x1 - x0;
      let reg;
      if (this.needGlobal || !this.posValid) {
        const [e0, e1] = this.gray.localExtentX;
        const lo = e0 - x0 - sw * 0.5;
        const hi = e1 - x1 + sw * 0.5;
        const coarse = registerStrip(frame, this.gray, {
          x0, x1, predX: 0, predY: this.pos.y, rx: 0, ry: 6,
          rangeX: [Math.min(lo, hi), Math.max(lo, hi)], rowStep: 3, stepX: 2, minScore: 0.6, minOverlap: 0.4,
        });
        reg = coarse.ok
          ? registerStrip(frame, this.gray, { x0, x1, predX: coarse.dx, predY: coarse.dy, rx: 3, ry: 2, minScore: 0.7 })
          : coarse;
      } else {
        // Widen the search after each miss in case the view jumped.
        const widen = 1 + Math.min(this.regFails, 4);
        const rx = Math.min(60, Math.max(6, Math.ceil(Math.abs(this.vel) * 1.5) + 4) * widen);
        reg = registerStrip(frame, this.gray, {
          x0, x1, predX: this.pos.x + this.vel, predY: this.pos.y, rx, ry: 3 + Math.min(this.regFails, 3),
        });
      }
      this.matchScore = reg.score;
      if (!reg.ok) {
        this.regFails++;
        this.vel *= 0.8;
        // After a run of failures our position guess is stale: search everywhere.
        if (this.regFails > 5) this.needGlobal = true;
        // Edges look fine but nothing matches: we may be tracking the wrong
        // pair of edges. Detect the gap again from scratch.
        if (this.regFails > 30) {
          this.regFails = 0;
          this.unlock(true);
        }
        return;
      }
      const wasGlobal = this.needGlobal || !this.posValid;
      if (wasGlobal) this.settle = 2;
      const step = reg.dx - this.pos.x;
      if (!wasGlobal) {
        this.vel = 0.5 * this.vel + 0.5 * step;
        // Background image motion is -step; relative to the gap it moved (-step - gapShift).
        const reveal = -step - gapShift;
        const k = 0.15;
        this.revealRate += k * (reveal - this.revealRate);
        this.absReveal += k * (Math.abs(reveal) - this.absReveal);
        this.absGapMotion += k * (Math.abs(gapShift) - this.absGapMotion);
      } else {
        this.vel = 0;
      }
      this.pos = { x: reg.dx, y: reg.dy };
      this.regFails = 0;
      this.needGlobal = false;
      this.posValid = true;
      // Confirm the new placement on a couple of frames before painting with it.
      if (this.settle > 0) {
        this.settle--;
        return;
      }
    }

    this.posValid = true;
    const weightScale = this.matchScore === null ? 1 : Math.max(0.2, (this.matchScore - 0.5) * 2);
    this.gray.accumulate(frame, 1, 0, x0, x1, this.pos.x, this.pos.y, weightScale);

    const sx0 = Math.max(0, Math.floor(x0 * S));
    const sx1 = Math.min(this.colorWidth, Math.ceil(x1 * S) + 1);
    const strip = getColorStrip(sx0, sx1);
    this.color.accumulate(strip, 4, sx0, x0 * S, Math.min(x1 * S, sx1), this.pos.x * S, this.pos.y * S, weightScale);
    this.framesUsed++;
  }

  getMosaicView(): MosaicView | null {
    const img = this.color.toRGBA();
    if (!img) return null;
    let win: MosaicView["window"] = null;
    if (this.lastStrip && this.posValid && this.phase === "tracking") {
      const S = this.colorScale;
      const x = (this.lastStrip[0] + this.pos.x) * S + this.color.originX - img.x0;
      win = { x, width: (this.lastStrip[1] - this.lastStrip[0]) * S };
    }
    return { image: { data: img.data, width: img.width, height: img.height }, window: win };
  }

  getStatus(): ScannerStatus {
    const gw = this.gap ? this.gap.right - this.gap.left : this.candidate ? this.candidate.right - this.candidate.left : 0;
    const [e0, e1] = this.gray.isEmpty ? [0, -1] : this.gray.localExtentX;
    const coverage = gw > 0 && e1 >= e0 ? (e1 - e0 + 1) / gw : 0;
    const rotating = this.framesUsed > 15 && this.absGapMotion > 0.7 && this.absReveal < 0.25 * this.absGapMotion;
    const gapWidthFrac = this.width > 0 ? gw / this.width : 0;
    const unstable =
      this.lostFrames > 0 ||
      rotating ||
      (this.phase === "tracking" && this.absGapMotion > 1.1 && Math.abs(this.revealRate) < 0.12);

    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const belowThreshold = this.quality < this.threshold;
    const awaitingParallax = !this.forced && this.requireParallax && !this.parallaxConfirmed;
    let hint: string;
    if (this.phase === "searching") {
      if (this.candidate && belowThreshold) {
        hint = `Gap found, but its quality (${pct(this.quality)}) is below the ${pct(this.threshold)} needed to record. Get closer, add light, hold it upright, or lower the threshold. Dragging across the gap also starts recording.`;
      } else if (this.candidate && awaitingParallax) {
        hint = "Found a likely gap. Slide the device sideways a little to confirm it's a real opening.";
      } else if (this.candidate) hint = "Found a good gap. Hold steady and recording will start.";
      else if (this.rejected) hint = "That gap never got clear enough to record. Looking for a better one…";
      else if (this.lostTrack) hint = "Lost the gap. Point back at it to continue the scan.";
      else hint = "Point the camera at a vertical gap and hold the device upright. You can also drag across the gap to pick it.";
    } else if (!this.scanning) {
      hint = "Paused. The gap is still tracked. Press Resume to keep building the image.";
    } else if (!this.recording && awaitingParallax) {
      hint =
        "Gap found. Now slide the device sideways a little. Recording starts once the view through the gap shifts against its edges, which shows it's a real opening and not just something on the wall.";
    } else if (!this.recording) {
      hint = `Not recording: the gap's quality (${pct(this.quality)}) dropped below ${pct(this.threshold)}. Hold steady and keep it in view, and recording resumes when it's clearer.`;
    } else if (this.lostFrames > 0) {
      hint = "Losing the gap edges. Keep the gap in view.";
    } else if (this.needGlobal && this.regFails > 0) {
      hint = "Can't place this view yet. Move back over the part you already scanned, or press Reset.";
    } else if (this.regFails > 4) {
      hint = "Can't match what's behind the gap. Move more slowly, or add light (torch).";
    } else if (rotating) {
      hint = "You're turning the device. Slide it sideways instead (keep the same distance) to see new parts.";
    } else if (this.framesUsed < 12) {
      hint = "Locked. Now slowly slide the device sideways, left and right.";
    } else if (Math.abs(this.revealRate) > 0.15) {
      const side = this.revealRate > 0 ? "left" : "right";
      hint = `Revealing more on the ${side} side. Keep going, then sweep back the other way.`;
    } else {
      hint = "Keep sliding sideways to reveal more of what's behind the gap.";
    }

    return {
      phase: this.phase,
      scanning: this.scanning,
      recording: this.recording && this.scanning && this.phase === "tracking",
      forced: this.forced,
      quality: this.quality,
      threshold: this.threshold,
      gap: this.gap,
      candidate: this.candidate,
      lockProgress: this.phase === "tracking" ? 1 : Math.min(1, this.candidateStreak / this.autoLockFrames),
      confidence: this.confidence,
      matchScore: this.matchScore,
      coverage,
      framesUsed: this.framesUsed,
      revealRate: this.revealRate,
      rotating,
      requireParallax: this.requireParallax,
      parallax: this.parallax.score,
      parallaxConf: this.parallax.conf,
      parallaxConfirmed: this.parallaxConfirmed,
      awaitingParallax: this.phase === "tracking" ? awaitingParallax : this.requireParallax && !this.parallaxConfirmed,
      gapWidthFrac,
      unstable,
      hint,
    };
  }
}

/** Convert RGBA to luma (0..255). Reuses `out` when it has the right size. */
export function rgbaToGray(img: RGBAImage, out?: Float32Array): GrayFrame {
  const n = img.width * img.height;
  const data = out && out.length === n ? out : new Float32Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) data[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  return { data, width: img.width, height: img.height };
}
