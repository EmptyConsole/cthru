// Runs Depth Anything V2 Small on a JPEG and saves the raw depth (Float32, row-major)
// plus a JPEG visualisation. Used to build test fixtures from real model output.
//   node scripts/depth-fixture.mjs <in.jpg> <out-basename> [longSide=392] [dtype=fp32]
import { readFileSync, writeFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { AutoModel, Tensor } from "@huggingface/transformers";

const [, , input, out, longSideArg = "392", dtype = "fp32"] = process.argv;
const img = jpeg.decode(readFileSync(input), { useTArray: true });
const k = Number(longSideArg) / Math.max(img.width, img.height);
const m14 = (v) => Math.max(14, Math.round(v / 14) * 14);
const W = m14(img.width * k), H = m14(img.height * k);
const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
const px = new Float32Array(3 * W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  // bilinear sample
  const sx = ((x + 0.5) * img.width) / W - 0.5, sy = ((y + 0.5) * img.height) / H - 0.5;
  const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
  const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
  for (let c = 0; c < 3; c++) {
    const g = (xx, yy) => img.data[(yy * img.width + xx) * 4 + c];
    const v = (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) + (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy;
    px[c * W * H + y * W + x] = (v / 255 - mean[c]) / std[c];
  }
}
const model = await AutoModel.from_pretrained("onnx-community/depth-anything-v2-small", { dtype, device: "cpu" });
const t0 = performance.now();
const { predicted_depth } = await model({ pixel_values: new Tensor("float32", px, [1, 3, H, W]) });
console.log("inference ms", Math.round(performance.now() - t0), "input", W, H, "output dims", predicted_depth.dims);
const d = predicted_depth.data;
const [oh, ow] = predicted_depth.dims.slice(-2);
writeFileSync(`${out}.f32`, Buffer.from(new Float32Array(d).buffer));
writeFileSync(`${out}.json`, JSON.stringify({ width: ow, height: oh, source: input, model: "onnx-community/depth-anything-v2-small", dtype }));
let lo = Infinity, hi = -Infinity;
for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
console.log("depth range", lo.toFixed(3), hi.toFixed(3));
const vis = Buffer.alloc(ow * oh * 4);
for (let i = 0; i < ow * oh; i++) { const v = Math.round(((d[i] - lo) / (hi - lo)) * 255); vis[i * 4] = vis[i * 4 + 1] = vis[i * 4 + 2] = v; vis[i * 4 + 3] = 255; }
writeFileSync(`${out}.vis.jpg`, jpeg.encode({ data: vis, width: ow, height: oh }, 90).data);
