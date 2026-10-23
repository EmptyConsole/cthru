/**
 * Finding a vertical gap in a monocular depth map.
 *
 * A gap is, by definition, a narrow region that is much *farther away* than
 * the surfaces on both sides of it. Edges and appearance can only guess at
 * that; a depth model (Depth Anything V2) measures it directly. A poster or a
 * lit table edge looks like a gap in a photo, but it sits at the same depth
 * as the surface around it, so it doesn't show up here at all.
 *
 * Steps:
 * 1. Normalise the (relative, affine-invariant) depth map to 0..1 using
 *    robust percentiles: 1 = nearest surfaces, 0 = farthest.
 * 2. Row by row, find *valleys*: pixels clearly farther than the nearest
 *    surface within a window on their left AND on their right. Requiring both
 *    sides rules out a far area beside a single object or running off the
 *    edge of the frame.
 * 3. Within each valley, only pixels close to the far level count as inside
 *    (`tightness`). Depth maps are soft at boundaries, and surfaces such as a
 *    table's edge face really are at an intermediate depth, so this errs on
 *    the small side, as wanted.
 * 4. Group the rows' valleys into vertical candidates and score each on depth
 *    contrast, how much of the height it covers, straightness and width
 *    consistency.
 * 5. Each candidate's box uses the inner percentiles of its rows' boundaries,
 *    so it stays inside the opening even if the gap is slightly tilted.
 */

/** Relative inverse depth, as Depth Anything outputs it: larger = nearer. Row-major. */
export interface DepthMap {
  data: Float32Array;
  width: number;
  height: number;
}

export interface DepthGap {
  /**
   * Boundaries in depth-map pixel-centre coordinates: pixels with centres in
   * (left, right) are inside the gap. Rows in [top, bottom] (inclusive).
   */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 0..1 overall score. */
  quality: number;
  /** Median valley depth, as a fraction of the frame's depth range. */
  contrast: number;
  /** Share of the frame's height the gap spans. */
  coverage: number;
  /** 0..1: how well the rows' centres follow a straight line. */
  straightness: number;
  /** 0..1: how steady the width is from row to row. */
  consistency: number;
  /** 0..1: how abruptly depth changes at the sides (a gap's sides are depth discontinuities). */
  sharpness: number;
  /** Tilt: change of the centre column per row. */
  slope: number;
}

export interface DepthGapOptions {
  /** Widest gap considered, as a fraction of the frame width (also the side-window size). */
  maxWidthFrac?: number;
  /** Narrowest acceptable box, in depth-map pixels. */
  minWidthPx?: number;
  /** A pixel is in a valley if it is at least this much (0..1 of the depth range) farther than both sides. */
  minContrast?: number;
  /**
   * How close to the far level a pixel must be to count as inside (0..1 of the
   * valley's depth): 0.25 means within the farthest 25%. Smaller = tighter box.
   */
  tightness?: number;
  /** Row percentile used for the box sides (towards the inside), 0.5..1. */
  boxPercentile?: number;
}

export interface DepthGapResult {
  gaps: DepthGap[];
  /** Per column, share of rows whose valley core covers it (for debug views). */
  columnCoverage: Float32Array;
  /** Depth values mapped to 0 (far) and 1 (near) by the normalisation. */
  range: [number, number];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (x: number, lo: number, hi: number) => {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

function percentile(sorted: ArrayLike<number>, p: number): number {
  if (!sorted.length) return NaN;
  const i = clamp(p, 0, 1) * (sorted.length - 1);
  const a = Math.floor(i);
  const b = Math.min(sorted.length - 1, a + 1);
  return sorted[a] + (sorted[b] - sorted[a]) * (i - a);
}

/** out[x] = max(row[x-L..x]) (left = true) or max(row[x..x+L]) (left = false), clipped at the ends. */
function slidingMax(row: Float32Array, L: number, out: Float32Array, left: boolean) {
  const n = row.length;
  const dq = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < n; k++) {
    const x = left ? k : n - 1 - k;
    while (tail > head && row[dq[tail - 1]] <= row[x]) tail--;
    dq[tail++] = x;
    while (Math.abs(dq[head] - x) > L) head++;
    out[x] = row[dq[head]];
  }
}

interface RowCore {
  y: number;
  /** Boundary positions (pixel-centre coordinates). */
  l: number;
  r: number;
  /** Valley depth (normalised). */
  depth: number;
  /** How many px it takes, on each side, to climb from the far core to (nearly) the near surface. */
  rampL: number;
  rampR: number;
}

export function findDepthGaps(map: DepthMap, opts: DepthGapOptions = {}): DepthGapResult {
  const { data, width: w, height: h } = map;
  const maxWidthFrac = opts.maxWidthFrac ?? 0.4;
  const minWidthPx = opts.minWidthPx ?? 2;
  const minContrast = opts.minContrast ?? 0.12;
  const tightness = opts.tightness ?? 0.25;
  const boxP = opts.boxPercentile ?? 0.8;

  // 1. Robust normalisation. The far end uses a very low percentile because a
  // narrow gap may be only ~1% of the frame. The range has a floor relative to
  // the nearest depth, so a flat wall's tiny noise isn't stretched into
  // pretend valleys.
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += 2) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const lo = percentile(sample, 0.005);
  const hi = percentile(sample, 0.98);
  const span = Math.max(1e-3, hi - lo, 0.25 * Math.abs(hi));

  const maxW = Math.max(4, Math.round(maxWidthFrac * w));
  // Side windows: a gap up to maxW wide has a near surface within maxW of every pixel in it.
  const L = maxW;
  const row = new Float32Array(w);
  const lmax = new Float32Array(w);
  const rmax = new Float32Array(w);
  const T = new Float32Array(w);
  const cores: RowCore[][] = [];
  const columnCoverage = new Float32Array(w);

  // 2–3. Valleys per row, then their far cores.
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) row[x] = clamp((data[off + x] - lo) / span, -0.2, 1.2);
    slidingMax(row, L, lmax, true);
    slidingMax(row, L, rmax, false);
    for (let x = 0; x < w; x++) T[x] = Math.min(lmax[x], rmax[x]) - row[x];

    const rowCores: RowCore[] = [];
    let x = 0;
    while (x < w) {
      if (T[x] < minContrast) {
        x++;
        continue;
      }
      const s = x;
      while (x < w && T[x] >= minContrast) x++;
      const e = x - 1;
      // A valley touching the frame's side has no near surface beyond it.
      if (s === 0 || e === w - 1) continue;
      let vmax = 0;
      let im = s;
      for (let i = s; i <= e; i++) {
        if (T[i] > vmax) {
          vmax = T[i];
          im = i;
        }
      }
      const thr = (1 - tightness) * vmax;
      let cs = s;
      while (T[cs] < thr) cs++;
      let ce = e;
      while (T[ce] < thr) ce--;
      // Sub-pixel crossings of the threshold.
      const fl = (thr - T[cs - 1]) / Math.max(1e-6, T[cs] - T[cs - 1]);
      const fr = (T[ce] - thr) / Math.max(1e-6, T[ce] - T[ce + 1]);
      const l = cs - 1 + clamp(fl, 0, 1);
      const r = ce + clamp(fr, 0, 1);
      // The valley's true extent: walk out through the raw depth until it is
      // back within 25% of the surrounding surface. (The side windows alone
      // under-report very wide openings, whose middle is all they can see.)
      // A gap's sides are depth *discontinuities*, so this ramp is short; a
      // room corner or hallway seen from inside is far in the middle too, but
      // its sides slope gradually.
      const rim = Math.min(lmax[im], rmax[im]);
      const nearish = row[im] + 0.75 * (rim - row[im]);
      let ol = cs;
      while (ol > 0 && row[ol - 1] < nearish) ol--;
      let or = ce;
      while (or < w - 1 && row[or + 1] < nearish) or++;
      if (ol === 0 || or === w - 1) continue; // runs off the frame: not bounded on both sides
      if (or - ol + 1 > maxW) continue; // wider than any gap we look for
      rowCores.push({ y, l, r, depth: vmax, rampL: Math.max(0, l - ol), rampR: Math.max(0, or - r) });
      for (let i = cs; i <= ce; i++) columnCoverage[i] += 1 / h;
    }
    cores.push(rowCores);
  }

  // 4. Vertical candidates: runs of columns covered by enough rows' cores.
  const runs: [number, number][] = [];
  for (let x = 0; x < w; ) {
    if (columnCoverage[x] < 0.2) {
      x++;
      continue;
    }
    const s = x;
    while (x < w && columnCoverage[x] >= 0.2) x++;
    runs.push([s, x - 1]);
  }

  const gaps: DepthGap[] = [];
  for (const [ra, rb] of runs) {
    // Each row's core that overlaps this run the most.
    const present = new Uint8Array(h);
    const picked: (RowCore | null)[] = new Array(h).fill(null);
    for (let y = 0; y < h; y++) {
      let best: RowCore | null = null;
      let bestOv = 0;
      for (const c of cores[y]) {
        const ov = Math.min(c.r, rb + 0.5) - Math.max(c.l, ra - 0.5);
        if (ov > bestOv) {
          bestOv = ov;
          best = c;
        }
      }
      if (best) {
        picked[y] = best;
        present[y] = 1;
      }
    }
    // Vertical extent: the longest run of rows, bridging small holes.
    const hole = Math.max(2, Math.round(h * 0.03));
    let bestTop = -1;
    let bestBottom = -2;
    for (let y = 0; y < h; ) {
      if (!present[y]) {
        y++;
        continue;
      }
      const top = y;
      let last = y;
      let gapRun = 0;
      for (y = y + 1; y < h; y++) {
        if (present[y]) {
          last = y;
          gapRun = 0;
        } else if (++gapRun > hole) break;
      }
      if (last - top > bestBottom - bestTop) {
        bestTop = top;
        bestBottom = last;
      }
    }
    if (bestTop < 0) continue;

    const ys: number[] = [];
    const ls: number[] = [];
    const rs: number[] = [];
    const depths: number[] = [];
    const ramps: number[] = [];
    for (let y = bestTop; y <= bestBottom; y++) {
      const c = picked[y];
      if (!c) continue;
      ys.push(y);
      ls.push(c.l);
      rs.push(c.r);
      depths.push(c.depth);
      ramps.push(Math.max(c.rampL, c.rampR));
    }
    const n = ys.length;
    if (n < Math.max(5, h * 0.1)) continue;

    // Straightness: residual of the rows' centres around a fitted line (tilt allowed).
    let sy = 0;
    let sc = 0;
    let syy = 0;
    let syc = 0;
    for (let i = 0; i < n; i++) {
      const c = (ls[i] + rs[i]) / 2;
      sy += ys[i];
      sc += c;
      syy += ys[i] * ys[i];
      syc += ys[i] * c;
    }
    const den = n * syy - sy * sy;
    const slope = den > 0 ? (n * syc - sy * sc) / den : 0;
    const icpt = (sc - slope * sy) / n;
    let resid = 0;
    for (let i = 0; i < n; i++) resid += ((ls[i] + rs[i]) / 2 - (icpt + slope * ys[i])) ** 2;
    const residStd = Math.sqrt(resid / n);

    const widths = ls.map((l, i) => rs[i] - l).sort((a, b) => a - b);
    const medW = percentile(widths, 0.5);
    const mad = percentile(
      widths.map((v) => Math.abs(v - medW)).sort((a, b) => a - b),
      0.5,
    );

    // 5. Err-small box: inner percentiles of the rows' sides.
    const lsSorted = [...ls].sort((a, b) => a - b);
    const rsSorted = [...rs].sort((a, b) => a - b);
    const left = percentile(lsSorted, boxP);
    const right = percentile(rsSorted, 1 - boxP);
    if (right - left < minWidthPx) continue;

    const contrast = percentile([...depths].sort((a, b) => a - b), 0.5);
    const coverage = n / h;
    const straightness = 1 - clamp(residStd / Math.max(1, 0.25 * medW), 0, 1);
    const consistency = 1 - clamp(mad / Math.max(1, 0.3 * medW), 0, 1);
    // Sharp sides: the depth should climb to the near surface within a few px
    // (model blur, or an edge face), not over a long slope.
    const ramp = percentile([...ramps].sort((a, b) => a - b), 0.5);
    const sharpness = 1 - clamp((ramp - 3) / Math.max(4, 0.6 * medW), 0, 1);
    const quality =
      // Real gaps reveal things much farther away (the sample photo scores
      // 0.96); weak valleys in a slanted or ambiguous depth map shouldn't pass.
      smoothstep(contrast, 0.2, 0.6) *
      smoothstep(coverage, 0.3, 0.8) *
      (0.4 + 0.6 * straightness) *
      (0.5 + 0.5 * consistency) *
      sharpness;

    gaps.push({
      left,
      right,
      top: bestTop + 0.5,
      bottom: bestBottom - 0.5,
      quality,
      contrast,
      coverage,
      straightness,
      consistency,
      sharpness,
      slope,
    });
  }
  // Drop candidates with essentially no claim to being a gap.
  const kept = gaps.filter((g) => g.quality > 0.05);
  kept.sort((a, b) => b.quality - a.quality);
  return { gaps: kept, columnCoverage, range: [lo, lo + span] };
}

/**
 * Sharpen a depth-found gap with image edges, inward only.
 *
 * Depth maps are soft at boundaries, and a surface beside the opening (a
 * table's edge face, a frame's bevel) can read as intermediate depth, so the
 * depth boundary can sit a couple of pixels outside the true edge. If a strong
 * vertical image edge lies just *inside* a side, move that side onto it. Sides
 * never move outward (beyond `outward` px), so this can only make the box
 * tighter — and depth, not edges, still decides where the gap is.
 *
 * `coherence` is the edge profile's per-column edge strength (index x = the
 * boundary between pixel x and x+1), in the same pixel coordinates as `g`.
 */
export function refineGapEdges<G extends { left: number; right: number }>(
  g: G,
  coherence: Float32Array,
  maxInward: number,
  outward = 0.5,
  minStrength = 0.35,
): G {
  const n = coherence.length;
  const width = g.right - g.left;
  const reach = Math.min(maxInward, width * 0.25);
  // Strongest local edge maximum whose boundary position lies in [from, to].
  const strongest = (from: number, to: number) => {
    let best = -1;
    let bv = minStrength;
    for (let x = Math.ceil(from - 0.5); x <= Math.floor(to - 0.5); x++) {
      if (x < 1 || x >= n - 1) continue;
      const v = coherence[x];
      if (v > bv && v >= coherence[x - 1] && v >= coherence[x + 1]) {
        bv = v;
        best = x;
      }
    }
    return best < 0 ? null : best + 0.5;
  };
  const left = strongest(g.left - outward, g.left + reach) ?? g.left;
  const right = strongest(g.right - reach, g.right + outward) ?? g.right;
  if (right - left < Math.max(2, width * 0.5)) return g;
  return { ...g, left, right };
}
