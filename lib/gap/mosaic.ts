/**
 * Weighted-average image accumulator that grows horizontally as new parts of
 * the hidden scene are revealed.
 *
 * Coordinates passed in are "local": local (0,0) is where the first frame's
 * pixel (0,0) landed. Internally they are offset by originX/originY.
 */
export class Accumulator {
  readonly channels: 1 | 3;
  width: number;
  readonly height: number;
  originX: number;
  readonly originY: number;
  sum: Float32Array;
  weight: Float32Array;
  /** Only for single-channel accumulators: sum / weight, kept up to date for registration. */
  value: Float32Array | null;
  /** Bounding box of painted pixels, in internal (array) coordinates; minX > maxX means empty. */
  minX = Infinity;
  maxX = -Infinity;
  minY = Infinity;
  maxY = -Infinity;
  private readonly maxWeight: number;
  private readonly growChunk: number;

  constructor(opts: { channels: 1 | 3; frameWidth: number; frameHeight: number; verticalPad?: number; maxWeight?: number }) {
    this.channels = opts.channels;
    const pad = Math.round(opts.frameHeight * (opts.verticalPad ?? 0.12));
    this.height = opts.frameHeight + 2 * pad;
    this.originY = pad;
    this.growChunk = Math.max(64, Math.round(opts.frameWidth * 0.75));
    this.width = opts.frameWidth + 2 * this.growChunk;
    this.originX = this.growChunk;
    this.maxWeight = opts.maxWeight ?? 6;
    this.sum = new Float32Array(this.width * this.height * this.channels);
    this.weight = new Float32Array(this.width * this.height);
    this.value = this.channels === 1 ? new Float32Array(this.width * this.height) : null;
  }

  get isEmpty(): boolean {
    return this.minX > this.maxX;
  }

  /** Painted horizontal extent in local coordinates. */
  get localExtentX(): [number, number] {
    return [this.minX - this.originX, this.maxX - this.originX];
  }

  /** Make sure local columns [x0, x1] are inside the buffer. */
  ensure(x0: number, x1: number): void {
    let addLeft = 0;
    let addRight = 0;
    while (x0 + this.originX + addLeft < 1) addLeft += this.growChunk;
    while (x1 + this.originX + addLeft >= this.width + addLeft + addRight - 1) addRight += this.growChunk;
    if (!addLeft && !addRight) return;

    const nw = this.width + addLeft + addRight;
    const h = this.height;
    const ch = this.channels;
    const nsum = new Float32Array(nw * h * ch);
    const nweight = new Float32Array(nw * h);
    const nvalue = this.value ? new Float32Array(nw * h) : null;
    for (let y = 0; y < h; y++) {
      nsum.set(this.sum.subarray(y * this.width * ch, (y + 1) * this.width * ch), (y * nw + addLeft) * ch);
      nweight.set(this.weight.subarray(y * this.width, (y + 1) * this.width), y * nw + addLeft);
      if (nvalue && this.value) nvalue.set(this.value.subarray(y * this.width, (y + 1) * this.width), y * nw + addLeft);
    }
    this.sum = nsum;
    this.weight = nweight;
    this.value = nvalue;
    this.width = nw;
    this.originX += addLeft;
    this.minX += addLeft;
    this.maxX += addLeft;
  }

  /**
   * Paint columns [srcX0, srcX1) of a source image into the mosaic, translated
   * by (offX, offY) local pixels (fractional allowed — bilinear resampling).
   *
   * `src.data` has `stride` values per pixel (1 for gray, 4 for RGBA).
   * `srcXBase` is the frame x-coordinate of the source buffer's column 0 (for
   * sources that are a cropped strip of the frame).
   */
  accumulate(
    src: { data: ArrayLike<number>; width: number; height: number },
    stride: number,
    srcXBase: number,
    srcX0: number,
    srcX1: number,
    offX: number,
    offY: number,
    weightScale = 1,
  ): void {
    const sw = src.width;
    const sh = src.height;
    const sd = src.data;
    const ch = this.channels;
    const stripW = srcX1 - srcX0;
    if (stripW < 2) return;

    const u0 = Math.ceil(srcX0 + offX);
    const u1 = Math.floor(srcX1 - 1 + offX);
    this.ensure(u0, u1);
    const W = this.width;
    const ox = this.originX;
    const oy = this.originY;
    const wmax = this.maxWeight;

    // Per-column sampling positions and feather weights (heavier in the strip centre).
    const n = u1 - u0 + 1;
    const colIdx = new Int32Array(n);
    const colT = new Float32Array(n);
    const colW = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const xs = u0 + i - offX; // frame x
      const t = (xs - srcX0 + 0.5) / stripW;
      const bx = xs - srcXBase;
      const fx = Math.floor(bx);
      colIdx[i] = Math.min(Math.max(fx, 0), sw - 2);
      colT[i] = bx - colIdx[i];
      colW[i] = (0.08 + Math.sin(Math.PI * Math.min(Math.max(t, 0), 1))) * weightScale;
    }

    const v0 = Math.ceil(offY);
    const v1 = Math.floor(sh - 1 + offY);
    for (let v = v0; v <= v1; v++) {
      const Y = v + oy;
      if (Y < 0 || Y >= this.height) continue;
      const ys = v - offY;
      const fy = Math.min(Math.floor(ys), sh - 2);
      const ty = ys - fy;
      const r0 = fy * sw;
      const r1 = r0 + sw;
      const rowBase = Y * W + ox + u0;
      for (let i = 0; i < n; i++) {
        const tx = colT[i];
        const wgt = colW[i];
        const i00 = (r0 + colIdx[i]) * stride;
        const i01 = i00 + stride;
        const i10 = (r1 + colIdx[i]) * stride;
        const i11 = i10 + stride;
        const w00 = (1 - tx) * (1 - ty);
        const w01 = tx * (1 - ty);
        const w10 = (1 - tx) * ty;
        const w11 = tx * ty;
        const idx = rowBase + i;
        let wt = this.weight[idx] + wgt;
        const base = idx * ch;
        for (let k = 0; k < ch; k++) {
          const val = sd[i00 + k] * w00 + sd[i01 + k] * w01 + sd[i10 + k] * w10 + sd[i11 + k] * w11;
          this.sum[base + k] += val * wgt;
        }
        if (wt > wmax) {
          const f = wmax / wt;
          for (let k = 0; k < ch; k++) this.sum[base + k] *= f;
          wt = wmax;
        }
        this.weight[idx] = wt;
        if (this.value) this.value[idx] = this.sum[idx] / wt;
      }
      if (Y < this.minY) this.minY = Y;
      if (Y > this.maxY) this.maxY = Y;
    }
    if (u0 + ox < this.minX) this.minX = u0 + ox;
    if (u1 + ox > this.maxX) this.maxX = u1 + ox;
  }

  /** Render the painted bounding box to RGBA. Unpainted pixels are transparent. */
  toRGBA(): { data: Uint8ClampedArray; width: number; height: number; x0: number; y0: number } | null {
    if (this.isEmpty) return null;
    const x0 = this.minX;
    const y0 = this.minY;
    const w = this.maxX - this.minX + 1;
    const h = this.maxY - this.minY + 1;
    const out = new Uint8ClampedArray(w * h * 4);
    const ch = this.channels;
    for (let y = 0; y < h; y++) {
      const srcRow = (y + y0) * this.width + x0;
      for (let x = 0; x < w; x++) {
        const idx = srcRow + x;
        const wt = this.weight[idx];
        const o = (y * w + x) * 4;
        if (wt < 0.05) continue;
        if (ch === 3) {
          out[o] = this.sum[idx * 3] / wt;
          out[o + 1] = this.sum[idx * 3 + 1] / wt;
          out[o + 2] = this.sum[idx * 3 + 2] / wt;
        } else {
          out[o] = out[o + 1] = out[o + 2] = this.sum[idx] / wt;
        }
        out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h, x0, y0 };
  }
}
