import type { DepthWorkerRequest, DepthWorkerResponse } from "./protocol";

export type DepthResult = Extract<DepthWorkerResponse, { type: "result" }>;

export interface DepthStatus {
  state: "idle" | "loading" | "ready" | "error";
  /** 0..1 download progress while loading. */
  progress: number;
  device?: "webgpu" | "wasm";
  dtype?: string;
  error?: string;
  /** Depth results per second (recent average). */
  rate: number;
  /** Time from sending a frame to getting its result, ms (recent average). */
  latencyMs: number;
  /** Model inference time alone, ms. */
  inferMs: number;
}

/**
 * Main-thread side of the depth worker. Keeps at most one frame in flight
 * (frames are dropped, never queued, so results are as fresh as possible).
 */
export class DepthClient {
  status: DepthStatus = { state: "idle", progress: 0, rate: 0, latencyMs: 0, inferMs: 0 };
  /** Longest side of the image sent to the model (rounded to a multiple of 14). */
  longSide = 336;
  onResult: ((r: DepthResult) => void) | null = null;
  onStatus: ((s: DepthStatus) => void) | null = null;

  private worker: Worker | null = null;
  private busy = false;
  private nextId = 1;
  private sentAt = new Map<number, number>();
  private resultTimes: number[] = [];
  private lastStatusAt = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  get ready() {
    return this.status.state === "ready";
  }

  /** Start loading the model (no-op if already started). */
  start(preferGPU = true) {
    if (this.worker) return;
    this.setStatus({ state: "loading", progress: 0, error: undefined });
    this.worker = new Worker(new URL("./depthWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<DepthWorkerResponse>) => this.handle(e.data);
    this.worker.onerror = (e) => this.setStatus({ state: "error", error: e.message || "Depth worker failed to start" });
    this.send({ type: "init", preferGPU });
  }

  /**
   * Send a frame for depth estimation, unless one is already in flight.
   * Returns whether it was sent.
   */
  request(src: CanvasImageSource, srcWidth: number, srcHeight: number, frameId: number): boolean {
    if (!this.worker || !this.ready || this.busy) return false;
    const k = this.longSide / Math.max(srcWidth, srcHeight);
    const m14 = (v: number) => Math.max(14, Math.round(v / 14) * 14);
    const w = m14(srcWidth * k);
    const h = m14(srcHeight * k);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(src, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    const id = this.nextId++;
    this.sentAt.set(id, performance.now());
    this.busy = true;
    this.send({ type: "infer", id, frameId, width: w, height: h, rgba: img.data.buffer }, [img.data.buffer]);
    return true;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.sentAt.clear();
    this.setStatus({ state: "idle", progress: 0, rate: 0 });
  }

  private send(msg: DepthWorkerRequest, transfer: Transferable[] = []) {
    this.worker?.postMessage(msg, transfer);
  }

  private setStatus(patch: Partial<DepthStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  private handle(msg: DepthWorkerResponse) {
    if (msg.type === "progress") {
      this.setStatus({ progress: msg.total > 0 ? msg.loaded / msg.total : 0 });
    } else if (msg.type === "ready") {
      this.setStatus({ state: "ready", progress: 1, device: msg.device, dtype: msg.dtype });
    } else if (msg.type === "error") {
      if (msg.id !== undefined) {
        // A single frame failed: drop it and carry on.
        this.busy = false;
        this.sentAt.delete(msg.id);
        console.warn("Depth frame failed:", msg.message);
      } else {
        this.setStatus({ state: "error", error: msg.message });
      }
    } else if (msg.type === "result") {
      this.busy = false;
      const now = performance.now();
      const sent = this.sentAt.get(msg.id);
      this.sentAt.delete(msg.id);
      this.resultTimes.push(now);
      while (this.resultTimes.length > 1 && now - this.resultTimes[0] > 2000) this.resultTimes.shift();
      const span = (now - this.resultTimes[0]) / 1000;
      const rate = span > 0 ? (this.resultTimes.length - 1) / span : 0;
      const lat = sent === undefined ? this.status.latencyMs : now - sent;
      this.status = {
        ...this.status,
        rate,
        latencyMs: this.status.latencyMs ? 0.8 * this.status.latencyMs + 0.2 * lat : lat,
        inferMs: this.status.inferMs ? 0.8 * this.status.inferMs + 0.2 * msg.inferMs : msg.inferMs,
      };
      // Status readout: a couple of updates a second is plenty.
      if (now - this.lastStatusAt > 500) {
        this.lastStatusAt = now;
        this.onStatus?.(this.status);
      }
      this.onResult?.(msg);
    }
  }
}
