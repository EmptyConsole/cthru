import type { Accumulator } from "./mosaic";
import type { GrayFrame } from "./types";

export interface RegistrationResult {
  ok: boolean;
  /** Local mosaic x of frame column 0, i.e. mosaicX = frameX + dx. */
  dx: number;
  dy: number;
  /** Normalised cross-correlation at the peak, -1..1. */
  score: number;
  /** Fraction of strip samples that overlapped painted mosaic pixels. */
  overlap: number;
}

export interface RegistrationParams {
  /** Strip columns [x0, x1) in the frame. */
  x0: number;
  x1: number;
  /** Strip rows [y0, y1) in the frame (default: all). */
  y0?: number;
  y1?: number;
  predX: number;
  predY: number;
  /** Integer search radius around the prediction. */
  rx: number;
  ry: number;
  /** Override the horizontal search range (absolute dx values), for global re-acquisition. */
  rangeX?: [number, number];
  rowStep?: number;
  /** Evaluate every n-th horizontal offset (coarse search; refine afterwards). */
  stepX?: number;
  minScore?: number;
  minOverlap?: number;
}

const MIN_WEIGHT = 0.3;

/**
 * Find where the gap strip of the current frame sits in the mosaic built so
 * far, by maximising NCC over integer offsets and refining with a parabola.
 * Registering against the mosaic (rather than the previous frame) keeps drift
 * from accumulating and naturally handles sweeping back and forth.
 */
export function registerStrip(frame: GrayFrame, mosaic: Accumulator, p: RegistrationParams): RegistrationResult {
  const fail: RegistrationResult = { ok: false, dx: p.predX, dy: p.predY, score: -1, overlap: 0 };
  const value = mosaic.value;
  if (!value || mosaic.isEmpty) return fail;

  const { data, width: fw, height: fh } = frame;
  const rowStep = p.rowStep ?? 2;
  const stepX = p.stepX ?? 1;
  const ry = p.ry;

  // Gather strip samples once.
  const xs: number[] = [];
  const ys: number[] = [];
  const vs: number[] = [];
  let mean = 0;
  const ya = Math.max(ry + 1, p.y0 ?? 0);
  const yb = Math.min(fh - ry - 1, p.y1 ?? fh);
  for (let y = ya; y < yb; y += rowStep) {
    for (let x = p.x0; x < p.x1; x++) {
      xs.push(x);
      ys.push(y);
      const v = data[y * fw + x];
      vs.push(v);
      mean += v;
    }
  }
  const n = vs.length;
  if (n < 30) return fail;
  mean /= n;
  let varA = 0;
  for (let i = 0; i < n; i++) varA += (vs[i] - mean) ** 2;
  // Nothing to lock onto (e.g. a uniform wall behind the gap).
  if (Math.sqrt(varA / n) < 2) return fail;

  const W = mosaic.width;
  const H = mosaic.height;
  const ox = mosaic.originX;
  const oy = mosaic.originY;
  const wgt = mosaic.weight;

  const bx = Math.round(p.predX);
  const by = Math.round(p.predY);
  const dxLo = p.rangeX ? Math.floor(p.rangeX[0]) : bx - p.rx;
  const dxHi = p.rangeX ? Math.ceil(p.rangeX[1]) : bx + p.rx;
  const dyLo = by - ry;
  const dyHi = by + ry;
  const nx = dxHi - dxLo + 1;
  const ny = dyHi - dyLo + 1;
  const scores = new Float32Array(nx * ny).fill(-2);
  const minOverlap = p.minOverlap ?? 0.3;

  let best = -2;
  let bi = -1;
  let bj = -1;
  let bestOverlap = 0;
  for (let j = 0; j < ny; j++) {
    const dy = dyLo + j;
    for (let i = 0; i < nx; i += stepX) {
      const dx = dxLo + i;
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      let cnt = 0;
      for (let k = 0; k < n; k++) {
        const X = xs[k] + dx + ox;
        const Y = ys[k] + dy + oy;
        if (X < 0 || X >= W || Y < 0 || Y >= H) continue;
        const idx = Y * W + X;
        if (wgt[idx] < MIN_WEIGHT) continue;
        const a = vs[k];
        const b = value[idx];
        sa += a;
        sb += b;
        saa += a * a;
        sbb += b * b;
        sab += a * b;
        cnt++;
      }
      if (cnt < n * minOverlap) continue;
      const cov = sab - (sa * sb) / cnt;
      const va = saa - (sa * sa) / cnt;
      const vb = sbb - (sb * sb) / cnt;
      if (va <= 1e-6 || vb <= 1e-6) continue;
      const ncc = cov / Math.sqrt(va * vb);
      scores[j * nx + i] = ncc;
      if (ncc > best) {
        best = ncc;
        bi = i;
        bj = j;
        bestOverlap = cnt / n;
      }
    }
  }
  if (bi < 0) return fail;

  const sub = (a: number, b: number, c: number) => {
    if (a < -1.5 || c < -1.5) return 0;
    const den = a - 2 * b + c;
    return den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  };
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? -2 : scores[j * nx + i]);
  const subX = sub(at(bi - 1, bj), best, at(bi + 1, bj));
  const subY = sub(at(bi, bj - 1), best, at(bi, bj + 1));

  // A peak on the edge of the search window means the true peak may lie outside it.
  const onEdge = (nx > 1 && (bi < stepX || bi > nx - 1 - stepX)) || (ny > 1 && (bj === 0 || bj === ny - 1));

  return {
    ok: best >= (p.minScore ?? 0.6) && !onEdge,
    dx: dxLo + bi + subX,
    dy: dyLo + bj + subY,
    score: best,
    overlap: bestOverlap,
  };
}
