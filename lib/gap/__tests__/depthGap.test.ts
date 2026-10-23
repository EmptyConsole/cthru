import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDepthGaps, refineGapEdges, type DepthMap } from "../depthGap";
import { computeEdgeProfile } from "../edges";
import { loadFixture } from "./fixtures";
import { hash } from "./synthetic";

const W = 336;
const H = 252;
const NEAR = 4;
const FAR = 0.6;

/** Build a depth map (larger = nearer) from a per-pixel function, with optional noise. */
function depthMap(f: (x: number, y: number) => number, noise = 0): DepthMap {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = f(x, y) + noise * (hash(x, y) - 0.5);
  return { data, width: W, height: H };
}

/** Soft step from near to far over `soft` px around `edge` (like a real model's blurry boundary). */
const ramp = (x: number, edge: number, soft: number) => Math.min(1, Math.max(0, (x - edge) / soft + 0.5));

/** A gap with true boundaries [l, r] (pixel-centre coords) and soft edges. */
const gapAt = (l: number, r: number, soft = 2) => (x: number) => {
  const inside = Math.min(ramp(x, l, soft), 1 - ramp(x, r, soft));
  return NEAR - (NEAR - FAR) * inside;
};

describe("findDepthGaps", () => {
  it("finds a clean gap with a box inside its true edges", () => {
    const res = findDepthGaps(depthMap((x) => gapAt(150, 180)(x), 0.05));
    expect(res.gaps.length).toBe(1);
    const g = res.gaps[0];
    expect(g.quality).toBeGreaterThan(0.8);
    expect(g.left).toBeGreaterThanOrEqual(150);
    expect(g.right).toBeLessThanOrEqual(180);
    expect(g.right - g.left).toBeGreaterThan(25);
    expect(g.coverage).toBeGreaterThan(0.95);
  });

  it("ignores a far area that runs off the side of the frame", () => {
    const res = findDepthGaps(depthMap((x) => (x > 290 ? FAR : NEAR), 0.05));
    expect(res.gaps.length).toBe(0);
  });

  it("ignores a plain depth step (far on one side only)", () => {
    // Near on the left half, far on the right half: no near surface on the far side.
    const res = findDepthGaps(depthMap((x) => (x < 168 ? NEAR : FAR), 0.05));
    expect(res.gaps.length).toBe(0);
  });

  it("ignores a gentle depth gradient (a wall seen at an angle)", () => {
    const res = findDepthGaps(depthMap((x) => NEAR - 2 * Math.sin((x / W) * Math.PI), 0.05));
    expect(res.gaps.length).toBe(0);
  });

  it("separates two gaps and ranks the clearer one first", () => {
    const res = findDepthGaps(
      depthMap((x) => (x < 168 ? gapAt(60, 90)(x) : NEAR - (NEAR - FAR) * 0.45 * (1 - (gapAt(220, 250)(x) - FAR) / (NEAR - FAR)))),
    );
    expect(res.gaps.length).toBe(2);
    expect(res.gaps[0].left).toBeGreaterThan(58);
    expect(res.gaps[0].right).toBeLessThan(92);
    expect(res.gaps[1].left).toBeGreaterThan(218);
  });

  it("handles a slightly tilted gap, keeping the box inside it on every row", () => {
    const tilt = 0.06; // px of drift per row: ~15 px over the frame
    const res = findDepthGaps(depthMap((x, y) => gapAt(150 + tilt * y, 185 + tilt * y)(x), 0.05));
    const g = res.gaps[0];
    expect(g).toBeDefined();
    expect(g.slope).toBeCloseTo(tilt, 1);
    // Box inside the opening for most rows (it errs small).
    let inside = 0;
    for (let y = 0; y < H; y++) if (g.left >= 150 + tilt * y - 0.5 && g.right <= 185 + tilt * y + 0.5) inside++;
    expect(inside / H).toBeGreaterThan(0.6);
  });

  it("reports the vertical extent of a gap that doesn't span the whole frame", () => {
    const res = findDepthGaps(depthMap((x, y) => (y > 60 && y < 220 ? gapAt(150, 180)(x) : NEAR), 0.05));
    const g = res.gaps[0];
    expect(g.top).toBeGreaterThan(55);
    expect(g.top).toBeLessThan(70);
    expect(g.bottom).toBeGreaterThan(210);
    expect(g.bottom).toBeLessThan(225);
  });

  it("keeps a gap whole when something at middle depth shows through it", () => {
    // A box behind the gap, half-way between the far floor and the near occluder, in the middle rows.
    const res = findDepthGaps(
      depthMap((x, y) => {
        const v = gapAt(150, 182)(x);
        return y > 100 && y < 150 && x > 160 && x < 172 ? Math.max(v, (NEAR + FAR) / 2) : v;
      }, 0.05),
    );
    expect(res.gaps.length).toBe(1);
    expect(res.gaps[0].left).toBeGreaterThanOrEqual(150);
    expect(res.gaps[0].right).toBeLessThanOrEqual(182);
  });

  it("finds a narrow gap", () => {
    const res = findDepthGaps(depthMap((x) => gapAt(160, 167, 1.5)(x), 0.05));
    expect(res.gaps.length).toBe(1);
    expect(res.gaps[0].right - res.gaps[0].left).toBeGreaterThanOrEqual(2);
  });

  it("ignores an opening wider than the maximum gap width", () => {
    const res = findDepthGaps(depthMap((x) => gapAt(60, 260)(x), 0.05));
    expect(res.gaps.length).toBe(0);
  });

  it("survives heavy noise", () => {
    const res = findDepthGaps(depthMap((x) => gapAt(150, 180)(x), 0.6));
    expect(res.gaps.length).toBeGreaterThanOrEqual(1);
    expect(res.gaps[0].left).toBeGreaterThan(146);
    expect(res.gaps[0].right).toBeLessThan(184);
  });
});

describe("real depth map: gap between two tables (Depth Anything V2 Small)", () => {
  const dir = join(__dirname, "fixtures");
  const meta = JSON.parse(readFileSync(join(dir, "door-gap.depth.json"), "utf8"));
  const buf = readFileSync(join(dir, "door-gap.depth.f32"));
  const depth: DepthMap = { data: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), width: meta.width, height: meta.height };

  it("finds exactly one gap, and after edge refinement its box sits within the opening", () => {
    const res = findDepthGaps(depth);
    expect(res.gaps.length).toBe(1);
    const g = res.gaps[0];
    expect(g.quality).toBeGreaterThan(0.75);
    expect(g.coverage).toBeGreaterThan(0.95);

    // Into the 360 px analysis frame, then sharpen with image edges (inward only).
    const { gray } = loadFixture("door-gap.jpg");
    const s = gray.width / depth.width;
    const box = { left: (g.left + 0.5) * s - 0.5, right: (g.right + 0.5) * s - 0.5 };
    const refined = refineGapEdges(box, computeEdgeProfile(gray).coherence, 4);
    // The opening (floor visible between the tables) spans ~172.5…200.5 in analysis pixels.
    expect(refined.left).toBeGreaterThanOrEqual(172.5);
    expect(refined.right).toBeLessThanOrEqual(200.5);
    // …and still covers most of it.
    expect(refined.right - refined.left).toBeGreaterThan(22);
    // Refinement only ever tightens.
    expect(refined.left).toBeGreaterThanOrEqual(box.left);
    expect(refined.right).toBeLessThanOrEqual(box.right);
  });
});
