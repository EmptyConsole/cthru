/**
 * Synthetic "camera" for trying the scanner without a real gap: a wooden fence
 * with one vertical slit, close to the camera, and a scene further away.
 *
 * The virtual camera slides sideways while turning to keep the slit roughly
 * centred — the way a person peeks through a gap. Sliding moves the near fence
 * more than the far scene (parallax), so different parts of the scene show
 * through the slit.
 */

const FRAME_W = 960;
const FRAME_H = 720;
const SCENE_W = 2400;
const SCENE_H = 900;
const FENCE_W = 1800;
const SLIT_W = 84;
/** Image-space shift per unit of camera slide, for the near fence and the far scene. */
const K_NEAR = 1;
const K_FAR = 0.3;
/** How much the virtual person turns to keep the slit in view (0 = no turning). */
const TURN = 0.8;
const SLIDE_AMPLITUDE = 520;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function drawScene(): HTMLCanvasElement {
  const c = makeCanvas(SCENE_W, SCENE_H);
  const g = c.getContext("2d")!;
  const rand = rng(7);

  const sky = g.createLinearGradient(0, 0, 0, SCENE_H);
  sky.addColorStop(0, "#1e3a8a");
  sky.addColorStop(0.55, "#f59e0b");
  sky.addColorStop(1, "#7c2d12");
  g.fillStyle = sky;
  g.fillRect(0, 0, SCENE_W, SCENE_H);

  g.fillStyle = "#fde68a";
  g.beginPath();
  g.arc(SCENE_W * 0.3, 260, 90, 0, Math.PI * 2);
  g.fill();

  // Mountains
  g.fillStyle = "#4c1d95";
  g.beginPath();
  g.moveTo(0, 560);
  for (let x = 0; x <= SCENE_W; x += 60) g.lineTo(x, 400 + rand() * 160);
  g.lineTo(SCENE_W, SCENE_H);
  g.lineTo(0, SCENE_H);
  g.fill();

  // Buildings with windows
  for (let x = 0; x < SCENE_W; ) {
    const bw = 90 + rand() * 120;
    const bh = 180 + rand() * 280;
    const hue = Math.floor(rand() * 360);
    g.fillStyle = `hsl(${hue} 35% 22%)`;
    g.fillRect(x, SCENE_H - 120 - bh, bw, bh);
    for (let wy = SCENE_H - 100 - bh; wy < SCENE_H - 140; wy += 30) {
      for (let wx = x + 10; wx < x + bw - 18; wx += 24) {
        g.fillStyle = rand() > 0.45 ? `hsl(${45 + rand() * 20} 95% ${55 + rand() * 25}%)` : "#111827";
        g.fillRect(wx, wy, 12, 16);
      }
    }
    x += bw + 8 + rand() * 30;
  }

  // Ground
  g.fillStyle = "#14532d";
  g.fillRect(0, SCENE_H - 120, SCENE_W, 120);

  // Big readable text and numbered markers make a mirrored result obvious.
  g.font = "bold 150px system-ui, sans-serif";
  g.textBaseline = "middle";
  g.lineWidth = 10;
  g.strokeStyle = "#0f172a";
  g.fillStyle = "#f8fafc";
  const text = "HELLO FROM BEHIND →";
  const tw = g.measureText(text).width;
  g.strokeText(text, (SCENE_W - tw) / 2, 470);
  g.fillText(text, (SCENE_W - tw) / 2, 470);

  g.font = "bold 56px system-ui, sans-serif";
  for (let i = 0; i < 10; i++) {
    const cx = 160 + i * 230;
    g.fillStyle = `hsl(${i * 36} 80% 55%)`;
    g.beginPath();
    g.arc(cx, SCENE_H - 60, 42, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#0f172a";
    g.textAlign = "center";
    g.fillText(String(i + 1), cx, SCENE_H - 58);
  }
  g.textAlign = "start";
  return c;
}

function drawFence(): HTMLCanvasElement {
  const c = makeCanvas(FENCE_W, FRAME_H + 80);
  const g = c.getContext("2d")!;
  const rand = rng(11);
  g.fillStyle = "#a16207";
  g.fillRect(0, 0, c.width, c.height);

  // Wood grain: thin wavy vertical streaks.
  for (let i = 0; i < 900; i++) {
    const x = rand() * c.width;
    g.strokeStyle = rand() > 0.5 ? "rgba(66,32,6,0.18)" : "rgba(253,224,71,0.10)";
    g.lineWidth = 1 + rand() * 2;
    g.beginPath();
    g.moveTo(x, 0);
    for (let y = 0; y <= c.height; y += 40) g.lineTo(x + Math.sin(y / 90 + i) * 3, y);
    g.stroke();
  }
  // Subtle seams between boards.
  for (let x = 40; x < c.width; x += 150) {
    g.fillStyle = "rgba(41,20,4,0.35)";
    g.fillRect(x, 0, 2, c.height);
  }
  // Knots
  for (let i = 0; i < 25; i++) {
    g.fillStyle = "rgba(66,32,6,0.5)";
    g.beginPath();
    g.ellipse(rand() * c.width, rand() * c.height, 6 + rand() * 8, 12 + rand() * 14, 0, 0, Math.PI * 2);
    g.fill();
  }

  // Decoys: things fixed to the fence that look like gaps in a still image.
  // A full-height poster strip, and a shorter sign. They move with the fence,
  // so sliding shows they're not openings.
  const poster = (x: number, y: number, w: number, h: number, hue: number, label: string) => {
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, `hsl(${hue} 70% 35%)`);
    grad.addColorStop(0.5, `hsl(${hue + 40} 80% 60%)`);
    grad.addColorStop(1, `hsl(${hue + 80} 60% 25%)`);
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `hsla(${hue + rand() * 120} 80% ${30 + rand() * 50}% / 0.8)`;
      g.fillRect(x + rand() * (w - 16), y + rand() * (h - 16), 6 + rand() * 12, 6 + rand() * 12);
    }
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate(-Math.PI / 2);
    g.font = `bold ${Math.round(w * 0.55)}px system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#f8fafc";
    g.fillText(label, 0, 0);
    g.restore();
  };
  poster(FENCE_W / 2 + 230, 0, 80, c.height, 300, "POSTER");
  poster(FENCE_W / 2 - 300, c.height * 0.3, 70, c.height * 0.4, 190, "SIGN");

  // The slit: cut it out, with a little shadow on the inner edges.
  const sx = FENCE_W / 2 - SLIT_W / 2;
  g.clearRect(sx, 0, SLIT_W, c.height);
  const shadeL = g.createLinearGradient(sx, 0, sx + 10, 0);
  shadeL.addColorStop(0, "rgba(0,0,0,0.55)");
  shadeL.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = shadeL;
  g.fillRect(sx, 0, 10, c.height);
  const shadeR = g.createLinearGradient(sx + SLIT_W, 0, sx + SLIT_W - 10, 0);
  shadeR.addColorStop(0, "rgba(0,0,0,0.55)");
  shadeR.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = shadeR;
  g.fillRect(sx + SLIT_W - 10, 0, 10, c.height);
  return c;
}

function drawNoise(): HTMLCanvasElement {
  const c = makeCanvas(128, 128);
  const g = c.getContext("2d")!;
  const img = g.createImageData(128, 128);
  const rand = rng(3);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rand() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class GapSimulator {
  readonly canvas: HTMLCanvasElement;
  /** -1..1 slide position when controlled manually; null = automatic sweep. */
  manual: number | null = null;
  private lastOccShift = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scene = drawScene();
  private readonly fence = drawFence();
  private readonly noise: CanvasPattern;
  private last: number | null = null;
  /** Simulated seconds. Advances by at most one 30 fps frame per render, so a stalled tab doesn't teleport the camera. */
  private t = 0;

  constructor() {
    this.canvas = makeCanvas(FRAME_W, FRAME_H);
    this.ctx = this.canvas.getContext("2d")!;
    this.noise = this.ctx.createPattern(drawNoise(), "repeat")!;
  }

  render(nowMs: number) {
    const dt = this.last === null ? 0 : Math.min(1 / 30, (nowMs - this.last) / 1000);
    this.last = nowMs;
    this.t += dt;
    const t = this.t;
    const slide = this.manual ?? Math.sin((t / 10) * Math.PI * 2);
    const T = SLIDE_AMPLITUDE * slide;
    // Hand wobble: small turn jitter (moves both layers) and vertical shake.
    const wobble = 6 * Math.sin(t * 2.3) + 3 * Math.sin(t * 5.1);
    const turn = -TURN * K_NEAR * T + wobble;
    const dy = 4 * Math.sin(t * 1.7) + 2 * Math.sin(t * 4.3);
    const occShift = K_NEAR * T + turn;
    const bgShift = K_FAR * T + turn;
    this.lastOccShift = occShift;

    const g = this.ctx;
    g.globalAlpha = 1;
    g.drawImage(this.scene, -(SCENE_W / 2 - FRAME_W / 2 + bgShift), -(SCENE_H / 2 - FRAME_H / 2 + dy));
    g.drawImage(this.fence, -(FENCE_W / 2 - FRAME_W / 2 + occShift), -(40 + dy));

    // Sensor noise
    g.save();
    g.globalAlpha = 0.07;
    g.translate(Math.random() * 128, Math.random() * 128);
    g.fillStyle = this.noise;
    g.fillRect(-128, -128, FRAME_W + 128, FRAME_H + 128);
    g.restore();
  }

  /**
   * A simulated depth sensor for the last rendered frame (larger = nearer,
   * like Depth Anything's output). The demo is a flat drawing, which a real
   * depth model can't judge; the simulator knows its own geometry, so in
   * depth mode the demo uses this instead. The fence and everything on it
   * (the poster, the sign) are near; only the slit shows the far scene.
   */
  depthMap(
    width: number,
    height: number,
    /** Part of the frame (in frame pixels) the depth map should cover, e.g. when zoomed in. */
    crop: { sx: number; sy: number; sw: number; sh: number } = { sx: 0, sy: 0, sw: FRAME_W, sh: FRAME_H },
  ): { data: Float32Array; width: number; height: number } {
    const data = new Float32Array(width * height);
    const slitL = FENCE_W / 2 - SLIT_W / 2;
    const fenceOffset = FENCE_W / 2 - FRAME_W / 2 + this.lastOccShift;
    const cols = new Float32Array(width);
    for (let xd = 0; xd < width; xd++) {
      // Supersample each column for soft, model-like boundaries.
      let far = 0;
      for (const sub of [-0.33, 0, 0.33]) {
        const xf = crop.sx + ((xd + 0.5 + sub) * crop.sw) / width - 0.5 + fenceOffset;
        if (xf >= slitL && xf < slitL + SLIT_W) far += 1 / 3;
      }
      cols[xd] = far;
    }
    for (let yd = 0; yd < height; yd++) {
      for (let xd = 0; xd < width; xd++) {
        const near = 4 + 0.15 * (xd / width) + 0.05 * Math.sin(yd * 0.7 + xd * 1.3);
        const back = 0.7 + 0.25 * (yd / height);
        data[yd * width + xd] = near * (1 - cols[xd]) + back * cols[xd];
      }
    }
    return { data, width, height };
  }
}
