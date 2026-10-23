import { readFileSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
import type { GrayFrame, RGBAImage } from "../types";

/** Load a JPEG fixture, box-downscaled so its longest side is `maxSide` (like the app's analysis frame). */
export function loadFixture(name: string, maxSide = 360): { gray: GrayFrame; rgba: RGBAImage } {
  const img = jpeg.decode(readFileSync(join(__dirname, "fixtures", name)), { useTArray: true });
  const k = maxSide / Math.max(img.width, img.height);
  const w = Math.round(img.width * k);
  const h = Math.round(img.height * k);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / k), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / k));
      const sy0 = Math.floor(y / k), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / k));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
        const i = (yy * img.width + xx) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
      const o = (y * w + x) * 4;
      rgba[o] = r / n; rgba[o + 1] = g / n; rgba[o + 2] = b / n; rgba[o + 3] = 255;
      gray[y * w + x] = (0.299 * r + 0.587 * g + 0.114 * b) / n;
    }
  }
  return { gray: { data: gray, width: w, height: h }, rgba: { data: rgba, width: w, height: h } };
}

/**
 * A sliding sequence built from a still photo of a gap: the photo itself (with
 * the opening cut out) is the occluder, and the strip seen through the opening
 * — mirrored out sideways into a wide backdrop — is the hidden scene. The two
 * move at different speeds, like the real thing.
 */
export function photoSequence(photo: GrayFrame, gapLeft: number, gapRight: number) {
  const { data, width: w, height: h } = photo;
  const sample = (x: number, y: number) => {
    const xi = Math.max(0, Math.min(w - 2, Math.floor(x)));
    const f = Math.max(0, Math.min(1, x - xi));
    const r = Math.max(0, Math.min(h - 1, Math.round(y))) * w;
    return data[r + xi] * (1 - f) + data[r + xi + 1] * f;
  };
  const strip0 = Math.ceil(gapLeft) + 1;
  const strip1 = Math.floor(gapRight) - 1;
  const sw = strip1 - strip0;
  // Mirror-tile the strip so the backdrop has no seams.
  const scene = (u: number, y: number) => {
    const period = 2 * sw;
    const m = (((u - strip0) % period) + period) % period;
    return sample(strip0 + (m < sw ? m : period - m), y);
  };
  return (occShift: number, bgShift: number): GrayFrame => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const xo = x + occShift;
        out[y * w + x] = xo > gapLeft && xo < gapRight ? scene(x + bgShift, y) : sample(xo, y);
      }
    }
    return { data: out, width: w, height: h };
  };
}
