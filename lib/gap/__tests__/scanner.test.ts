import { describe, expect, it } from "vitest";
import { computeEdgeProfile, detectGap } from "../edges";
import { GapScanner } from "../scanner";
import {
  crop,
  fence,
  H,
  ncc,
  noise,
  pose,
  render,
  renderWorld,
  scene,
  seamedFence,
  SLIT,
  toRGBA,
  W,
  type Pose,
  type WorldOptions,
} from "./synthetic";

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

describe("telling real gaps from look-alikes", () => {
  const STRIP = { offset: 0, width: 40 };
  const OPENING = { offset: 85, width: 36 };

  /** Runs a sequence; returns per-frame [gap centre in wall coords | null, recorded this frame]. */
  const run = (scanner: GapScanner, world: WorldOptions, frames: number, still = false) => {
    const log: { centre: number | null; recorded: boolean }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const I = scanner as any;
    for (let t = 0; t < frames; t++) {
      const p = still ? pose(0) : pose(t);
      const frame = renderWorld(p, { ...world, t, noiseAmp: 8 });
      const rgba = toRGBA(frame);
      const before = I.framesUsed;
      scanner.processFrame(frame, (a, b) => crop(rgba, a, b));
      const g = scanner.gap;
      log.push({
        centre: g ? (g.left + g.right) / 2 + 0.5 + p.occShift - W / 2 : null,
        recorded: I.framesUsed > before,
      });
    }
    return log;
  };
  const near = (c: number | null, o: { offset: number }) => c !== null && Math.abs(c - o.offset) < 8;

  it("prefers a real opening over a full-height strip on the wall, once the device slides", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1 });
    const log = run(scanner, { slits: [OPENING], objects: [STRIP] }, 150);
    // Never records the strip on the wall…
    expect(log.filter((l) => l.recorded && near(l.centre, STRIP)).length).toBe(0);
    // …ends up on the real opening, and records it.
    expect(near(log[log.length - 1].centre, OPENING)).toBe(true);
    expect(log.filter((l) => l.recorded && near(l.centre, OPENING)).length).toBeGreaterThan(60);
  });

  it("puts the boundary where see-through starts, not on edge faces right beside the opening", () => {
    // A 30 px opening with a dark 6 px strip against its left side and a
    // bright 7 px strip against its right side, both fixed to the wall — like
    // the lit edge faces of two table tops either side of a gap.
    const world: WorldOptions = {
      slits: [{ offset: 0, width: 30 }],
      objects: [
        { offset: -18, width: 6, value: 80 },
        { offset: 18.5, width: 7, value: 245 },
      ],
    };
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1 });
    const log = run(scanner, world, 160);
    const recorded = log.filter((l) => l.recorded);
    expect(recorded.length).toBeGreaterThan(120);
    // Every recorded frame is centred on the opening (a slice or a strip-inclusive pair would be off-centre)…
    expect(recorded.every((l) => near(l.centre, { offset: 0 }))).toBe(true);
    // …and, once settled, has the opening's true edges.
    const g = scanner.gap!;
    const occ = pose(159).occShift;
    expect(Math.abs(g.left + 0.5 + occ - W / 2 - -15)).toBeLessThan(2);
    expect(Math.abs(g.right + 0.5 + occ - W / 2 - 15)).toBeLessThan(2);
  });

  it("never records a gap look-alike on the wall, even while sliding", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1 });
    const log = run(scanner, { objects: [STRIP] }, 150);
    expect(log.filter((l) => l.recorded).length).toBe(0);
    expect(scanner.getStatus().parallaxConfirmed).toBe(false);
  });

  it("standing still, prefers a full-height opening over a shorter rectangle", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1, requireParallax: false });
    const log = run(scanner, { slits: [OPENING], objects: [{ ...STRIP, top: 0.25, bottom: 0.75 }] }, 40, true);
    expect(near(log[log.length - 1].centre, OPENING)).toBe(true);
  });

  it("waits for the device to slide before recording a real opening", () => {
    const scanner = new GapScanner({ width: W, height: H, colorScale: 1 });
    const still = run(scanner, { slits: [OPENING] }, 40, true);
    expect(scanner.phase).toBe("tracking");
    expect(still.filter((l) => l.recorded).length).toBe(0);
    expect(scanner.getStatus().awaitingParallax).toBe(true);
  });
});

