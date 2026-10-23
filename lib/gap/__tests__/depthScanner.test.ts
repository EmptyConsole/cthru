import { describe, expect, it } from "vitest";
import { findDepthGaps } from "../depthGap";
import { GapScanner } from "../scanner";
import { crop, depthWorld, pose, renderWorld, toRGBA, W, H, type WorldOptions } from "./synthetic";

/**
 * Runs the scanner in depth mode over a sliding sequence. Depth results are
 * computed from frame `t - lag` and handed over only every `every` frames,
 * like a real depth worker running behind the camera.
 */
function run(world: WorldOptions, frames: number, { lag = 5, every = 4, start = 0 } = {}) {
  const scanner = new GapScanner({ width: W, height: H, colorScale: 1, mode: "depth", requireParallax: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const I = scanner as any;
  const log: { t: number; box: { left: number; right: number } | null; recorded: boolean; occ: number }[] = [];
  const frameIdAt = new Map<number, number>();
  for (let t = start; t < start + frames; t++) {
    const p = pose(t);
    const frame = renderWorld(p, { ...world, t, noiseAmp: 6 });
    const rgba = toRGBA(frame);
    const src = t - lag;
    if ((t - start) % every === 0 && frameIdAt.has(src)) {
      const d = depthWorld(pose(src), world, 224, 168, src);
      scanner.submitDepth({ frameId: frameIdAt.get(src)!, width: d.width, height: d.height, gaps: findDepthGaps(d).gaps });
    }
    const before = I.framesUsed;
    scanner.processFrame(frame, (a, b) => crop(rgba, a, b));
    frameIdAt.set(t, scanner.frameIndex);
    // Box in wall coordinates relative to the frame centre (where openings are defined).
    const g = scanner.gap;
    log.push({
      t,
      box: g ? { left: g.left + 0.5 + p.occShift - W / 2, right: g.right + 0.5 + p.occShift - W / 2 } : null,
      recorded: I.framesUsed > before,
      occ: p.occShift,
    });
  }
  return { scanner, log };
}

describe("GapScanner in depth mode", () => {
  const OPENING = { offset: 60, width: 34 };
  const POSTER = { offset: 0, width: 40 }; // centred, looks like a gap in a photo, but it's on the wall

  it("locks onto the real opening, not the poster, and keeps its box inside the opening", () => {
    const { scanner, log } = run({ slits: [OPENING], objects: [POSTER] }, 160);
    const lockedAt = log.findIndex((l) => l.box);
    expect(lockedAt).toBeGreaterThanOrEqual(0);
    expect(lockedAt).toBeLessThan(30);
    const lo = OPENING.offset - OPENING.width / 2;
    const hi = OPENING.offset + OPENING.width / 2;
    let outside = 0;
    let worst = 0;
    for (const l of log) {
      if (!l.box) continue;
      // Errs small: never more than ~1 px outside the true opening, despite latency and motion.
      const over = Math.max(lo - l.box.left, l.box.right - hi);
      worst = Math.max(worst, over);
      if (over > 1) outside++;
      // And covers most of it.
      expect(l.box.right - l.box.left).toBeGreaterThan(OPENING.width * 0.6);
    }
    expect(outside).toBe(0);
    expect(worst).toBeLessThan(1);
    expect(log.filter((l) => l.recorded).length).toBeGreaterThan(110);
    expect(scanner.getStatus().phase).toBe("tracking");
  });

  it("never records a wall with only a gap look-alike on it", () => {
    const { log } = run({ objects: [POSTER] }, 120);
    expect(log.filter((l) => l.recorded).length).toBe(0);
    expect(log.every((l) => !l.box)).toBe(true);
  });

  it("drops the gap once the depth model stops seeing it", () => {
    const world = { slits: [OPENING] };
    const { scanner } = run(world, 60);
    expect(scanner.phase).toBe("tracking");
    // Now the view moves onto plain wall: feed depth results with no gap.
    for (let i = 0; i < 6; i++) {
      scanner.submitDepth({ frameId: scanner.frameIndex, width: 224, height: 168, gaps: [] });
      const f = renderWorld(pose(0), {});
      scanner.processFrame(f, (a, b) => crop(toRGBA(f), a, b));
    }
    expect(scanner.phase).toBe("searching");
  });

  it("stitches the hidden scene correctly while driven by depth", () => {
    const { scanner, log } = run({ slits: [{ offset: 0, width: 36 }] }, 200, { lag: 6, every: 5 });
    const st = scanner.getStatus();
    expect(st.framesUsed).toBeGreaterThan(150);
    expect(st.matchScore ?? 0).toBeGreaterThan(0.9);
    expect(log.some((l) => l.recorded)).toBe(true);
  });
});
