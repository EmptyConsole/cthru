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
 * against the previous frame; the weighted median of the bands' best shifts is
 * the dominant (occluder) motion. A band then scores high if it fits the
 * dominant motion badly but fits some other shift well (it is sliding at a
 * different speed), or if it fits no shift well (new content is appearing).
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

    // Noise floor: the typical residual of a band at its own best shift.
    const sortedBest = Array.from(best).filter(Number.isFinite).sort((a, b) => a - b);
    const noise = Math.max(1, sortedBest[sortedBest.length >> 1] ?? 1);

    // Refine the dominant motion to sub-pixel accuracy from the pooled costs of
    // the agreeing bands. Integer shifts aren't enough: when the wall moves
    // 0.7 px, a finely textured poster on it can fit a different whole-pixel
    // shift than the smoother wall around it, which would look like parallax.
    const gi = gdx - (px - RX);
    const gj = gdy - (py - RY);
    const pooled = (i: number, j: number) => {
      if (i < 0 || i >= nx || j < 0 || j >= ny) return NaN;
      let sum = 0;
      for (let b = 0; b < nb; b++) {
        if (!weights[b] || Math.abs(bestDx[b] - gdx) > 1 || Math.abs(bestDy[b] - gdy) > 1) continue;
        sum += weights[b] * table[(b * ny + j) * nx + i];
      }
      return sum;
    };
    const parabola = (a: number, c0: number, c: number) => {
      if (!Number.isFinite(a) || !Number.isFinite(c)) return 0;
      const den = a - 2 * c0 + c;
      return den > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    };
    const c00 = pooled(gi, gj);
    const fdx = gdx + parabola(pooled(gi - 1, gj), c00, pooled(gi + 1, gj));
    const fdy = gdy + parabola(pooled(gi, gj - 1), c00, pooled(gi, gj + 1));
    const ix = Math.floor(fdx);
    const iy = Math.floor(fdy);
    const tx = fdx - ix;
    const ty = fdy - iy;

    const bandChange = new Float32Array(nb);
    const bandObserved = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      if (texture[b] < 1.5) continue;
      // At the frame's sides content enters and leaves view: that isn't parallax.
      if (b * BAND_W + Math.min(0, gdx) - RX < 0 || (b + 1) * BAND_W + Math.max(0, gdx) + RX > w) continue;
      bandObserved[b] = Math.min(1, (texture[b] - 1.5) / 3);
      // Residual of this band at the exact (sub-pixel) dominant motion.
      let sad = 0;
      let n = 0;
      for (let y = y0; y < y1; y += ROW_STEP) {
        const yp = y + iy;
        if (yp < 0 || yp + 1 >= h) continue;
        const rc = y * w;
        const r0 = yp * w;
        const r1 = r0 + w;
        for (let x = b * BAND_W; x < (b + 1) * BAND_W; x++) {
          const xp = x + ix;
          if (xp < 0 || xp + 1 >= w) continue;
          const v =
            (prev[r0 + xp] * (1 - tx) + prev[r0 + xp + 1] * tx) * (1 - ty) +
            (prev[r1 + xp] * (1 - tx) + prev[r1 + xp + 1] * tx) * ty;
          sad += Math.abs(cur[rc + x] - v);
          n++;
        }
      }
      const eg = n ? sad / n : table[(b * ny + gj) * nx + gi];
      const emin = best[b];
      // Moving at a different speed: fits its own shift much better than the dominant one.
      const differs = Math.max(0, eg - emin - 0.5 * noise) / (eg + noise);
      // New content appearing: fits no shift well, relative to how textured it is.
      const unmatched = Math.min(1, Math.max(0, (emin - 1.5 * noise) / (texture[b] + noise)));
      bandChange[b] = Math.max(differs, unmatched);
    }
    // Activity: the strongest *region* of differential motion. Gaps are narrow
    // (a few bands), so this is a smoothed peak rather than a percentile; the
    // smoothing needs ~2 neighbouring bands to agree, so one noisy band can't fake it.
    let activity = 0;
    for (let b = 0; b < nb; b++) {
      const v = 0.25 * (bandChange[Math.max(0, b - 1)] + 2 * bandChange[b] + bandChange[Math.min(nb - 1, b + 1)]);
      if (v > activity) activity = v;
    }

    // Spread band values over columns, interpolating between band centres.
    const change = new Float32Array(w);
    const observed = new Float32Array(w);
    if (reliability >= 0.3) {
      for (let x = 0; x < w; x++) {
        const t = (x + 0.5) / BAND_W - 0.5;
        const b0 = Math.max(0, Math.min(nb - 1, Math.floor(t)));
        const b1 = Math.min(nb - 1, b0 + 1);
        const f = Math.max(0, Math.min(1, t - b0));
        change[x] = bandChange[b0] * (1 - f) + bandChange[b1] * f;
        observed[x] = Math.min(bandObserved[b0], bandObserved[b1]);
      }
    } else {
      // We don't even know how the occluder moved (e.g. a sudden jump): no evidence.
      activity = 0;
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
