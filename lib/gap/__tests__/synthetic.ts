import type { GrayFrame, RGBAImage } from "../types";

// --- Synthetic world -------------------------------------------------------

export function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function noise(x: number, y: number): number {
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
export const scene = (u: number, v: number) => 120 + 150 * noise(u / 9, v / 9) + 70 * noise(u / 3.5 + 50, v / 3.5) + 15 * Math.sin(u / 23);
/** A light, grainy fence board. */
export const fence = (x: number, y: number) => 190 + 25 * noise(x / 5 + 300, y / 60);

export const W = 320;
export const H = 240;
export const SLIT = 36;
export const K_NEAR = 1;
export const K_FAR = 0.3;

export interface Pose {
  occShift: number;
  bgShift: number;
  dy: number;
}

/**
 * The camera slides by T while turning to keep the gap roughly centred (as a
 * person does). Turning moves both layers equally; sliding moves the near
 * fence more than the far scene.
 */
export function pose(t: number): Pose {
  const T = 140 * Math.sin((t / 120) * Math.PI);
  const turn = -0.8 * K_NEAR * T;
  return { occShift: K_NEAR * T + turn, bgShift: K_FAR * T + turn, dy: 1.5 * Math.sin(t * 0.21) };
}

/** Fence with dark board seams: strong vertical lines that compete with the gap's edges. */
export const seamedFence = (x: number, y: number) => {
  const m = (((x - 7) % 41) + 41) % 41;
  return m < 1.5 ? 110 : fence(x, y);
};

export function render(p: Pose, t = 0, noiseAmp = 0, gain = 1, occluder = fence, slit = SLIT): GrayFrame {
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

export function toRGBA(f: GrayFrame): RGBAImage {
  const d = new Uint8ClampedArray(f.width * f.height * 4);
  for (let i = 0; i < f.data.length; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = f.data[i];
    d[i * 4 + 3] = 255;
  }
  return { data: d, width: f.width, height: f.height };
}

export function crop(img: RGBAImage, sx0: number, sx1: number): RGBAImage {
  const w = sx1 - sx0;
  const out = new Uint8ClampedArray(w * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    out.set(img.data.subarray((y * img.width + sx0) * 4, (y * img.width + sx1) * 4), y * w * 4);
  }
  return { data: out, width: w, height: img.height };
}

export function ncc(a: number[], b: number[]): number {
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


/** Texture of something attached to the wall (a poster, a book, a door panel): moves *with* the wall. */
export const painted = (x: number, y: number) => 70 + 130 * noise(x / 7 + 900, y / 7 + 40);

export interface WorldOptions {
  /** Real openings, by centre offset from the frame centre (in wall coordinates) and width. */
  slits?: { offset: number; width: number }[];
  /** Gap look-alikes on the wall, optionally not full height (fractions of frame height). */
  objects?: { offset: number; width: number; top?: number; bottom?: number; value?: number }[];
  noiseAmp?: number;
  t?: number;
}

/** A wall with openings and gap look-alikes, seen from pose `p`. */
export function renderWorld(p: Pose, o: WorldOptions): GrayFrame {
  const data = new Float32Array(W * H);
  const t = o.t ?? 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const xo = x + p.occShift;
      const rel = xo - W / 2;
      let v = fence(xo, y);
      for (const s of o.slits ?? []) if (rel >= s.offset - s.width / 2 && rel < s.offset + s.width / 2) v = scene(x + p.bgShift, y + p.dy);
      for (const ob of o.objects ?? []) {
        const inY = y >= (ob.top ?? 0) * H && y < (ob.bottom ?? 1) * H;
        if (inY && rel >= ob.offset - ob.width / 2 && rel < ob.offset + ob.width / 2) {
          // A plain surface (e.g. the lit edge face of a table top) or a textured one (a poster).
          v = ob.value !== undefined ? ob.value + 6 * noise(xo / 3 + 77, y / 25) : painted(xo, y);
        }
      }
      data[y * W + x] = Math.max(0, Math.min(255, v + (o.noiseAmp ?? 0) * (hash(x + t * 977, y) - 0.5)));
    }
  }
  return { data, width: W, height: H };
}

/**
 * What a depth model would report for `renderWorld(p, o)` (larger = nearer),
 * at its own resolution: the wall and anything on it (posters, edge faces)
 * are near; only the openings are far. Boundaries are slightly soft.
 */
export function depthWorld(p: Pose, o: WorldOptions, dw = 224, dh = 168, t = 0) {
  const data = new Float32Array(dw * dh);
  for (let yd = 0; yd < dh; yd++) {
    for (let xd = 0; xd < dw; xd++) {
      let far = 0;
      // Supersample across the pixel for soft, realistic edges.
      for (const sub of [-0.33, 0, 0.33]) {
        const x = ((xd + 0.5 + sub) * W) / dw - 0.5;
        const rel = x + p.occShift - W / 2;
        for (const s of o.slits ?? []) if (rel >= s.offset - s.width / 2 && rel < s.offset + s.width / 2) far += 1 / 3;
      }
      const near = 4 + 0.05 * noise(xd / 9 + t, yd / 9);
      const back = 0.6 + 0.15 * noise(xd / 5 + 30, yd / 5);
      data[yd * dw + xd] = near * (1 - far) + back * far;
    }
  }
  return { data, width: dw, height: dh };
}
