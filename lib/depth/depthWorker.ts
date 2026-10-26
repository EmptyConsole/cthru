/// <reference lib="webworker" />
/**
 * Runs Depth Anything V2 Small off the main thread and turns each depth map
 * into gap candidates, so the camera loop and stitching stay smooth.
 *
 * Uses WebGPU when available (fp16 if the GPU supports it, else fp32), and
 * falls back to WebAssembly with the 8-bit model.
 */
import { AutoModel, env, Tensor, type PreTrainedModel, type ProgressInfo } from "@huggingface/transformers";
import { findDepthGaps } from "../gap/depthGap";
import type { DepthWorkerRequest, DepthWorkerResponse } from "./protocol";

const MODEL_ID = "onnx-community/depth-anything-v2-small";
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

env.allowLocalModels = false;
env.useBrowserCache = true;

let model: PreTrainedModel | null = null;

const post = (msg: DepthWorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function pickWebGPU(): Promise<{ dtype: "fp16" | "fp32" } | null> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    return { dtype: adapter.features.has("shader-f16") ? "fp16" : "fp32" };
  } catch {
    return null;
  }
}

async function load(preferGPU: boolean, safeWasm = false) {
  const progress = (p: ProgressInfo) => {
    if (p.status === "progress_total") post({ type: "progress", loaded: p.loaded, total: p.total });
  };
  if (safeWasm) {
    // Transformers.js would load the asyncify build on Safari 26, which grows
    // memory while WebKit compiles it (microsoft/onnxruntime#26827); the plain
    // build is the one reported stable there. One thread: Safari can't start
    // workers inside a worker, and the static site isn't cross-origin isolated.
    const wasm = env.backends.onnx.wasm!;
    const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${env.backends.onnx.versions?.web}/dist/`;
    wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.mjs`, wasm: `${base}ort-wasm-simd-threaded.wasm` };
    wasm.numThreads = 1;
    model = await AutoModel.from_pretrained(MODEL_ID, {
      device: "wasm",
      dtype: "q8",
      progress_callback: progress,
      // The WASM heap never shrinks: don't let the arena and memory patterns grow it further.
      session_options: { enableCpuMemArena: false, enableMemPattern: false },
    });
    await warmUp();
    post({ type: "ready", device: "wasm", dtype: "q8" });
    return;
  }
  const gpu = preferGPU ? await pickWebGPU() : null;
  if (gpu) {
    try {
      model = await AutoModel.from_pretrained(MODEL_ID, { device: "webgpu", dtype: gpu.dtype, progress_callback: progress });
      await warmUp();
      post({ type: "ready", device: "webgpu", dtype: gpu.dtype });
      return;
    } catch (e) {
      console.warn("WebGPU depth model failed, falling back to WebAssembly", e);
      model = null;
    }
  }
  model = await AutoModel.from_pretrained(MODEL_ID, { device: "wasm", dtype: "q8", progress_callback: progress });
  await warmUp();
  post({ type: "ready", device: "wasm", dtype: "q8" });
}

/** First run compiles shaders / kernels; do it before real frames arrive. */
async function warmUp() {
  const w = 140;
  const h = 112;
  await model!({ pixel_values: new Tensor("float32", new Float32Array(3 * w * h), [1, 3, h, w]) });
}

async function infer(req: Extract<DepthWorkerRequest, { type: "infer" }>) {
  const { width: w, height: h } = req;
  const rgba = new Uint8ClampedArray(req.rgba);
  const n = w * h;
  const px = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    px[i] = (rgba[j] / 255 - MEAN[0]) / STD[0];
    px[n + i] = (rgba[j + 1] / 255 - MEAN[1]) / STD[1];
    px[2 * n + i] = (rgba[j + 2] / 255 - MEAN[2]) / STD[2];
  }
  const t0 = performance.now();
  const out = (await model!({ pixel_values: new Tensor("float32", px, [1, 3, h, w]) })) as { predicted_depth: Tensor };
  const inferMs = performance.now() - t0;
  const dims = out.predicted_depth.dims;
  const dh = dims[dims.length - 2];
  const dw = dims[dims.length - 1];
  const depth = new Float32Array(out.predicted_depth.data as Float32Array);
  out.predicted_depth.dispose?.();

  const res = findDepthGaps({ data: depth, width: dw, height: dh });
  // 8-bit depth for the debug overlay (0 = far … 255 = near), in the same normalisation.
  const [lo, hi] = res.range;
  const vis = new Uint8ClampedArray(dw * dh);
  const k = 255 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < depth.length; i++) vis[i] = (depth[i] - lo) * k;
  post(
    {
      type: "result",
      id: req.id,
      frameId: req.frameId,
      width: dw,
      height: dh,
      gaps: res.gaps,
      depth: vis.buffer,
      inferMs,
      totalMs: performance.now() - t0,
    },
    [vis.buffer],
  );
}

self.onmessage = async (e: MessageEvent<DepthWorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") await load(msg.preferGPU, msg.safeWasm);
    else if (msg.type === "infer") {
      if (!model) throw new Error("Depth model not loaded");
      await infer(msg);
    }
  } catch (err) {
    post({
      type: "error",
      id: msg.type === "infer" ? msg.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
