import { describe, expect, it } from "vitest";
import { computeEdgeProfile, detectGap } from "../edges";
import { GapScanner } from "../scanner";
import type { GrayFrame, RGBAImage } from "../types";

// --- Synthetic world -------------------------------------------------------

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy - 0.5;
}

/** The hidden scene, in its own coordinates. */
const scene = (u: number, v: number) => 120 + 150 * noise(u / 9, v / 9) + 70 * noise(u / 3.5 + 50, v / 3.5) + 15 * Math.sin(u / 23);
/** A light, grainy fence board. */
const fence = (x: number, y: number) => 190 + 25 * noise(x / 5 + 300, y / 60);

const W = 320;
const H = 240;
const SLIT = 36;
const K_NEAR = 1;
const K_FAR = 0.3;

interface Pose {
  occShift: number;
  bgShift: number;
  dy: number;
}

/**
 * The camera slides by T while turning to keep the gap roughly centred (as a
 * person does). Turning moves both layers equally; sliding moves the near
 * fence more than the far scene.
 */
function pose(t: number): Pose {
  const T = 140 * Math.sin((t / 120) * Math.PI);
  const turn = -0.8 * K_NEAR * T;
  return { occShift: K_NEAR * T + turn, bgShift: K_FAR * T + turn, dy: 1.5 * Math.sin(t * 0.21) };
}

/** Fence with dark board seams: strong vertical lines that compete with the gap's edges. */
const seamedFence = (x: number, y: number) => {
  const m = (((x - 7) % 41) + 41) % 41;
  return m < 1.5 ? 110 : fence(x, y);
};

function render(p: Pose, t = 0, noiseAmp = 0, gain = 1, occluder = fence, slit = SLIT): GrayFrame {
  const data = new Float32Array(W * H);
  const s0 = W / 2 - slit / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const xo = x + p.occShift;
      const inSlit = xo >= s0 && xo < s0 + slit;
      const v = inSlit ? scene(x + p.bgShift, y + p.dy) : occluder(xo, y);
      data[y * W + x] = Math.max(0, Math.min(255, v * gain + noiseAmp * (hash(x + t * 977, y) - 0.5)));
    }
  }
  return { data, width: W, height: H };
}

function toRGBA(f: GrayFrame): RGBAImage {
  const d = new Uint8ClampedArray(f.width * f.height * 4);
  for (let i = 0; i < f.data.length; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = f.data[i];
    d[i * 4 + 3] = 255;
  }
  return { data: d, width: f.width, height: f.height };
}

function crop(img: RGBAImage, sx0: number, sx1: number): RGBAImage {
  const w = sx1 - sx0;
  const out = new Uint8ClampedArray(w * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    out.set(img.data.subarray((y * img.width + sx0) * 4, (y * img.width + sx1) * 4), y * w * 4);
  }
  return { data: out, width: w, height: img.height };
}

function ncc(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

// --- Tests ------------------------------------------------------------------

describe("gap detection", () => {
  it("finds the slit in a single frame", () => {
    const det = detectGap(computeEdgeProfile(render(pose(0))));
    expect(det).not.toBeNull();
    expect(det!.gap.left).toBeCloseTo(W / 2 - SLIT / 2 - 0.5, 0);
    expect(det!.gap.right).toBeCloseTo(W / 2 + SLIT / 2 - 0.5, 0);
  });
});

describe("GapScanner", () => {
  it("locks on, tracks, and reconstructs the hidden scene in its true orientation", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = scanner as any;
    let lockedAt = -1;
    let firstPose: Pose | null = null;
    let maxGapErr = 0;
    let maxRegErr = 0;

    for (let t = 0; t < 240; t++) {
      const p = pose(t);
      const frame = render(p);
      const rgba = toRGBA(frame);
      const before = internals.framesUsed;
      scanner.processFrame(frame, (a, b) => crop(rgba, a, b));

      if (scanner.phase === "tracking" && lockedAt < 0) lockedAt = t;
      if (scanner.gap && t > lockedAt + 3) {
        const trueLeft = W / 2 - SLIT / 2 - 0.5 - p.occShift;
        maxGapErr = Math.max(maxGapErr, Math.abs(scanner.gap.left - trueLeft));
      }
      if (internals.framesUsed > before) {
        if (!firstPose) firstPose = p;
        // Frame x maps to mosaic x + pos.x; the scene coordinate is x + bgShift.
        const expected = p.bgShift - firstPose.bgShift;
        maxRegErr = Math.max(maxRegErr, Math.abs(internals.pos.x - expected));
      }
    }

    expect(lockedAt).toBeGreaterThanOrEqual(0);
    expect(lockedAt).toBeLessThan(15);
    expect(maxGapErr).toBeLessThan(2);
    expect(maxRegErr).toBeLessThan(1);

    const status = scanner.getStatus();
    expect(status.framesUsed).toBeGreaterThan(200);
    expect(status.coverage).toBeGreaterThan(4);

    // Compare the mosaic with the ground-truth scene, and with its mirror image.
    const gray = internals.gray;
    const got: number[] = [];
    const truth: number[] = [];
    const mirrored: number[] = [];
    const cx = (gray.minX + gray.maxX) / 2;
    for (let Y = gray.minY + 10; Y < gray.maxY - 10; Y += 3) {
      for (let X = gray.minX + 2; X < gray.maxX - 2; X += 2) {
        const idx = Y * gray.width + X;
        if (gray.weight[idx] < 0.5) continue;
        const u = X - gray.originX + firstPose!.bgShift;
        const v = Y - gray.originY + firstPose!.dy;
        got.push(gray.value[idx]);
        truth.push(scene(u, v));
        mirrored.push(scene(2 * (cx - gray.originX + firstPose!.bgShift) - u, v));
      }
    }
    expect(got.length).toBeGreaterThan(5000);
    expect(ncc(got, truth)).toBeGreaterThan(0.95);
    expect(ncc(got, mirrored)).toBeLessThan(0.5);
  });

  it("stays accurate with sensor noise and exposure drift", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = scanner as any;
    let first: Pose | null = null;
    let maxRegErr = 0;
    for (let t = 0; t < 240; t++) {
      const p = pose(t);
      const frame = render(p, t, 24, 0.85 + 0.15 * Math.sin(t / 30));
      const rgba = toRGBA(frame);
      const before = internals.framesUsed;
      scanner.processFrame(frame, (a, b) => crop(rgba, a, b));
      if (internals.framesUsed > before) {
        if (!first) first = p;
        maxRegErr = Math.max(maxRegErr, Math.abs(internals.pos.x - (p.bgShift - first.bgShift)));
      }
    }
    expect(scanner.getStatus().framesUsed).toBeGreaterThan(180);
    expect(maxRegErr).toBeLessThan(1.5);
  });

  it("recovers after the view jumps, with seams in the fence", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = scanner as any;
    let first: Pose | null = null;
    let usedAfterJump = 0;
    let maxRegErr = 0;
    // Frames 80..99 never arrive: the view jumps back over already-scanned ground.
    const times = [...Array(80).keys(), ...Array.from({ length: 160 }, (_, i) => 100 + i)];
    for (const t of times) {
      const p = pose(t);
      const frame = render(p, t, 10, 1, seamedFence);
      const rgba = toRGBA(frame);
      const before = internals.framesUsed;
      scanner.processFrame(frame, (a, b) => crop(rgba, a, b));
      if (internals.framesUsed > before) {
        if (!first) first = p;
        if (t >= 100) usedAfterJump++;
        maxRegErr = Math.max(maxRegErr, Math.abs(internals.pos.x - (p.bgShift - first.bgShift)));
      }
    }
    expect(usedAfterJump).toBeGreaterThan(150);
    expect(maxRegErr).toBeLessThan(1.5);
  });

});

describe("recording trigger", () => {
  const run = (scanner: GapScanner, from: number, to: number, slit = SLIT) => {
    for (let t = from; t < to; t++) {
      const frame = render(pose(t), t, 10, 1, seamedFence, slit);
      const rgba = toRGBA(frame);
      scanner.processFrame(frame, (a, b) => crop(rgba, a, b));
    }
  };

  it("never records when there is no real gap", () => {
    // Only board seams: strong vertical lines, but the same fence shows between them.
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1 });
    run(scanner, 0, 120, 0);
    const st = scanner.getStatus();
    expect(st.framesUsed).toBe(0);
    expect(st.recording).toBe(false);
    expect(st.quality).toBeLessThan(0.4);
  });

  it("waits until the gap clears the threshold, and starts once it does", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1, threshold: 0.995 });
    run(scanner, 0, 60);
    expect(scanner.getStatus().framesUsed).toBe(0);
    expect(scanner.getStatus().quality).toBeGreaterThan(0.6);

    scanner.threshold = 0.5;
    run(scanner, 60, 90);
    const st = scanner.getStatus();
    expect(st.recording).toBe(true);
    expect(st.framesUsed).toBeGreaterThan(15);
    expect(scanner.recordStarts).toBe(1);
  });

  it("records a hand-picked gap regardless of the threshold", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1, threshold: 0.995 });
    run(scanner, 0, 3);
    scanner.setManualGap({ left: W / 2 - SLIT / 2 - 0.5, right: W / 2 + SLIT / 2 - 0.5 });
    run(scanner, 3, 40);
    expect(scanner.getStatus().forced).toBe(true);
    expect(scanner.getStatus().framesUsed).toBeGreaterThan(25);
  });

  it("accepts a gap whose inside averages the same brightness as the occluder", () => {
    // Same mean as the fence (~190), but varying down the frame like a real scene.
    const evenScene = (u: number, v: number) => 190 + 55 * Math.sin(v / 17) + 30 * noise(u / 6, v / 6);
    const data = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        data[y * W + x] = x >= W / 2 - SLIT / 2 && x < W / 2 + SLIT / 2 ? evenScene(x, y) : fence(x, y);
      }
    }
    const p = computeEdgeProfile({ data, width: W, height: H });
    const det = detectGap(p)!;
    expect(det.gap.left).toBeCloseTo(W / 2 - SLIT / 2 - 0.5, 0);
    expect(det.quality).toBeGreaterThan(0.6);
  });
});
