import type { Gap, GrayFrame } from "./types";

/**
 * Per-column summary of a frame used to find the two sides of a vertical gap.
 *
 * The edge measure is deliberately sign-agnostic: what shows through a gap
 * changes from row to row (sky, then a dark wall, then a bright sign…), so the
 * same boundary can be bright→dark in one row and dark→bright in the next.
 */
export interface EdgeProfile {
  width: number;
  /**
   * 0..1. For each row we keep only gradient-magnitude local maxima (the
   * row's actual edges), clamp them at EDGE_FULL, and average down the
   * column. A full-height, high-contrast boundary scores ~1; faint grain or
   * scattered texture scores low. Index x is the boundary between pixel x and x+1.
   */
  coherence: Float32Array;
  /**
   * 0..1: share of the frame's height (in EXTENT_BANDS row bands) in which
   * column x holds an edge. A gap's sides usually run the full height of the
   * view; most rectangular objects (books, frames, screens) don't.
   */
  extent: Float32Array;
  /** Mean |I(x+1) - I(x)| over the analysed rows (for subpixel localisation). */
  meanAbsGrad: Float32Array;
  /** Mean intensity of each column over the analysed rows. */
  colMean: Float32Array;
  /** Median coherence over all columns: how edgy a typical column is in this frame. */
  baseline: number;
  /** Number of horizontal row bands in `bandPrefix`. */
  bands: number;
  /**
   * Per-band running sums of column means: band k, columns [x0, x1) sum to
   * bandPrefix[k*(w+1)+x1] - bandPrefix[k*(w+1)+x0]. Lets us compare how the
   * inside of a gap and its sides vary from top to bottom, cheaply.
   */
  bandPrefix: Float32Array;
  /**
   * Running sum over columns of mean |I(x, y+1) - I(x, y)|: the amount of
   * horizontal structure ("detail") in each column. The view through a gap
   * usually has a different amount of detail from the occluder around it.
   */
  detailPrefix: Float32Array;
}

/**
 * Accumulated evidence of parallax per column (see `MotionEstimator`):
 * `evidence` 0..1 is how strongly a column moves differently from the
 * occluder; `confidence` 0..1 is how much we have actually observed it.
 */
export interface MotionEvidence {
  evidence: Float32Array;
  confidence: Float32Array;
}

const BANDS = 12;
const EXTENT_BANDS = 6;
/** A row band counts as "has an edge here" above this band-level coherence. */
const EXTENT_MIN = 0.35;

/** Contrast (after normalisation, in 0..255 levels) that counts as a fully strong edge. */
const EDGE_FULL = 40;
/** Ignore gradients below this. */
const EDGE_MIN = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Gain that stretches the frame's 2nd..98th percentile range, so dim scenes still produce edges. */
function contrastGain(frame: GrayFrame): number {
  const hist = new Uint32Array(256);
  const { data, width: w, height: h } = frame;
  let n = 0;
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 2) {
      hist[clamp(data[y * w + x] | 0, 0, 255)]++;
      n++;
    }
  }
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc < n * 0.02) lo = i;
    if (acc < n * 0.98) hi = i;
  }
  return clamp(180 / Math.max(1, hi - lo), 1, 4);
}

export function computeEdgeProfile(frame: GrayFrame, rowStartFrac = 0.08, rowEndFrac = 0.92): EdgeProfile {
  const { data, width: w, height: h } = frame;
  const y0 = Math.floor(h * rowStartFrac);
  const y1 = Math.max(y0 + 1, Math.ceil(h * rowEndFrac));
  const rows = y1 - y0;
  const gain = contrastGain(frame);

  const strength = new Float32Array(w);
  const bandStrength = new Float32Array(EXTENT_BANDS * w);
  const meanAbsGrad = new Float32Array(w);
  const colMean = new Float32Array(w);
  const detail = new Float32Array(w);
  const a = new Float32Array(w);
  const lm = new Float32Array(w);

  for (let y = y0; y < y1; y++) {
    const r = y * w;
    const eb = Math.min(EXTENT_BANDS - 1, Math.floor(((y - y0) * EXTENT_BANDS) / rows)) * w;
    for (let x = 0; x < w - 1; x++) a[x] = Math.abs(data[r + x + 1] - data[r + x]) * gain;
    a[w - 1] = 0;
    const below = y + 1 < h ? r + w : r;
    for (let x = 0; x < w; x++) {
      colMean[x] += data[r + x];
      meanAbsGrad[x] += a[x];
      detail[x] += Math.abs(data[below + x] - data[r + x]) * gain;
      lm[x] = 0;
    }
    // Keep only this row's real edges: local maxima over ±2 columns.
    for (let x = 2; x < w - 2; x++) {
      const v = a[x];
      if (v > EDGE_MIN && v >= a[x - 1] && v >= a[x + 1] && v >= a[x - 2] && v >= a[x + 2]) {
        lm[x] = Math.min(v, EDGE_FULL);
      }
    }
    // Allow one column of slack so slightly tilted or wobbly edges still add up.
    for (let x = 1; x < w - 1; x++) {
      const v = Math.max(lm[x - 1], lm[x], lm[x + 1]);
      strength[x] += v;
      bandStrength[eb + x] += v;
    }
  }

  const coherence = new Float32Array(w);
  const detailPrefix = new Float32Array(w + 1);
  for (let x = 0; x < w; x++) {
    coherence[x] = strength[x] / (rows * EDGE_FULL);
    colMean[x] /= rows;
    meanAbsGrad[x] /= rows;
    detailPrefix[x + 1] = detailPrefix[x] + detail[x] / rows;
  }

  const bandRows = rows / EXTENT_BANDS;
  const rawExtent = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let k = 0; k < EXTENT_BANDS; k++) if (bandStrength[k * w + x] / (bandRows * EDGE_FULL) >= EXTENT_MIN) n++;
    rawExtent[x] = n / EXTENT_BANDS;
  }
  const extent = new Float32Array(w);
  for (let x = 0; x < w; x++) extent[x] = Math.max(rawExtent[Math.max(0, x - 1)], rawExtent[x], rawExtent[Math.min(w - 1, x + 1)]);

  const bandPrefix = new Float32Array(BANDS * (w + 1));
  for (let k = 0; k < BANDS; k++) {
    const by0 = y0 + Math.floor((rows * k) / BANDS);
    const by1 = y0 + Math.floor((rows * (k + 1)) / BANDS);
    const base = k * (w + 1);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = by0; y < by1; y++) sum += data[y * w + x];
      bandPrefix[base + x + 1] = bandPrefix[base + x] + sum / Math.max(1, by1 - by0);
    }
  }

  const sorted = Float32Array.from(coherence).sort();
  return {
    width: w,
    coherence,
    extent,
    meanAbsGrad,
    colMean,
    baseline: sorted[sorted.length >> 1],
    bands: BANDS,
    bandPrefix,
    detailPrefix,
  };
}

/** Subpixel boundary position near column `x`, from the mean gradient-magnitude profile. */
function refineEdge(p: EdgeProfile, x: number): number {
  const { meanAbsGrad: m, width: w } = p;
  let best = x;
  for (let i = Math.max(1, x - 1); i <= Math.min(w - 3, x + 1); i++) if (m[i] > m[best]) best = i;
  best = clamp(best, 1, w - 3);
  const a = m[best - 1];
  const b = m[best];
  const c = m[best + 1];
  const den = a - 2 * b + c;
  const off = den < 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
  return best + 0.5 + off;
}

export interface GapDetection {
  gap: Gap;
  score: number;
  /** Gap quality of this pair in this frame, 0..1 (see `gapQuality`). */
  quality: number;
  /** Weaker of the two edge strengths. */
  confidence: number;
  /** Integer columns of the two edges (indices into the profile). */
  cols: [number, number];
}

export interface DetectOptions {
  minWidthFrac?: number;
  maxWidthFrac?: number;
  minCoherence?: number;
}

export interface PairMetrics {
  /** Edge strength of the left / right boundary, 0..1. */
  left: number;
  right: number;
  /** How different the inside looks from the less different of the two sides, 0..1. */
  contrast: number;
  /** How different the amount of detail inside is from the less different side, 0..1. */
  detail: number;
  /** The inside has more detail than both sides. */
  moreDetail: boolean;
  /** Share of the frame's height both sides run along, 0..1. */
  extent: number;
  /** How much stronger the strongest edge inside the pair is than allowed (0 = clean). */
  innerExcess: number;
  /** Parallax score: inside moves differently from the sides (-1..1, 0 if unobserved). */
  motion: number;
  /** How much of that parallax has actually been observed, 0..1. */
  motionConf: number;
}

const mean = (arr: Float32Array, x0: number, x1: number) => {
  let s = 0;
  let n = 0;
  for (let x = Math.max(0, x0); x < Math.min(arr.length, x1); x++, n++) s += arr[x];
  return n ? s / n : 0;
};

/**
 * Parallax evidence for the gap between columns a < b: how much more the inside
 * moves differently from the occluder than the sides do. A real gap scores
 * clearly positive once the device has slid a little; a rectangle stuck on
 * the wall scores about zero.
 */
export function pairMotion(motion: MotionEvidence | undefined, a: number, b: number): { score: number; conf: number } {
  if (!motion) return { score: 0, conf: 0 };
  const w = motion.evidence.length;
  const width = b - a;
  // Stay clear of the edges themselves: they blur in and out of both regions.
  const m = Math.max(1, Math.round(width * 0.15));
  const fw = Math.round(clamp(width, 4, w * 0.1));
  const inside = mean(motion.evidence, a + 1 + m, b + 1 - m);
  const left = mean(motion.evidence, a - fw - 1, a - 1);
  const right = mean(motion.evidence, b + 3, b + 3 + fw);
  // Only the inside has to have been observed: a featureless wall beside a gap
  // can't show motion either way, and simply counts as moving with the occluder.
  const conf = mean(motion.confidence, a + 1 + m, b + 1 - m);
  return { score: inside - Math.max(left, right), conf };
}

/** Measurements describing how much columns a < b look like the two sides of one gap. */
export function pairMetrics(p: EdgeProfile, a: number, b: number, motion?: MotionEvidence): PairMetrics {
  const w = p.width;
  const c = p.coherence;
  const width = b - a;

  // Compare the inside with each side, band by band from top to bottom. What
  // shows through a gap rarely looks like the occluder in every band, even
  // when their overall brightness happens to match.
  const fw = Math.round(clamp(width, 3, w * 0.1));
  const lx0 = Math.max(0, a - fw);
  const rx1 = Math.min(w, b + 2 + fw);
  const P = p.bandPrefix;
  let dl = 0;
  let dr = 0;
  for (let k = 0; k < p.bands; k++) {
    const o = k * (w + 1);
    const inner = (P[o + b + 1] - P[o + a + 1]) / width;
    const left = (P[o + a + 1] - P[o + lx0]) / Math.max(1, a + 1 - lx0);
    const right = (P[o + rx1] - P[o + b + 1]) / Math.max(1, rx1 - b - 1);
    dl += Math.abs(inner - left);
    dr += Math.abs(inner - right);
  }
  // Use the side that differs least: both sides should differ from the inside.
  const diff = Math.min(dl, dr) / p.bands;

  // Detail: compare the amount of horizontal structure inside vs each side
  // (skipping the edge columns, whose own blur would count as detail).
  const D = p.detailPrefix;
  const ia = Math.min(a + 2, b);
  const ib = Math.max(b, ia + 1);
  const dIn = (D[ib] - D[ia]) / Math.max(1, ib - ia);
  const dL = (D[Math.max(lx0, a - 1)] - D[lx0]) / Math.max(1, a - 1 - lx0);
  const dR = (D[rx1] - D[Math.min(rx1, b + 3)]) / Math.max(1, rx1 - b - 3);
  const ratio = (x: number, y: number) => Math.abs(Math.log((x + 3) / (y + 3)));
  const detail = Math.min(1, Math.min(ratio(dIn, dL), ratio(dIn, dR)) / Math.log(2.5));

  let innerMax = 0;
  for (let x = a + 3; x <= b - 3; x++) innerMax = Math.max(innerMax, c[x]);
  const weaker = Math.min(c[a], c[b]);
  const pm = pairMotion(motion, a, b);
  return {
    left: c[a],
    right: c[b],
    contrast: Math.min(1, diff / 25),
    detail,
    moreDetail: dIn > Math.max(dL, dR),
    extent: Math.min(p.extent[a], p.extent[b]),
    innerExcess: Math.max(0, innerMax - 0.6 * weaker),
    motion: pm.score,
    motionConf: pm.conf,
  };
}

/**
 * Ranking score for candidate pairs: two strong, full-height edges of similar
 * strength, an inside that looks different from the occluder on either side,
 * no stronger edges inside (which would mean a and b are really the outer
 * edges of something else), and — once observed — an inside that moves
 * differently from the sides.
 */
export function pairScore(p: EdgeProfile, a: number, b: number, motion?: MotionEvidence): number {
  return scoreFromMetrics(pairMetrics(p, a, b, motion));
}

function scoreFromMetrics(m: PairMetrics): number {
  return (
    m.left +
    m.right -
    0.3 * Math.abs(m.left - m.right) +
    0.4 * m.contrast +
    0.2 * m.detail +
    0.3 * m.extent -
    0.5 * m.innerExcess +
    1.2 * m.motionConf * m.motion
  );
}

/** Edge strength that counts as a fully convincing boundary. */
const QUALITY_EDGE_FULL = 0.7;

/**
 * How convincingly columns a < b bound a real see-through gap, 0..1.
 *
 * Multiplies together: edge strength (relative to the frame's typical
 * column), how different the inside looks and how much detail it has compared
 * with the sides, edge balance, a clean inside, and full-height edges. Once
 * the device has moved enough to observe parallax, that evidence takes over
 * from appearance: a real gap's inside slides relative to its edges; a
 * rectangle on the wall doesn't.
 */
export function gapQuality(p: EdgeProfile, a: number, b: number, motion?: MotionEvidence): number {
  return qualityFromMetrics(p, pairMetrics(p, a, b, motion));
}

function qualityFromMetrics(p: EdgeProfile, m: PairMetrics): number {
  const weaker = Math.min(m.left, m.right);
  const stronger = Math.max(m.left, m.right, 1e-6);
  // Judge edges against this frame's typical column, so heavy noise or texture
  // (where every column looks edgy) doesn't pass for a gap.
  const base = Math.min(p.baseline, 0.5);
  const edge = clamp((weaker - base) / Math.max(0.2, QUALITY_EDGE_FULL - base), 0, 1);
  const balance = weaker / stronger;
  const clean = 1 - Math.min(1, m.innerExcess / Math.max(0.1, weaker));

  // Seeing *something different* through the opening is the strongest still-image cue.
  const appearance = clamp(0.65 * m.contrast + 0.35 * m.detail + (m.moreDetail ? 0.1 : 0), 0, 1);
  let evidence = 0.2 + 0.8 * appearance;
  if (m.motionConf > 0) {
    // Parallax beats appearance once we've seen it (or seen its absence).
    const parallax = clamp(0.25 + 1.5 * m.motion, 0, 1);
    evidence += clamp(m.motionConf * 1.5, 0, 1) * (parallax - evidence);
  }
  return clamp(edge * evidence * (0.75 + 0.25 * balance) * (0.7 + 0.3 * clean) * (0.55 + 0.45 * m.extent), 0, 1);
}

/** Find the most plausible vertical gap in a single frame. */
export function detectGap(p: EdgeProfile, opts: DetectOptions = {}, motion?: MotionEvidence): GapDetection | null {
  const w = p.width;
  const c = p.coherence;
  const minW = Math.max(4, Math.round(w * (opts.minWidthFrac ?? 0.025)));
  const maxW = Math.round(w * (opts.maxWidthFrac ?? 0.4));
  const minC = opts.minCoherence ?? 0.25;

  // Local maxima with non-maximum suppression.
  const peaks: number[] = [];
  for (let x = 2; x < w - 3; x++) {
    if (c[x] >= minC && c[x] >= c[x - 1] && c[x] > c[x + 1]) peaks.push(x);
  }
  peaks.sort((a, b) => c[b] - c[a]);
  const kept: number[] = [];
  for (const x of peaks) {
    if (kept.every((k) => Math.abs(k - x) > 2)) kept.push(x);
    if (kept.length >= 24) break;
  }
  kept.sort((a, b) => a - b);

  let best: GapDetection | null = null;
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = kept[i];
      const b = kept[j];
      const width = b - a;
      if (width < minW) continue;
      if (width > maxW) break;
      // The user will aim the gap roughly at the centre.
      const off = ((a + b) / 2 - w / 2) / (w / 2);
      // Rank by both the edge score and the quality used to trigger recording,
      // so detection prefers the pair that recording would accept.
      const m = pairMetrics(p, a, b, motion);
      const quality = qualityFromMetrics(p, m);
      const score = scoreFromMetrics(m) + quality - 0.35 * off * off;
      if (!best || score > best.score) {
        best = { gap: { left: a + 0.5, right: b + 0.5 }, score, quality, confidence: Math.min(c[a], c[b]), cols: [a, b] };
      }
    }
  }
  if (best) best.gap = { left: refineEdge(p, best.cols[0]), right: refineEdge(p, best.cols[1]) };
  return best;
}

export interface TrackResult {
  gap: Gap;
  confidence: number;
  /** Integer columns of the two edges (indices into the profile). */
  cols: [number, number];
}

/**
 * Follow a known gap into the next frame. Both edges belong to the same
 * occluder, so they are searched as one rigid shift plus a small width change,
 * starting from where the occluder's own motion (`shift`, px) says they went.
 */
export function trackGap(p: EdgeProfile, prev: Gap, motion?: MotionEvidence, shift = 0): TrackResult | null {
  const w = p.width;
  const c = p.coherence;
  const r = Math.max(4, Math.round(w * 0.06));
  const a0 = Math.round(prev.left - 0.5 + shift);
  const b0 = Math.round(prev.right - 0.5 + shift);

  let bestScore = -Infinity;
  let ba = -1;
  let bb = -1;
  for (let d = -r; d <= r; d++) {
    for (let om = -2; om <= 2; om++) {
      const a = a0 + d;
      const b = b0 + d + om;
      if (a < 2 || b > w - 4 || b - a < 3) continue;
      // Cheap pre-filter before the full pair score.
      if (c[a] + c[b] < 0.3) continue;
      const s = pairScore(p, a, b, motion) - 0.03 * Math.abs(om) - 0.008 * Math.abs(d);
      if (s > bestScore) {
        bestScore = s;
        ba = a;
        bb = b;
      }
    }
  }
  if (ba < 0) return null;
  return {
    gap: { left: refineEdge(p, ba), right: refineEdge(p, bb) },
    confidence: Math.min(c[ba], c[bb]),
    cols: [ba, bb],
  };
}
