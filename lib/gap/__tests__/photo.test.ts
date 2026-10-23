import { describe, expect, it } from "vitest";
import { computeEdgeProfile, detectGap, gapQuality } from "../edges";
import { GapScanner } from "../scanner";
import type { RGBAImage } from "../types";
import { loadFixture, photoSequence } from "./fixtures";

/**
 * door-gap.jpg: two dark table tops side by side, with the floor visible in
 * the narrow gap between them. The lit edge faces of the two table tops form
 * extra, very straight vertical edges right next to the opening — the kind of
 * thing that used to make detection settle on a thin slice beside the gap.
 * In the 360 px analysis frame the opening spans about x = 172.5…199.5.
 */
const OPENING = { left: 172.5, right: 199.5 };

describe("real photo: gap between two tables", () => {
  const { gray } = loadFixture("door-gap.jpg");

  it("picks the opening, not a slice beside it, from a single still frame", () => {
    const p = computeEdgeProfile(gray);
    const det = detectGap(p)!;
    expect(Math.abs(det.gap.left - OPENING.left)).toBeLessThan(2);
    expect(Math.abs(det.gap.right - OPENING.right)).toBeLessThan(2);
    // The thin slices along the table edges must score clearly lower.
    const slice = Math.max(gapQuality(p, 200, 206), gapQuality(p, 169, 173));
    expect(det.quality - slice).toBeGreaterThan(0.1);
  });

  it("while sliding, locks onto the opening's true edges and never records a slice", () => {
    const frameAt = photoSequence(gray, OPENING.left, OPENING.right);
    const scanner = new GapScanner({ width: gray.width, height: gray.height, colorScale: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const I = scanner as any;
    let sliceFrames = 0;
    let goodFrames = 0;
    let maxEdgeErr = 0;
    for (let t = 0; t < 150; t++) {
      // Slide with a little turning, as a person would.
      const T = 60 * Math.sin((t / 75) * Math.PI);
      const occShift = 0.25 * T;
      const bgShift = -0.5 * T;
      const frame = frameAt(occShift, bgShift);
      const rgba: RGBAImage = { data: new Uint8ClampedArray(frame.data.length * 4), width: frame.width, height: frame.height };
      for (let i = 0; i < frame.data.length; i++) {
        rgba.data.fill(frame.data[i], i * 4, i * 4 + 3);
        rgba.data[i * 4 + 3] = 255;
      }
      const before = I.framesUsed;
      scanner.processFrame(frame, (a, b) => {
        const w = b - a;
        const out = new Uint8ClampedArray(w * frame.height * 4);
        for (let y = 0; y < frame.height; y++) out.set(rgba.data.subarray((y * frame.width + a) * 4, (y * frame.width + b) * 4), y * w * 4);
        return { data: out, width: w, height: frame.height };
      });
      if (I.framesUsed > before && scanner.gap) {
        const l = scanner.gap.left + occShift;
        const r = scanner.gap.right + occShift;
        if (r - l < 15) sliceFrames++;
        else goodFrames++;
        if (t > 40) maxEdgeErr = Math.max(maxEdgeErr, Math.abs(l - OPENING.left), Math.abs(r - OPENING.right));
      }
    }
    expect(sliceFrames).toBe(0);
    expect(goodFrames).toBeGreaterThan(80);
    expect(maxEdgeErr).toBeLessThan(2.5);
  });
});
