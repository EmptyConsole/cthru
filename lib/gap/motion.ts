import type { GrayFrame } from "./types";

/**
 * Finds where the image moves *differently* from the dominant motion.
 *
 * When you slide the device, the occluder (wall, fence, door) fills most of
 * the frame and moves as one rigid layer. Whatever shows through a real gap is
 * further away, so it shifts by a different amount (parallax), and new content
 * keeps appearing at the gap's edges. A rectangle stuck on the wall (a picture
 * frame, a book, a door panel) can look exactly like a gap in one still frame,
 * but it moves with the wall, so here it shows up as "no change".
 *
 * The frame is cut into narrow vertical bands. Each band is block-matched
 * against the previous frame; the median of the bands' best shifts, refined
 * to sub-pixel accuracy, is the dominant (occluder) motion. Then every pixel
 * column is checked against that motion at full resolution: columns that
 * don't fit it (sliding at a different speed, or showing new content) score high.
 */

export interface MotionResult {
  /** Dominant motion (sub-pixel): current pixel (x, y) matches previous pixel (x + dx, y + dy). */
  dx: number;
  dy: number;
  /** Per column, 0..1: how much this column disagrees with the dominant motion. */
  change: Float32Array;
  /**
   * Per column, 0..1: whether this column could show motion at all (enough
   * texture, not at the frame's sides). A blank wall or a dark, featureless
   * gap can't tell us anything either way.
   */
  observed: Float32Array;
  /** Strongest regional band disagreement: how much differential motion this frame shows. */
  activity: number;
  /** 0..1: share of textured bands that agree with the dominant motion. */
  reliability: number;
}

const BAND_W = 6;
/** Horizontal search radius around the predicted motion (analysis px). */
const RX = 8;
/** Vertical search radius around the predicted motion. */
const RY = 2;
const ROW_STEP = 3;

export class MotionEstimator {
  readonly width: number;
  readonly height: number;
  private prev: Float32Array | null = null;
  private pred = { dx: 0, dy: 0 };

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  reset() {
    this.prev = null;
    this.pred = { dx: 0, dy: 0 };
  }

  update(frame: GrayFrame): MotionResult | null {
    const { data: cur, width: w, height: h } = frame;
    const prev = this.prev;
    if (!this.prev || this.prev.length !== cur.length) this.prev = new Float32Array(cur.length);
    if (!prev || prev.length !== cur.length) {
      this.prev.set(cur);
      return null;
    }

    const nb = Math.floor(w / BAND_W);
    const px = Math.round(this.pred.dx);
    const py = Math.round(this.pred.dy);
    const nx = 2 * RX + 1;
    const ny = 2 * RY + 1;
    const y0 = RY + Math.abs(py) + 1;
    const y1 = h - RY - Math.abs(py) - 1;

    const best = new Float32Array(nb);
    const bestDx = new Int32Array(nb);
    const bestDy = new Int32Array(nb);
    const texture = new Float32Array(nb);
    const table = new Float32Array(nb * nx * ny);

    for (let b = 0; b < nb; b++) {
      const bx0 = b * BAND_W;
      const bx1 = bx0 + BAND_W;
      // Band texture in the current frame (how well its motion can be judged at all).
      let tex = 0;
      let tn = 0;
      for (let y = y0; y < y1; y += ROW_STEP) {
        const r = y * w;
        for (let x = bx0; x < bx1 && x < w - 1; x++) {
          tex += Math.abs(cur[r + x + 1] - cur[r + x]) + Math.abs(cur[r + w + x] - cur[r + x]);
          tn++;
        }
      }
      texture[b] = tex / Math.max(1, tn);

      let bv = Infinity;
      for (let j = 0; j < ny; j++) {
        const dy = py - RY + j;
        for (let i = 0; i < nx; i++) {
          const dx = px - RX + i;
          let sad = 0;
          let n = 0;
          for (let y = y0; y < y1; y += ROW_STEP) {
            const yp = y + dy;
            if (yp < 0 || yp >= h) continue;
            const rc = y * w;
            const rp = yp * w;
            for (let x = bx0; x < bx1; x++) {
              const xp = x + dx;
              if (xp < 0 || xp >= w) continue;
              sad += Math.abs(cur[rc + x] - prev[rp + xp]);
              n++;
            }
          }
          const mad = n > 0 ? sad / n : Infinity;
          table[(b * ny + j) * nx + i] = mad;
          if (mad < bv) {
            bv = mad;
            bestDx[b] = dx;
            bestDy[b] = dy;
          }
        }
      }
      best[b] = bv;
    }

    // Dominant motion: median of the bands' best shifts. Every textured band
    // gets (nearly) one vote: the occluder covers most bands, but the view
    // through a gap is often far more detailed and must not outvote it.
    const weights = Array.from(texture, (t) => (t > 1.5 ? Math.min(1, t / 4) : 0));
    const gdx = weightedMedian(bestDx, weights);
    const gdy = weightedMedian(bestDy, weights);
    let agree = 0;
    let total = 0;
    for (let b = 0; b < nb; b++) {
      total += weights[b];
      if (Math.abs(bestDx[b] - gdx) <= 1 && Math.abs(bestDy[b] - gdy) <= 1) agree += weights[b];
    }
    const reliability = total > 0 ? agree / total : 0;

    // Refine to sub-pixel accuracy: each band refines its own best shift on
    // its own cost curve, and the dominant motion is the median of those.
    // Integer shifts aren't enough (when the wall moves 0.7 px, a finely
    // textured poster on it can fit a different whole-pixel shift than the
    // smoother wall). And pooling the bands' costs instead would let a few
    // highly textured bands inside the gap drag the estimate towards the
    // scene's motion.
    const parabola = (a: number, c0: number, c: number) => {
      if (!Number.isFinite(a) || !Number.isFinite(c)) return 0;
      const den = a - 2 * c0 + c;
      return den > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    };
    const subDx = new Float32Array(nb);
    const subDy = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      const i = bestDx[b] - (px - RX);
      const j = bestDy[b] - (py - RY);
      const at = (ii: number, jj: number) =>
        ii < 0 || ii >= nx || jj < 0 || jj >= ny ? NaN : table[(b * ny + jj) * nx + ii];
      subDx[b] = bestDx[b] + parabola(at(i - 1, j), at(i, j), at(i + 1, j));
      subDy[b] = bestDy[b] + parabola(at(i, j - 1), at(i, j), at(i, j + 1));
    }
    const fdx = weightedMedian(subDx, weights);
    const fdy = weightedMedian(subDy, weights);
    const ix = Math.floor(fdx);
    const iy = Math.floor(fdy);
    const tx = fdx - ix;
    const ty = fdy - iy;

    // Per-column (full resolution) disagreement with the dominant motion: the
    // residual left after warping the previous frame by the exact occluder
    // motion, relative to how much that column's texture would produce from a
    // small misalignment. Anything attached to the occluder (a thin edge face,
    // a trim, a poster) fits almost perfectly, however close it sits to the
    // gap; the view through the gap — sliding at a different speed, or
    // revealing new content — doesn't. Bands were too coarse for this: a 6 px
    // slice beside a gap would inherit the gap's motion.
    const resid = new Float32Array(w);
    const tex = new Float32Array(w);
    const xlo = Math.max(1, Math.ceil(-ix) + 1, RX);
    const xhi = Math.min(w - 2, Math.floor(w - 2 - ix), w - RX - 1);
    for (let x = xlo; x <= xhi; x++) {
      let r = 0;
      let t = 0;
      let n = 0;
      const xp = x + ix;
      for (let y = y0; y < y1; y += 2) {
        const yp = y + iy;
        if (yp < 0 || yp + 1 >= h) continue;
        const rc = y * w;
        const r0 = yp * w;
        const r1 = r0 + w;
        const v =
          (prev[r0 + xp] * (1 - tx) + prev[r0 + xp + 1] * tx) * (1 - ty) +
          (prev[r1 + xp] * (1 - tx) + prev[r1 + xp + 1] * tx) * ty;
        r += Math.abs(cur[rc + x] - v);
        t += 0.5 * (Math.abs(cur[rc + x + 1] - cur[rc + x - 1]) + Math.abs(cur[rc + w + x] - cur[rc - w + x]));
        n++;
      }
      resid[x] = n ? r / n : 0;
      tex[x] = n ? t / n : 0;
    }
    const sortedResid = Array.from(resid.subarray(xlo, xhi + 1)).sort((a, b) => a - b);
    const noise = Math.max(1, sortedResid[sortedResid.length >> 1] ?? 1);

    const raw = new Float32Array(w);
    const observed = new Float32Array(w);
    for (let x = xlo; x <= xhi; x++) {
      if (tex[x] < 1.5) continue;
      observed[x] = Math.min(1, (tex[x] - 1.5) / 3);
      raw[x] = Math.min(1, Math.max(0, (resid[x] - 1.2 * noise) / (0.8 * tex[x] + noise)));
    }
    // A light [1 2 1] smoothing against pixel noise keeps ~2 px resolution.
    const change = new Float32Array(w);
    for (let x = 1; x < w - 1; x++) change[x] = 0.25 * (raw[x - 1] + 2 * raw[x] + raw[x + 1]);

    // Activity: the strongest *region* of differential motion (a 5-column
    // average, so one noisy column can't fake it).
    let activity = 0;
    for (let x = 2; x < w - 2; x++) {
      const v = (change[x - 2] + change[x - 1] + change[x] + change[x + 1] + change[x + 2]) / 5;
      if (v > activity) activity = v;
    }
    if (reliability < 0.3) {
      // We don't even know how the occluder moved (e.g. a sudden jump): no evidence.
      activity = 0;
      change.fill(0);
      observed.fill(0);
    }

    this.pred = reliability >= 0.3 ? { dx: clampAbs(fdx, 40), dy: clampAbs(fdy, 10) } : { dx: 0, dy: 0 };
    this.prev.set(cur);
    return { dx: fdx, dy: fdy, change, observed, activity, reliability };
  }
}

function clampAbs(v: number, m: number) {
  return Math.max(-m, Math.min(m, v));
}

function weightedMedian(values: ArrayLike<number>, weights: number[]): number {
  const idx = Array.from({ length: values.length }, (_, i) => i).filter((i) => weights[i] > 0);
  if (!idx.length) return 0;
  idx.sort((a, b) => values[a] - values[b]);
  const half = idx.reduce((s, i) => s + weights[i], 0) / 2;
  let acc = 0;
  for (const i of idx) {
    acc += weights[i];
    if (acc >= half) return values[i];
  }
  return values[idx[idx.length - 1]];
}
