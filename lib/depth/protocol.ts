import type { DepthGap } from "../gap/depthGap";

/** Messages to the depth worker. */
export type DepthWorkerRequest =
  | { type: "init"; preferGPU: boolean }
  | {
      type: "infer";
      id: number;
      /** Scanner frame index the image was taken from (echoed back for latency compensation). */
      frameId: number;
      width: number;
      height: number;
      /** RGBA pixels, `width` x `height` (both multiples of 14). */
      rgba: ArrayBuffer;
    };

/** Messages from the depth worker. */
export type DepthWorkerResponse =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; device: "webgpu" | "wasm"; dtype: string }
  | { type: "error"; id?: number; message: string }
  | {
      type: "result";
      id: number;
      frameId: number;
      /** Depth map size. */
      width: number;
      height: number;
      gaps: DepthGap[];
      /** 8-bit normalised depth (0 = far, 255 = near), row-major, for debug views. */
      depth: ArrayBuffer;
      inferMs: number;
      totalMs: number;
    };
