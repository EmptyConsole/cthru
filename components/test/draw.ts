import type { DepthResult } from "@/lib/depth/client";
import type { GapScanner } from "@/lib/gap/scanner";
import type { Gap } from "@/lib/gap/types";
import type { DebugFlags } from "./settings";

export interface OverlayExtras {
  debug: DebugFlags;
  depthVis: HTMLCanvasElement | null;
  /** Gap being dragged out by hand, in analysis pixels. */
  drag: { x0: number; x1: number } | null;
}

/** Sizes a canvas's backing store to its CSS size at the device pixel ratio. Returns the 2D context. */
export function fitCanvas(c: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return { g: c.getContext("2d")!, w, h, dpr };
}

export function drawOverlay(ov: HTMLCanvasElement, scanner: GapScanner, x: OverlayExtras) {
  const { g, w: cw, h: ch, dpr } = fitCanvas(ov);
  g.clearRect(0, 0, cw, ch);
  const sx = cw / scanner.width;
  const sy = ch / scanner.height;
  // Boundaries are in pixel-centre coordinates; +0.5 converts to pixel edges.
  const X = (b: number) => (b + 0.5) * sx;
  const Y = (b: number) => (b + 0.5) * sy;
  const box = (gp: Gap) => ({
    L: X(gp.left),
    R: X(gp.right),
    T: gp.top !== undefined ? Math.max(0, Y(gp.top)) : 0,
    B: gp.bottom !== undefined ? Math.min(ch, Y(gp.bottom)) : ch,
  });

  if (x.debug.depthMap && x.depthVis) {
    g.globalAlpha = 0.6;
    g.drawImage(x.depthVis, 0, 0, cw, ch);
    g.globalAlpha = 1;
  }

  if (x.debug.candidates && scanner.mode === "depth") {
    g.font = `${Math.round(11 * dpr)}px system-ui, sans-serif`;
    for (const c of scanner.depthCandidates) {
      const b = box(c);
      g.strokeStyle = "rgba(34,211,238,0.85)";
      g.lineWidth = 1.25 * dpr;
      g.setLineDash([4 * dpr, 4 * dpr]);
      g.strokeRect(b.L, b.T, b.R - b.L, b.B - b.T);
      g.setLineDash([]);
      const label = `${Math.round(c.quality * 100)}%`;
      g.fillStyle = "rgba(8,47,73,0.85)";
      g.fillRect(b.L, b.T, g.measureText(label).width + 8 * dpr, 16 * dpr);
      g.fillStyle = "#a5f3fc";
      g.fillText(label, b.L + 4 * dpr, b.T + 12 * dpr);
    }
  }

  if (scanner.phase === "tracking" && scanner.gap) {
    const b = box(scanner.gap);
    const live = scanner.scanning && scanner.recording;
    const color = !scanner.scanning ? "#94a3b8" : live ? "#f43f5e" : "#38bdf8";
    // Dim everything outside the gap, so the eye goes to it.
    g.fillStyle = "rgba(0,0,0,0.5)";
    g.fillRect(0, 0, b.L, ch);
    g.fillRect(b.R, 0, cw - b.R, ch);
    g.fillRect(b.L, 0, b.R - b.L, b.T);
    g.fillRect(b.L, b.B, b.R - b.L, ch - b.B);
    g.strokeStyle = color;
    g.lineWidth = 3 * dpr;
    g.setLineDash(live ? [] : [10 * dpr, 6 * dpr]);
    g.strokeRect(b.L, b.T, b.R - b.L, b.B - b.T);
    g.setLineDash([]);
  } else if (scanner.candidate) {
    const st = scanner.getStatus();
    const good = st.quality >= st.threshold;
    const b = box(scanner.candidate);
    g.fillStyle = good ? "rgba(251,191,36,0.16)" : "rgba(251,146,60,0.08)";
    g.fillRect(b.L, b.T, b.R - b.L, b.B - b.T);
    g.strokeStyle = good ? "#fbbf24" : "#fb923c";
    g.lineWidth = 2.5 * dpr;
    g.setLineDash([8 * dpr, 6 * dpr]);
    g.strokeRect(b.L, b.T, b.R - b.L, b.B - b.T);
    g.setLineDash([]);
    // Lock-on progress along the bottom of the box.
    g.fillStyle = "#fbbf24";
    g.fillRect(b.L, b.B - 6 * dpr, (b.R - b.L) * st.lockProgress, 6 * dpr);
  }

  if (x.drag) {
    const a = X(Math.min(x.drag.x0, x.drag.x1));
    const b = X(Math.max(x.drag.x0, x.drag.x1));
    g.fillStyle = "rgba(96,165,250,0.22)";
    g.fillRect(a, 0, b - a, ch);
    g.strokeStyle = "#60a5fa";
    g.lineWidth = 2 * dpr;
    g.strokeRect(a, 1, b - a, ch - 2);
  }

  if (x.debug.edgeGraph && scanner.lastProfile) {
    const h = ch * 0.25;
    g.fillStyle = "rgba(0,0,0,0.5)";
    g.fillRect(0, ch - h, cw, h);
    const plot = (arr: Float32Array, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const px = X(i);
        const py = ch - Math.min(1, arr[i]) * h;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    };
    // Pink: edge strength. Cyan: parallax evidence (moves differently from the occluder).
    plot(scanner.lastProfile.coherence, "#f472b6");
    plot(scanner.motionMap.evidence, "#22d3ee");
  }
}

/**
 * Copies the scanner's picture into `target` (full resolution). Returns where
 * the current gap strip sits in it, or null if there's no picture yet.
 */
export function renderMosaic(target: HTMLCanvasElement, scanner: GapScanner) {
  const view = scanner.getMosaicView();
  if (!view) return null;
  const { image } = view;
  if (target.width !== image.width || target.height !== image.height) {
    target.width = image.width;
    target.height = image.height;
  }
  target
    .getContext("2d")!
    .putImageData(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
  return view.window ?? { x: -1, width: 0 };
}

/**
 * Draws the picture so far into the live strip under the viewfinder: scaled
 * to the strip's height, and scrolled so the part being added is in view.
 */
export function drawStrip(
  strip: HTMLCanvasElement,
  mosaic: HTMLCanvasElement,
  win: { x: number; width: number } | null,
  mirror: boolean,
) {
  const { g, w, h, dpr } = fitCanvas(strip);
  g.clearRect(0, 0, w, h);
  if (!mosaic.width || !mosaic.height) return;
  const k = h / mosaic.height;
  const dw = mosaic.width * k;
  let centre = win && win.x >= 0 ? (win.x + win.width / 2) * k : dw / 2;
  if (mirror) centre = dw - centre;
  // Whole picture fits: centre it. Otherwise follow the strip being added.
  const off = dw <= w ? (w - dw) / 2 : Math.min(0, Math.max(w - dw, w / 2 - centre));
  g.save();
  g.translate(off, 0);
  if (mirror) {
    g.translate(dw, 0);
    g.scale(-1, 1);
  }
  g.imageSmoothingQuality = "high";
  g.drawImage(mosaic, 0, 0, dw, h);
  if (win && win.x >= 0) {
    g.strokeStyle = "#f43f5e";
    g.lineWidth = 2 * dpr;
    g.strokeRect(win.x * k, dpr, win.width * k, h - 2 * dpr);
  }
  g.restore();
}

/** Shape a raw depth map like a worker result, for the overlay. */
export function depthResultForVis(d: { data: Float32Array; width: number; height: number }, range: [number, number]): DepthResult {
  const vis = new Uint8ClampedArray(d.data.length);
  const k = 255 / Math.max(1e-6, range[1] - range[0]);
  for (let i = 0; i < d.data.length; i++) vis[i] = (d.data[i] - range[0]) * k;
  return { type: "result", id: 0, frameId: 0, width: d.width, height: d.height, gaps: [], depth: vis.buffer, inferMs: 0, totalMs: 0 };
}

/** Colour-map a depth result for the overlay: near = warm, far = cool. */
export function depthToCanvas(r: DepthResult): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = r.width;
  c.height = r.height;
  const g = c.getContext("2d")!;
  const img = g.createImageData(r.width, r.height);
  const d = new Uint8ClampedArray(r.depth);
  for (let i = 0; i < d.length; i++) {
    const t = d[i] / 255;
    const o = i * 4;
    img.data[o] = 255 * Math.min(1, 1.6 * t);
    img.data[o + 1] = 255 * (0.25 + 0.5 * Math.sin(Math.PI * t));
    img.data[o + 2] = 255 * Math.min(1, 1.6 * (1 - t));
    img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** The picture as a PNG blob, mirrored if asked. */
export function mosaicBlob(mosaic: HTMLCanvasElement, mirror: boolean): Promise<Blob | null> {
  const out = document.createElement("canvas");
  out.width = mosaic.width;
  out.height = mosaic.height;
  const g = out.getContext("2d")!;
  if (mirror) {
    g.translate(out.width, 0);
    g.scale(-1, 1);
  }
  g.drawImage(mosaic, 0, 0);
  return new Promise((resolve) => out.toBlob(resolve, "image/png"));
}
