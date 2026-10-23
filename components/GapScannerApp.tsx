"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DepthClient, type DepthResult, type DepthStatus } from "@/lib/depth/client";
import { scanningCoach } from "@/lib/gap/coach";
import { findDepthGaps } from "@/lib/gap/depthGap";
import { DEFAULT_THRESHOLD, GapScanner, rgbaToGray, type DetectorMode } from "@/lib/gap/scanner";
import { GapSimulator } from "@/lib/gap/simulator";
import type { Gap, ScannerStatus } from "@/lib/gap/types";

type SourceKind = "none" | "camera" | "demo" | "file" | "image";
type ThemeMode = "light" | "dark" | "auto";
type FacingMode = "user" | "environment";

/** Longest side of the frame used for the vision maths. */
const ANALYSIS_MAX = 360;
/** Longest side of the colour frame used for the output image is at most ANALYSIS_MAX * this. */
const MAX_COLOR_SCALE = 3;
/** If processing a frame takes longer than this (ms, smoothed), skip every other frame. */
const FRAME_BUDGET_MS = 28;
const THRESHOLD_KEY = "seethroughgap.threshold";
// v2: with depth detection, the parallax check is an optional extra and defaults to off.
const PARALLAX_KEY = "seethroughgap.requireParallax.v2";
const DETECTOR_KEY = "seethroughgap.detector";
const DEPTH_SIZE_KEY = "seethroughgap.depthSize";
/** Longest side of the image given to the depth model: speed vs detail. */
const DEPTH_SIZES = [
  { value: 252, label: "Fast" },
  { value: 336, label: "Balanced" },
  { value: 448, label: "Detailed" },
] as const;
const THEME_KEY = "seethroughgap.theme";
const ZOOM_KEY = "seethroughgap.zoom";
/** Set while the camera was the last source chosen, so the next visit starts it straight away. */
const CAMERA_KEY = "seethroughgap.autoCamera";
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

type TorchState = { available: boolean; on: boolean };
type CameraOption = { id: string; label: string };
type PinchGesture = {
  dist: number;
  zoom: number;
  panX: number;
  panY: number;
  midX: number;
  midY: number;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function loadThreshold(): number {
  try {
    const v = Number(localStorage.getItem(THRESHOLD_KEY));
    if (v >= 0.1 && v <= 0.95) return v;
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
  return DEFAULT_THRESHOLD;
}

function saveThreshold(v: number) {
  try {
    localStorage.setItem(THRESHOLD_KEY, String(v));
  } catch {
    // Not critical.
  }
}

function loadSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not critical.
  }
}

function clearSetting(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Not critical.
  }
}

function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    // Storage can be unavailable.
  }
  return "auto";
}

function saveTheme(v: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, v);
  } catch {
    // Not critical.
  }
}

function applyTheme(v: ThemeMode) {
  document.documentElement.dataset.theme = v;
}

function loadZoom(): number {
  try {
    const v = Number(localStorage.getItem(ZOOM_KEY));
    if (v >= MIN_ZOOM && v <= MAX_ZOOM) return v;
  } catch {
    // Storage can be unavailable.
  }
  return 1;
}

function saveZoom(v: number) {
  try {
    localStorage.setItem(ZOOM_KEY, String(v));
  } catch {
    // Not critical.
  }
}

/** Source rectangle for the current zoom and pan. Writes the clamped centre back into `pan`. */
function frameCrop(fullW: number, fullH: number, zoom: number, pan: { x: number; y: number }) {
  const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const sw = fullW / z;
  const sh = fullH / z;
  const sx = clamp(pan.x * fullW - sw / 2, 0, Math.max(0, fullW - sw));
  const sy = clamp(pan.y * fullH - sh / 2, 0, Math.max(0, fullH - sh));
  if (fullW > 0) pan.x = (sx + sw / 2) / fullW;
  if (fullH > 0) pan.y = (sy + sh / 2) / fullH;
  return { sx, sy, sw, sh };
}

function paintFrame(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  crop: { sx: number; sy: number; sw: number; sh: number },
  dw: number,
  dh: number,
  mirrorLive: boolean,
) {
  ctx.save();
  if (mirrorLive) {
    ctx.translate(dw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(src, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, dw, dh);
  ctx.restore();
}

function inferFacing(track: MediaStreamTrack, requested: FacingMode): FacingMode {
  const mode = track.getSettings().facingMode;
  if (mode === "user" || mode === "environment") return mode;
  const label = track.label.toLowerCase();
  if (/front|user|face/.test(label)) return "user";
  if (/back|rear|environment/.test(label)) return "environment";
  return requested;
}

export default function GapScannerApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const mosaicRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const mosaicScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scannerRef = useRef<GapScanner | null>(null);
  const simRef = useRef<GapSimulator | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileUrlRef = useRef<string | null>(null);
  const imageRef = useRef<ImageBitmap | null>(null);
  const depthRef = useRef<DepthClient | null>(null);
  /** Latest depth map for the overlay. */
  const depthVisRef = useRef<{ canvas: HTMLCanvasElement; frameId: number } | null>(null);
  const detectorRef = useRef<DetectorMode>("depth");
  const showDepthRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const dragRef = useRef<{ x0: number; x1: number } | null>(null);
  const debugRef = useRef(false);
  const mirrorRef = useRef(false);
  const thresholdRef = useRef(DEFAULT_THRESHOLD);
  const requireParallaxRef = useRef(false);
  const hasMosaicRef = useRef(false);
  const userScrolledAt = useRef(0);
  const facingRef = useRef<FacingMode>("environment");
  const liveMirrorRef = useRef(false);
  const camerasRef = useRef<CameraOption[]>([]);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0.5, y: 0.5 });
  const cropActiveRef = useRef(false);
  const framingChangedRef = useRef(false);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<PinchGesture | null>(null);
  const gestureRef = useRef<"none" | "drag" | "pinch">("none");
  const cameraGen = useRef(0);

  const [source, setSource] = useState<SourceKind>("none");
  const [session, setSession] = useState(0);
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aspect, setAspect] = useState(4 / 3);
  const [mirror, setMirror] = useState(false);
  const [debug, setDebug] = useState(false);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [requireParallax, setRequireParallax] = useState(false);
  const [detector, setDetector] = useState<DetectorMode>("depth");
  const [depthSize, setDepthSize] = useState<number>(336);
  const [depthStatus, setDepthStatus] = useState<DepthStatus | null>(null);
  const [showDepth, setShowDepth] = useState(false);
  const [torch, setTorch] = useState<TorchState>({ available: false, on: false });
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState<string>("");
  const [hasMosaic, setHasMosaic] = useState(false);
  const [demoAuto, setDemoAuto] = useState(true);
  const [demoPos, setDemoPos] = useState(0);
  const [frameMs, setFrameMs] = useState(0);
  const [theme, setTheme] = useState<ThemeMode>("auto");
  const [facing, setFacing] = useState<FacingMode>("environment");
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    // Apply the saved theme before paint. The server render always starts on auto.
    const mode = loadTheme();
    applyTheme(mode);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(mode);
  }, []);
  useEffect(() => {
    // Read saved preferences after mount so server and client render the same HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThreshold(loadThreshold());
    setRequireParallax(loadSetting(PARALLAX_KEY) === "true");
    const d = loadSetting(DETECTOR_KEY);
    if (d === "depth" || d === "edges") setDetector(d);
    const size = Number(loadSetting(DEPTH_SIZE_KEY));
    if (DEPTH_SIZES.some((o) => o.value === size)) setDepthSize(size);
    const z = loadZoom();
    zoomRef.current = z;
    setZoom(z);
  }, []);
  useEffect(() => {
    detectorRef.current = detector;
    const sc = scannerRef.current;
    if (sc && sc.mode !== detector) {
      sc.mode = detector;
      sc.unlock();
    }
    if (detector === "depth" && source !== "none") depthRef.current?.start();
  }, [detector, source]);
  useEffect(() => {
    if (depthRef.current) depthRef.current.longSide = depthSize;
  }, [depthSize]);
  useEffect(() => {
    showDepthRef.current = showDepth;
  }, [showDepth]);

  // The depth model lives in a worker for the page's lifetime (it takes a while to load).
  useEffect(() => {
    const client = new DepthClient();
    depthRef.current = client;
    client.onStatus = (st) => setDepthStatus({ ...st });
    client.onResult = (r: DepthResult) => {
      const sc = scannerRef.current;
      if (sc && sc.mode === "depth") {
        sc.submitDepth({ frameId: r.frameId, width: r.width, height: r.height, gaps: r.gaps });
      }
      if (showDepthRef.current) depthVisRef.current = { canvas: depthToCanvas(r), frameId: r.frameId };
    };
    return () => {
      client.dispose();
      depthRef.current = null;
    };
  }, []);
  useEffect(() => {
    requireParallaxRef.current = requireParallax;
    if (scannerRef.current) scannerRef.current.requireParallax = requireParallax;
  }, [requireParallax]);
  useEffect(() => {
    thresholdRef.current = threshold;
    if (scannerRef.current) scannerRef.current.threshold = threshold;
  }, [threshold]);
  useEffect(() => {
    debugRef.current = debug;
  }, [debug]);
  useEffect(() => {
    mirrorRef.current = mirror;
  }, [mirror]);
  useEffect(() => {
    camerasRef.current = cameras;
  }, [cameras]);
  useEffect(() => {
    if (simRef.current) simRef.current.manual = demoAuto ? null : demoPos;
  }, [demoAuto, demoPos, source]);

  // Keep the phone screen awake while scanning.
  useEffect(() => {
    if (source === "none" || !("wakeLock" in navigator)) return;
    let released = false;
    const acquire = async () => {
      try {
        if (document.visibilityState === "visible" && !wakeLockRef.current) {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
          wakeLockRef.current.addEventListener("release", () => (wakeLockRef.current = null));
          if (released) void wakeLockRef.current.release();
        }
      } catch {
        // Not allowed (e.g. low battery mode); scanning still works.
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", acquire);
      void wakeLockRef.current?.release();
      wakeLockRef.current = null;
    };
  }, [source]);

  // ---- Sources ------------------------------------------------------------

  const stopSource = useCallback(() => {
    cameraGen.current += 1;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.srcObject = null;
      v.removeAttribute("src");
      v.load();
    }
    if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
    fileUrlRef.current = null;
    imageRef.current?.close();
    imageRef.current = null;
    depthVisRef.current = null;
    simRef.current = null;
    scannerRef.current = null;
    hasMosaicRef.current = false;
    liveMirrorRef.current = false;
    setHasMosaic(false);
    setStatus(null);
    setNotice(null);
    setTorch({ available: false, on: false });
    setSource("none");
  }, []);

  useEffect(() => stopSource, [stopSource]);

  const begin = (kind: SourceKind) => {
    setSource(kind);
    setSession((s) => s + 1);
    if (detectorRef.current === "depth") depthRef.current?.start();
  };

  /** "superseded" means another source was chosen while the camera was starting. */
  const startCamera = async (
    deviceId?: string,
    requestedFacing?: FacingMode,
  ): Promise<"started" | "failed" | "superseded"> => {
    stopSource();
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't open the camera here. Camera access needs HTTPS (or localhost).");
      return "failed";
    }
    const facingMode = requestedFacing ?? facingRef.current;
    const gen = cameraGen.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facingMode } }),
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      if (gen !== cameraGen.current) {
        stream.getTracks().forEach((t) => t.stop());
        return "superseded";
      }
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      if (gen !== cameraGen.current) {
        stream.getTracks().forEach((t) => t.stop());
        if (streamRef.current === stream) streamRef.current = null;
        return "superseded";
      }
      const track = stream.getVideoTracks()[0];
      const actual = inferFacing(track, facingMode);
      facingRef.current = actual;
      liveMirrorRef.current = actual === "user";
      setFacing(actual);
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorch({ available: !!caps.torch, on: false });
      setCameraId(track.getSettings().deviceId ?? "");
      // Labels are only available once permission has been granted.
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (gen !== cameraGen.current) {
        stream.getTracks().forEach((t) => t.stop());
        if (streamRef.current === stream) streamRef.current = null;
        return "superseded";
      }
      const options = devices
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      camerasRef.current = options;
      setCameras(options);
      begin("camera");
      saveSetting(CAMERA_KEY, track.getSettings().deviceId ?? "");
      return "started";
    } catch (e) {
      if (gen !== cameraGen.current) return "superseded";
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const name = e instanceof DOMException ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "Camera permission was denied. Allow camera access for this site and try again."
          : name === "NotFoundError"
            ? "No camera was found. Try the demo or open a video instead."
            : `Couldn't start the camera${e instanceof Error ? `: ${e.message}` : "."}`,
      );
      return "failed";
    }
  };

  const flipCamera = async () => {
    const prevId = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
    const next: FacingMode = facingRef.current === "user" ? "environment" : "user";
    const list = camerasRef.current;
    await startCamera(undefined, next);
    const nowId = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
    if (prevId && nowId === prevId && list.length > 1) {
      const idx = list.findIndex((c) => c.id === prevId);
      const cycle = list[(idx + 1 + list.length) % list.length];
      if (cycle && cycle.id !== nowId) await startCamera(cycle.id, next);
    }
  };

  /** The user picked something other than the camera, so don't start it on the next visit. */
  const stopByUser = () => {
    clearSetting(CAMERA_KEY);
    stopSource();
  };

  const startDemo = () => {
    clearSetting(CAMERA_KEY);
    stopSource();
    setError(null);
    simRef.current = new GapSimulator();
    begin("demo");
  };

  const startFile = async (file: File) => {
    clearSetting(CAMERA_KEY);
    stopSource();
    setError(null);
    if (file.type.startsWith("image/")) {
      // A still photo: handy for checking what the detector finds in a shot.
      try {
        imageRef.current = await createImageBitmap(file);
        begin("image");
      } catch {
        setError("Couldn't open that image.");
      }
      return;
    }
    const url = URL.createObjectURL(file);
    fileUrlRef.current = url;
    const v = videoRef.current!;
    v.src = url;
    v.loop = true;
    try {
      await v.play();
      begin("file");
    } catch {
      setError("Couldn't play that video file.");
    }
  };

  // `?photo=<url>` opens a still photo straight away (handy for testing the detector on a shot).
  // Otherwise, if the camera was the last source used, start it again.
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get("photo");
    if (!url) {
      const savedId = loadSetting(CAMERA_KEY);
      if (savedId === null) return;
      let cancelled = false;
      void (async () => {
        try {
          // Don't pop up a fresh error if the site's camera permission was revoked.
          const perm = await navigator.permissions?.query({ name: "camera" as PermissionName });
          if (perm?.state === "denied") return;
        } catch {
          // The camera permission can't be queried in every browser; just try.
        }
        if (cancelled) return;
        // The saved camera may be gone (unplugged, IDs reset); fall back to the default one.
        if ((await startCamera(savedId || undefined)) === "failed" && savedId && !cancelled) await startCamera();
      })();
      return () => {
        cancelled = true;
      };
    }
    fetch(url)
      .then((r) => r.blob())
      .then((b) => startFile(new File([b], "photo", { type: b.type || "image/jpeg" })))
      .catch(() => setError("Couldn't load the photo from the URL."));
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const on = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      setTorch({ available: true, on });
    } catch {
      setTorch({ available: false, on: false });
    }
  };

  // ---- Drawing --------------------------------------------------------------

  const drawOverlay = useCallback((scanner: GapScanner) => {
    const ov = overlayRef.current;
    if (!ov) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(ov.clientWidth * dpr);
    const ch = Math.round(ov.clientHeight * dpr);
    if (ov.width !== cw || ov.height !== ch) {
      ov.width = cw;
      ov.height = ch;
    }
    const g = ov.getContext("2d")!;
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

    // What the depth model sees (from a slightly older frame).
    const vis = depthVisRef.current;
    if (showDepthRef.current && vis) {
      g.globalAlpha = 0.6;
      g.drawImage(vis.canvas, 0, 0, cw, ch);
      g.globalAlpha = 1;
    }

    // Every gap candidate in the latest depth result, with its quality.
    if (scanner.mode === "depth") {
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
      const awaiting = scanner.requireParallax && !scanner.parallaxConfirmed && !live;
      const color = !scanner.scanning ? "#94a3b8" : live ? "#34d399" : awaiting ? "#38bdf8" : "#fbbf24";
      // Darken everything outside the gap.
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(0, 0, b.L, ch);
      g.fillRect(b.R, 0, cw - b.R, ch);
      g.fillRect(b.L, 0, b.R - b.L, b.T);
      g.fillRect(b.L, b.B, b.R - b.L, ch - b.B);
      if (scanner.lastStrip && live) {
        const [r0, r1] = scanner.lastStripRows ?? [0, scanner.height];
        g.fillStyle = "rgba(52,211,153,0.14)";
        g.fillRect(
          X(scanner.lastStrip[0] - 1),
          Y(r0 - 1),
          X(scanner.lastStrip[1] - 1) - X(scanner.lastStrip[0] - 1),
          Y(r1 - 1) - Y(r0 - 1),
        );
      }
      g.strokeStyle = color;
      g.lineWidth = 2.5 * dpr;
      g.setLineDash(live ? [] : [10 * dpr, 6 * dpr]);
      g.strokeRect(b.L, b.T, b.R - b.L, b.B - b.T);
      g.setLineDash([]);
    } else if (scanner.candidate) {
      const st = scanner.getStatus();
      const good = st.quality >= st.threshold;
      const b = box(scanner.candidate);
      g.fillStyle = good ? "rgba(251,191,36,0.14)" : "rgba(251,146,60,0.08)";
      g.fillRect(b.L, b.T, b.R - b.L, b.B - b.T);
      g.strokeStyle = good ? "#fbbf24" : "#fb923c";
      g.lineWidth = 2 * dpr;
      g.setLineDash([8 * dpr, 6 * dpr]);
      g.strokeRect(b.L, b.T, b.R - b.L, b.B - b.T);
      g.setLineDash([]);
      g.fillStyle = "#fbbf24";
      g.fillRect(b.L, b.B - 6 * dpr, (b.R - b.L) * st.lockProgress, 6 * dpr);
    }

    const drag = dragRef.current;
    if (drag) {
      const a = X(Math.min(drag.x0, drag.x1));
      const b = X(Math.max(drag.x0, drag.x1));
      g.fillStyle = "rgba(96,165,250,0.2)";
      g.fillRect(a, 0, b - a, ch);
      g.strokeStyle = "#60a5fa";
      g.lineWidth = 2 * dpr;
      g.strokeRect(a, 1, b - a, ch - 2);
    }

    if (debugRef.current && scanner.lastProfile) {
      const h = ch * 0.25;
      g.fillStyle = "rgba(0,0,0,0.5)";
      g.fillRect(0, ch - h, cw, h);
      const plot = (arr: Float32Array, color: string) => {
        g.strokeStyle = color;
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        for (let x = 0; x < arr.length; x++) {
          const px = X(x);
          const py = ch - Math.min(1, arr[x]) * h;
          if (x === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.stroke();
      };
      // Pink: edge strength. Cyan: parallax evidence (moves differently from the occluder).
      plot(scanner.lastProfile.coherence, "#f472b6");
      plot(scanner.motionMap.evidence, "#22d3ee");
    }
  }, []);

  const renderMosaic = useCallback((scanner: GapScanner) => {
    const c = mosaicRef.current;
    const view = scanner.getMosaicView();
    if (!c || !view) return;
    const { image, window: win } = view;
    if (c.width !== image.width || c.height !== image.height) {
      c.width = image.width;
      c.height = image.height;
    }
    const g = c.getContext("2d")!;
    g.putImageData(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
    if (win) {
      g.strokeStyle = "#34d399";
      g.lineWidth = Math.max(2, image.height / 160);
      g.strokeRect(win.x, g.lineWidth / 2, win.width, image.height - g.lineWidth);
    }
    if (!hasMosaicRef.current) {
      hasMosaicRef.current = true;
      setHasMosaic(true);
    }

    // Small copy of the picture, kept beside the stats so it never covers the camera.
    const mini = miniRef.current;
    if (mini) {
      const dpr = window.devicePixelRatio || 1;
      const mw = Math.round(mini.clientWidth * dpr);
      const mh = Math.round(mini.clientHeight * dpr);
      if (mini.width !== mw || mini.height !== mh) {
        mini.width = mw;
        mini.height = mh;
      }
      const mg = mini.getContext("2d")!;
      mg.clearRect(0, 0, mw, mh);
      const k = Math.min((mw - 8 * dpr) / image.width, (mh - 4 * dpr) / image.height);
      const dw = image.width * k;
      const dh = image.height * k;
      mg.fillStyle = "rgba(0,0,0,0.55)";
      mg.fillRect(0, mh - dh - 4 * dpr, dw + 8 * dpr, dh + 4 * dpr);
      mg.save();
      mg.translate(4 * dpr, mh - dh);
      if (mirrorRef.current) {
        mg.translate(dw, 0);
        mg.scale(-1, 1);
      }
      mg.drawImage(c, 0, 0, dw, dh);
      mg.restore();
    }

    // Keep the current window in view unless the user is scrolling around.
    const sc = mosaicScrollRef.current;
    if (sc && win && performance.now() - userScrolledAt.current > 2500) {
      const scale = c.clientWidth / image.width;
      let center = (win.x + win.width / 2) * scale;
      if (mirrorRef.current) center = c.clientWidth - center;
      const margin = sc.clientWidth * 0.2;
      if (center < sc.scrollLeft + margin || center > sc.scrollLeft + sc.clientWidth - margin) {
        sc.scrollLeft = center - sc.clientWidth / 2;
      }
    }
  }, []);

  // ---- Main loop ------------------------------------------------------------

  useEffect(() => {
    if (source === "none") return;
    let raf = 0;
    let cancelled = false;
    const analysis = document.createElement("canvas");
    const actx = analysis.getContext("2d", { willReadFrequently: true })!;
    let dimsKey = "";
    let grayBuf: Float32Array | undefined;
    let lastStatusAt = 0;
    let lastMosaicAt = 0;
    let lastVideoTime = -1;
    let lastProcessAt = 0;
    let lastRecordStarts = 0;
    let procMs = 0;
    let skipNext = false;

    const tick = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);
      const view = viewRef.current;
      if (!view) return;

      let src: CanvasImageSource;
      let sw: number;
      let sh: number;
      if (source === "demo") {
        const sim = simRef.current;
        if (!sim) return;
        sim.render(now);
        src = sim.canvas;
        sw = sim.canvas.width;
        sh = sim.canvas.height;
      } else if (source === "image") {
        const img = imageRef.current;
        if (!img) return;
        src = img;
        sw = img.width;
        sh = img.height;
      } else {
        const v = videoRef.current;
        if (!v || v.readyState < 2 || !v.videoWidth) return;
        // Skip duplicate frames (rAF can run faster than the camera).
        // While zooming, keep painting even if the camera repeats a frame.
        if (!cropActiveRef.current && v.currentTime === lastVideoTime && now - lastProcessAt < 100) return;
        lastVideoTime = v.currentTime;
        src = v;
        sw = v.videoWidth;
        sh = v.videoHeight;
      }
      // On slow devices, drop every other frame rather than falling behind.
      // Keep drawing while the user is reframing so the crop stays live.
      if (!cropActiveRef.current && skipNext) {
        skipNext = false;
        return;
      }
      lastProcessAt = now;
      const t0 = performance.now();
      const crop = frameCrop(sw, sh, zoomRef.current, panRef.current);
      if (crop.sw < 1 || crop.sh < 1) return;

      const key = `${sw}x${sh}`;
      if (key !== dimsKey || !scannerRef.current) {
        if (dimsKey && hasMosaicRef.current) {
          setNotice("The camera's orientation or resolution changed, so the scan restarted.");
        }
        dimsKey = key;
        const k = ANALYSIS_MAX / Math.max(sw, sh);
        const wa = Math.round(sw * k);
        const ha = Math.round(sh * k);
        const S = Math.min(MAX_COLOR_SCALE, Math.max(1, Math.max(sw, sh) / ANALYSIS_MAX));
        analysis.width = wa;
        analysis.height = ha;
        const scanner = new GapScanner({
          width: wa,
          height: ha,
          colorScale: S,
          threshold: thresholdRef.current,
          requireParallax: requireParallaxRef.current,
          mode: detectorRef.current,
        });
        scannerRef.current = scanner;
        // Handy for inspecting the pipeline from the browser console during development.
        if (process.env.NODE_ENV === "development") (window as unknown as { gapScanner: GapScanner }).gapScanner = scanner;
        lastRecordStarts = 0;
        view.width = scanner.colorWidth;
        view.height = scanner.colorHeight;
        setAspect(sw / sh);
        hasMosaicRef.current = false;
        setHasMosaic(false);
      }
      const scanner = scannerRef.current!;

      const vctx = view.getContext("2d")!;
      const mirrorLive = liveMirrorRef.current;
      paintFrame(vctx, src, crop, view.width, view.height, mirrorLive);
      paintFrame(actx, src, crop, analysis.width, analysis.height, mirrorLive);
      // The crop is changing, so don't fold these frames into the picture.
      if (cropActiveRef.current) {
        const ov = overlayRef.current;
        const og = ov?.getContext("2d");
        if (ov && og) og.clearRect(0, 0, ov.width, ov.height);
        return;
      }

      const frame = rgbaToGray(actx.getImageData(0, 0, analysis.width, analysis.height), grayBuf);
      grayBuf = frame.data;
      scanner.processFrame(frame, (a, b) => vctx.getImageData(a, 0, b - a, view.height));
      if (scanner.mode === "depth") {
        if (source === "demo" && simRef.current) {
          // The demo is a flat drawing, which a depth model can't judge: use the
          // simulator's own (exact) depth instead, a few times a second.
          if (scanner.frameIndex % 4 === 0) {
            // Same crop as the analysed frame (zoom / pan).
            const d = simRef.current.depthMap(224, Math.round((224 * crop.sh) / crop.sw), crop);
            const res = findDepthGaps(d);
            scanner.submitDepth({ frameId: scanner.frameIndex, width: d.width, height: d.height, gaps: res.gaps });
            if (showDepthRef.current) {
              depthVisRef.current = {
                canvas: depthToCanvas(depthResultForVis(d, res.range)),
                frameId: scanner.frameIndex,
              };
            }
          }
        } else {
          // Hand this frame to the depth model if it's free (frames are dropped, not queued).
          // Use the view canvas, not the raw source: it is exactly the frame the
          // scanner analyses (zoomed/panned and, for the front camera, mirrored).
          depthRef.current?.request(view, view.width, view.height, scanner.frameIndex);
        }
      }

      if (scanner.recordStarts > lastRecordStarts) {
        lastRecordStarts = scanner.recordStarts;
        // A short buzz on phones that support it: "recording started".
        navigator.vibrate?.(40);
      }

      drawOverlay(scanner);
      if (now - lastMosaicAt > 120) {
        lastMosaicAt = now;
        renderMosaic(scanner);
      }

      procMs += 0.1 * (performance.now() - t0 - procMs);
      skipNext = procMs > FRAME_BUDGET_MS;

      if (now - lastStatusAt > 150) {
        lastStatusAt = now;
        setStatus(scanner.getStatus());
        if (debugRef.current) setFrameMs(procMs);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [source, session, drawOverlay, renderMosaic]);

  // ---- Actions --------------------------------------------------------------

  const refreshStatus = () => {
    const scanner = scannerRef.current;
    if (scanner) setStatus(scanner.getStatus());
  };

  const clearMosaicView = useCallback(() => {
    hasMosaicRef.current = false;
    setHasMosaic(false);
    for (const c of [mosaicRef.current, miniRef.current]) c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, []);

  const commitFraming = useCallback(() => {
    cropActiveRef.current = false;
    if (!framingChangedRef.current) return;
    framingChangedRef.current = false;
    saveZoom(zoomRef.current);
    const hadPicture = hasMosaicRef.current;
    scannerRef.current?.resetMosaic();
    clearMosaicView();
    if (hadPicture) setNotice("The framing changed, so the picture started over.");
  }, [clearMosaicView]);

  const applyZoom = useCallback((next: number, pan?: { x: number; y: number }) => {
    const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
    let changed = Math.abs(z - zoomRef.current) > 0.001;
    zoomRef.current = z;
    if (z <= 1.001) {
      if (Math.abs(panRef.current.x - 0.5) > 0.001 || Math.abs(panRef.current.y - 0.5) > 0.001) changed = true;
      panRef.current = { x: 0.5, y: 0.5 };
    } else if (pan) {
      const x = clamp(pan.x, 0, 1);
      const y = clamp(pan.y, 0, 1);
      if (Math.abs(x - panRef.current.x) > 0.001 || Math.abs(y - panRef.current.y) > 0.001) changed = true;
      panRef.current = { x, y };
    }
    if (changed) framingChangedRef.current = true;
    setZoom((prev) => (Math.abs(prev - z) < 0.001 ? prev : z));
  }, []);

  useEffect(() => {
    const el = overlayRef.current;
    if (!el || source === "none") return;
    let timer = 0;
    const onWheel = (e: WheelEvent) => {
      // Trackpad pinch arrives as a wheel event with the control key held.
      // A normal scroll should still move the page.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      cropActiveRef.current = true;
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      applyZoom(zoomRef.current * factor);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => commitFraming(), 280);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.clearTimeout(timer);
    };
  }, [source, applyZoom, commitFraming]);

  const toggleLock = useCallback(() => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    if (scanner.phase === "tracking") scanner.unlock();
    else if (scanner.candidate) scanner.setManualGap(scanner.candidate);
    setStatus(scanner.getStatus());
  }, []);

  const togglePause = useCallback(() => {
    const scanner = scannerRef.current;
    if (!scanner || scanner.phase !== "tracking") return;
    scanner.setScanning(!scanner.scanning);
    setStatus(scanner.getStatus());
  }, []);

  const resetImage = useCallback(() => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    scanner.resetMosaic();
    clearMosaicView();
    setNotice(null);
    setStatus(scanner.getStatus());
  }, [clearMosaicView]);

  const download = useCallback(() => {
    const view = scannerRef.current?.getMosaicView();
    if (!view) return;
    const { image } = view;
    const tmp = document.createElement("canvas");
    tmp.width = image.width;
    tmp.height = image.height;
    tmp.getContext("2d")!.putImageData(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
    const out = document.createElement("canvas");
    out.width = image.width;
    out.height = image.height;
    const g = out.getContext("2d")!;
    if (mirrorRef.current) {
      g.translate(out.width, 0);
      g.scale(-1, 1);
    }
    g.drawImage(tmp, 0, 0);
    out.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `gap-scan-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/png");
  }, []);

  const changeRequireParallax = (v: boolean) => {
    requireParallaxRef.current = v;
    if (scannerRef.current) scannerRef.current.requireParallax = v;
    setRequireParallax(v);
    saveSetting(PARALLAX_KEY, String(v));
  };

  const changeDetector = (v: DetectorMode) => {
    setDetector(v);
    saveSetting(DETECTOR_KEY, v);
  };

  const changeDepthSize = (v: number) => {
    setDepthSize(v);
    saveSetting(DEPTH_SIZE_KEY, String(v));
  };

  const changeThreshold = (v: number) => {
    // Update the ref right away so rapid key repeats build on each other.
    thresholdRef.current = v;
    if (scannerRef.current) scannerRef.current.threshold = v;
    setThreshold(v);
    saveThreshold(v);
  };

  const cycleTheme = () => {
    const order: ThemeMode[] = ["auto", "light", "dark"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  };

  // Keyboard shortcuts for computers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, select, textarea, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (k === " " && !t?.closest("button")) {
        e.preventDefault();
        togglePause();
      } else if (k === "r" || k === "l") toggleLock();
      else if (k === "c") resetImage();
      else if (k === "m") setMirror((m) => !m);
      else if (k === "p") changeRequireParallax(!requireParallaxRef.current);
      else if (k === "v") setShowDepth((v) => !v);
      else if (k === "s") download();
      else if (k === "[" || k === "]") {
        const next = Math.round((thresholdRef.current + (k === "]" ? 0.05 : -0.05)) * 100) / 100;
        changeThreshold(Math.min(0.95, Math.max(0.1, next)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause, toggleLock, resetImage, download]);

  // ---- Interaction ----------------------------------------------------------

  const toAnalysisX = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const scanner = scannerRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!scanner) return 0;
    return ((e.clientX - rect.left) / rect.width) * scanner.width - 0.5;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!scannerRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      gestureRef.current = "pinch";
      dragRef.current = null;
      cropActiveRef.current = true;
      const pts = [...pointersRef.current.values()];
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
        zoom: zoomRef.current,
        panX: panRef.current.x,
        panY: panRef.current.y,
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2,
      };
      return;
    }
    gestureRef.current = "drag";
    const x = toAnalysisX(e);
    dragRef.current = { x0: x, x1: x };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gestureRef.current === "pinch" && pointersRef.current.size >= 2 && pinchRef.current) {
      const pts = [...pointersRef.current.values()];
      const pinch = pinchRef.current;
      const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const rect = e.currentTarget.getBoundingClientRect();
      const nextZoom = clamp(pinch.zoom * (dist / pinch.dist), MIN_ZOOM, MAX_ZOOM);
      const dx = rect.width > 0 ? (midX - pinch.midX) / rect.width : 0;
      const dy = rect.height > 0 ? (midY - pinch.midY) / rect.height : 0;
      // Dragging the picture right moves the crop the other way. A mirrored front camera flips that.
      const mirror = liveMirrorRef.current ? -1 : 1;
      applyZoom(nextZoom, {
        x: pinch.panX - (mirror * dx) / nextZoom,
        y: pinch.panY - dy / nextZoom,
      });
      return;
    }
    if (gestureRef.current === "drag" && dragRef.current) dragRef.current.x1 = toAnalysisX(e);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size >= 2) return;
    pinchRef.current = null;
    if (pointersRef.current.size > 0) return;
    const gesture = gestureRef.current;
    gestureRef.current = "none";
    if (gesture === "drag") {
      const d = dragRef.current;
      dragRef.current = null;
      const scanner = scannerRef.current;
      if (d && scanner && Math.abs(d.x1 - d.x0) >= 3) {
        scanner.setManualGap({ left: d.x0, right: d.x1 });
        refreshStatus();
      }
      return;
    }
    dragRef.current = null;
    if (gesture === "pinch") commitFraming();
  };
  const onPointerCancel = () => {
    pointersRef.current.clear();
    pinchRef.current = null;
    dragRef.current = null;
    const gesture = gestureRef.current;
    gestureRef.current = "none";
    if (gesture === "pinch") commitFraming();
    else cropActiveRef.current = false;
  };

  // ---- Render ---------------------------------------------------------------

  const tracking = status?.phase === "tracking";
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const depthMode = detector === "depth";
  const depthLoading = depthMode && depthStatus?.state === "loading";
  const depthFailed = depthMode && depthStatus?.state === "error";
  const hint = depthFailed
    ? "The depth model couldn't start. Switch to the classic detector, or reload to try again."
    : depthLoading && source !== "none"
      ? `Loading the depth model (${Math.round((depthStatus?.progress ?? 0) * 100)}%). It's downloaded once, then cached.`
      : status?.hint;
  // The coach's "Better gap" would mislead while the depth model is still loading.
  const coach = status && source !== "none" && !depthLoading && !depthFailed ? scanningCoach(status) : null;
  const themeLabel =
    theme === "auto" ? "Theme auto. Switch to light." : theme === "light" ? "Theme light. Switch to dark." : "Theme dark. Switch to auto.";

  const chip = !status
    ? null
    : status.phase === "searching"
      ? status.candidate
        ? status.quality >= status.threshold
          ? { label: `Good gap · ${pct(status.quality)}`, cls: "bg-amber-400/90 text-amber-950" }
          : { label: `Gap too weak · ${pct(status.quality)}`, cls: "bg-orange-400/90 text-orange-950" }
        : { label: "Searching for a gap", cls: "bg-amber-400/90 text-amber-950" }
      : !status.scanning
        ? { label: "Paused", cls: "bg-slate-300/90 text-slate-900" }
        : status.recording
          ? source === "demo"
            ? // The demo only simulates a camera, so a red REC badge would suggest something is being filmed.
              { label: "Stitching the demo", cls: "bg-emerald-400/90 text-emerald-950" }
            : { label: status.forced ? "REC · picked by hand" : "REC", cls: "bg-red-500/90 text-white", rec: true }
          : status.awaitingParallax
            ? { label: "Slide sideways to confirm", cls: "bg-sky-400/90 text-sky-950" }
            : { label: "Waiting for a clearer gap", cls: "bg-amber-400/90 text-amber-950" };

  const controls = (
    <>
      <ControlButton onClick={toggleLock} disabled={!status || (!tracking && !status.candidate)} title="R">
        {tracking ? "Re-detect gap" : "Record this gap"}
      </ControlButton>
      <ControlButton onClick={togglePause} disabled={!tracking} title="Space">
        {status?.scanning === false ? "Resume" : "Pause"}
      </ControlButton>
      <ControlButton onClick={resetImage} disabled={!hasMosaic} title="C">
        Clear image
      </ControlButton>
    </>
  );

  return (
    <div
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-4 sm:gap-5 sm:pt-8"
      style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-baseline gap-1.5 sm:gap-2">
            <span className="text-3xl font-bold tracking-tight sm:text-5xl">cthru</span>
            <span className="text-sm font-normal text-faint sm:text-lg">the gap</span>
          </h1>
          <p className="max-w-2xl text-sm text-muted sm:text-base">
            Point your camera at a narrow vertical opening and slide sideways. Once a real gap is detected, each position
            records a slice of what&apos;s behind it into one wide picture.
          </p>
        </div>
        <ThemeButton mode={theme} label={themeLabel} onClick={cycleTheme} />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <SourceButton active={source === "camera"} onClick={() => void startCamera(cameraId || undefined)}>
          Use camera
        </SourceButton>
        <SourceButton active={source === "demo"} onClick={startDemo}>
          Try the demo
        </SourceButton>
        <SourceButton active={source === "file" || source === "image"} onClick={() => fileInputRef.current?.click()}>
          Open a photo or video
        </SourceButton>
        {source === "camera" && cameras.length > 1 && (
          <select
            aria-label="Camera"
            value={cameraId}
            onChange={(e) => void startCamera(e.target.value)}
            className="h-11 max-w-[14rem] rounded-full bg-control px-3 text-sm text-foreground"
          >
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        )}
        {source !== "none" && (
          <button onClick={stopByUser} className="h-11 touch-manipulation rounded-full px-4 text-sm text-faint hover:text-foreground">
            Stop
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void startFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {error && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-foreground">{error}</p>}
      {notice && <p className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm text-foreground">{notice}</p>}

      {/* Hidden video element: the camera/file feed is drawn onto the canvas. */}
      <video ref={videoRef} muted playsInline autoPlay className="pointer-events-none absolute h-px w-px opacity-0" />

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6">
        <section className="flex min-w-0 flex-col gap-2">
          {source !== "none" && (
            <div
              className="mx-auto flex w-full flex-wrap items-center justify-between gap-2"
              style={{ maxWidth: `calc(64dvh * ${aspect})` }}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {chip && (
                  <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${chip.cls}`}>
                    {"rec" in chip && <span className="h-2 w-2 animate-pulse rounded-full bg-white" />}
                    {chip.label}
                  </span>
                )}
                {status?.rotating && (
                  <span className="rounded-full bg-rose-500 px-3 py-1 text-xs font-semibold text-white">
                    Slide, don&apos;t turn
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {status && <QualityMeter quality={status.quality} threshold={status.threshold} compact />}
                {source === "camera" && (
                  <>
                    <HudButton
                      onClick={() => void flipCamera()}
                      label={facing === "user" ? "Switch to back camera" : "Switch to front camera"}
                    >
                      Flip
                    </HudButton>
                    {torch.available && (
                      <HudButton onClick={() => void toggleTorch()} label={torch.on ? "Turn torch off" : "Turn torch on"}>
                        {torch.on ? "Torch off" : "Torch"}
                      </HudButton>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <div className="mx-auto flex w-full items-stretch justify-center gap-2">
            <div
              className="relative min-w-0 flex-1 overflow-hidden rounded-2xl bg-black ring-1 ring-line"
              style={{ aspectRatio: `${aspect}`, maxWidth: `calc(64dvh * ${aspect})` }}
            >
              <canvas ref={viewRef} className="absolute inset-0 h-full w-full" />
              <canvas
                ref={overlayRef}
                className="absolute inset-0 z-10 h-full w-full cursor-crosshair"
                style={{ touchAction: "none" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
              />
              {source === "none" && <EmptyState />}
            </div>
            {source !== "none" && (
              <div className="hidden w-12 shrink-0 flex-col items-center gap-1 sm:flex">
                <span className="text-[10px] font-semibold tabular-nums text-muted">{zoom.toFixed(1)}×</span>
                <ZoomSlider
                  zoom={zoom}
                  vertical
                  onStart={() => {
                    cropActiveRef.current = true;
                  }}
                  onChange={applyZoom}
                  onCommit={commitFraming}
                />
              </div>
            )}
          </div>

          {source !== "none" && (
            <label
              className="mx-auto flex w-full items-center gap-3 sm:hidden"
              style={{ maxWidth: `calc(64dvh * ${aspect})` }}
            >
              <span className="w-12 shrink-0 text-center text-xs font-semibold tabular-nums text-muted">
                {zoom.toFixed(1)}×
              </span>
              <ZoomSlider
                zoom={zoom}
                onStart={() => {
                  cropActiveRef.current = true;
                }}
                onChange={applyZoom}
                onCommit={commitFraming}
              />
            </label>
          )}

          {coach && (
            <p className="text-center">
              <span
                className={`inline-block rounded-full px-4 py-1.5 text-base font-semibold tracking-tight ${
                  coach.id === "stable"
                    ? "bg-sky-400 text-sky-950"
                    : coach.id === "better"
                      ? "bg-orange-400 text-orange-950"
                      : "bg-amber-400 text-amber-950"
                }`}
              >
                {coach.text}
              </span>
            </p>
          )}

          {status && source !== "none" && (
            <div
              className="mx-auto flex w-full flex-col gap-2 sm:flex-row sm:items-center"
              style={{ maxWidth: `calc(64dvh * ${aspect})` }}
            >
              <canvas
                ref={miniRef}
                className={`h-14 w-24 shrink-0 self-start rounded-lg bg-black sm:self-auto ${hasMosaic ? "" : "hidden"}`}
              />
              <dl className="grid min-w-0 flex-1 grid-cols-4 gap-1 rounded-xl bg-surface px-2 py-2 text-center ring-1 ring-line">
                <OverlayStat
                  label={depthMode ? "Depth" : "Edge"}
                  title={depthMode ? "Depth score" : "Edge strength"}
                  value={pct(status.confidence)}
                />
                <OverlayStat label="Match" title="Match with the picture so far" value={status.matchScore === null ? "–" : pct(Math.max(0, status.matchScore))} />
                <OverlayStat label="Width" title="Width revealed" value={`${status.coverage.toFixed(1)}×`} />
                <OverlayStat label="Frames" title="Frames recorded" value={String(status.framesUsed)} />
              </dl>
            </div>
          )}

          {hint && <p className="text-center text-sm text-muted sm:text-base">{hint}</p>}

          {source !== "none" && <div className="flex flex-wrap items-center justify-center gap-2 lg:hidden">{controls}</div>}
        </section>

        <aside className="flex flex-col gap-4">
          <section className="flex flex-col gap-3 rounded-2xl bg-surface p-4 ring-1 ring-line">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-foreground">Gap detector</h2>
              <span className="text-xs text-faint">{depthMode ? "AI depth" : "classic"}</span>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-control p-1 text-sm">
              {(
                [
                  ["depth", "Depth AI"],
                  ["edges", "Classic edges"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => changeDetector(v)}
                  className={`min-h-9 touch-manipulation rounded-md px-2 font-medium transition-colors ${
                    detector === v ? "bg-emerald-400 text-emerald-950" : "text-muted hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {depthMode && (
              <>
                {source === "demo" && (
                  <p className="rounded-md bg-sky-500/10 px-2 py-1.5 text-xs text-info">
                    The demo is a flat drawing, so it uses simulated depth. The camera, photos and videos use the model.
                  </p>
                )}
                <p className="text-xs leading-relaxed text-faint">
                  A depth model (Depth Anything V2) estimates how far away everything is. A gap is a narrow region
                  that&apos;s clearly farther than the surfaces on both sides, so posters, edges and frames on the wall
                  don&apos;t count.
                </p>
                <label className="flex items-center justify-between gap-2 text-sm text-muted">
                  <span>Depth detail</span>
                  <select
                    value={depthSize}
                    onChange={(e) => changeDepthSize(Number(e.target.value))}
                    className="h-9 rounded-md bg-control px-2 text-sm text-foreground"
                  >
                    {DEPTH_SIZES.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label} ({o.value}px)
                      </option>
                    ))}
                  </select>
                </label>
                {depthStatus?.state === "loading" && (
                  <div className="flex flex-col gap-1 text-xs text-muted">
                    <span>Loading model… {Math.round(depthStatus.progress * 100)}%</span>
                    <div className="h-1.5 overflow-hidden rounded-full bg-meter">
                      <div className="h-full bg-sky-400" style={{ width: `${Math.round(depthStatus.progress * 100)}%` }} />
                    </div>
                  </div>
                )}
                {depthStatus?.state === "ready" && (
                  <p className="text-xs tabular-nums text-muted">
                    Model ready on {depthStatus.device === "webgpu" ? "GPU (WebGPU)" : "CPU (WebAssembly)"} ·{" "}
                    {depthStatus.dtype}
                    {source === "demo"
                      ? " · idle during the demo"
                      : ` · ${depthStatus.rate.toFixed(1)} depth maps/s · ${Math.round(depthStatus.latencyMs)} ms each`}
                  </p>
                )}
                {depthFailed && (
                  <div className="flex flex-col gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-danger">
                    <span>Depth model error: {depthStatus?.error}</span>
                    <button onClick={() => changeDetector("edges")} className="self-start rounded bg-red-500/30 px-2 py-1">
                      Use the classic detector
                    </button>
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="checkbox" checked={showDepth} onChange={(e) => setShowDepth(e.target.checked)} />
                  Show depth map <span className="text-xs text-faint">(warm = near, cool = far)</span>
                </label>
              </>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-2xl bg-surface p-4 ring-1 ring-line">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-foreground">Recording trigger</h2>
              <span className="text-xs text-faint">
                {status?.recording ? "recording" : status?.phase === "tracking" ? "waiting" : "searching"}
              </span>
            </div>
            <QualityMeter quality={status?.quality ?? 0} threshold={threshold} />
            <label className="flex flex-col gap-2 text-sm text-muted">
              <span className="flex justify-between">
                <span>Start recording at gap quality</span>
                <span className="font-semibold tabular-nums text-foreground">≥ {pct(threshold)}</span>
              </span>
              <input
                type="range"
                min={0.1}
                max={0.95}
                step={0.05}
                value={threshold}
                onChange={(e) => changeThreshold(Number(e.target.value))}
                className="h-8 w-full touch-manipulation accent-emerald-400"
              />
              <span className="flex justify-between text-xs text-faint">
                <span>Lenient</span>
                <span>Strict</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-muted">
              <input
                type="checkbox"
                className="mt-1"
                checked={requireParallax}
                onChange={(e) => changeRequireParallax(e.target.checked)}
              />
              <span>
                Wait for parallax
                <span className="block text-xs text-faint">
                  {depthMode
                    ? "Optional extra check: also wait until sliding shows the view through the gap shifting against its edges."
                    : "Only record once sliding shows the view through the gap shifting against its edges. This rejects things on the wall that just look like gaps."}
                </span>
              </span>
            </label>
            {status && (status.phase === "tracking" || status.candidate) && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Parallax</span>
                <span
                  className={
                    status.parallaxConfirmed
                      ? "font-semibold text-good"
                      : status.parallaxConf > 0.3 && status.parallax < 0.1
                        ? "font-semibold text-danger"
                        : "text-info"
                  }
                >
                  {status.parallaxConfirmed
                    ? "confirmed: real opening"
                    : status.parallaxConf > 0.3 && status.parallax < 0.1
                      ? "none: probably not a gap"
                      : "not seen yet: slide sideways"}
                </span>
              </div>
            )}
            <p className="text-xs leading-relaxed text-faint">
              {depthMode
                ? "Quality combines how much farther the gap is than both sides, how sharply the depth drops at its edges, how much of the height it spans, and how straight and steady it is."
                : "Quality combines straight, full-height edges, how different the view inside looks and how much detail it has, and (once you slide) whether it moves differently from its surroundings."}{" "}
              Nothing is recorded until a gap clears this bar. Dragging across a gap records it regardless.
            </p>
          </section>

          {source !== "none" && (
            <section className="hidden flex-col gap-3 rounded-2xl bg-surface p-4 ring-1 ring-line lg:flex">
              <div className="grid grid-cols-2 gap-2">{controls}</div>
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
                Show edge graph
              </label>
              {debug && <p className="text-xs tabular-nums text-faint">{frameMs.toFixed(1)} ms/frame</p>}
              <p className="text-xs text-faint">
                Keys: <Kbd>Space</Kbd> pause · <Kbd>R</Kbd> re-detect / record · <Kbd>C</Kbd> clear · <Kbd>[</Kbd>
                <Kbd>]</Kbd> threshold · <Kbd>P</Kbd> parallax · <Kbd>V</Kbd> depth view · <Kbd>M</Kbd> mirror · <Kbd>S</Kbd> save
              </p>
            </section>
          )}

          {source !== "none" && (
            <div className="flex flex-col items-center gap-1 lg:hidden">
              <label className="flex items-center justify-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
                Show edge graph
              </label>
              {debug && <p className="text-xs tabular-nums text-faint">{frameMs.toFixed(1)} ms/frame</p>}
            </div>
          )}

          {source === "demo" && (
            <div className="flex flex-col gap-2 rounded-2xl bg-surface p-4 text-sm ring-1 ring-line">
              <label className="flex items-center gap-2 text-muted">
                <input type="checkbox" checked={demoAuto} onChange={(e) => setDemoAuto(e.target.checked)} />
                Move the virtual camera automatically
              </label>
              {!demoAuto && (
                <label className="flex flex-col gap-1 text-muted">
                  Slide the virtual camera
                  <input
                    type="range"
                    min={-1}
                    max={1}
                    step={0.005}
                    value={demoPos}
                    onChange={(e) => setDemoPos(Number(e.target.value))}
                    className="h-8 touch-manipulation"
                  />
                </label>
              )}
            </div>
          )}
        </aside>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">What&apos;s behind the gap</h2>
          <div className="flex items-center gap-2">
            <label
              className="flex items-center gap-2 text-sm text-muted"
              title="The image already has the scene's real orientation. Flip it only if you need the mirror view."
            >
              <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
              Mirror
            </label>
            <ControlButton onClick={download} disabled={!hasMosaic} title="S">
              Download PNG
            </ControlButton>
          </div>
        </div>
        <div
          ref={mosaicScrollRef}
          className="relative overflow-x-auto rounded-2xl bg-[repeating-conic-gradient(var(--checker-a)_0%_25%,var(--checker-b)_0%_50%)] bg-[length:24px_24px] ring-1 ring-line"
          onPointerDown={() => (userScrolledAt.current = performance.now())}
          onWheel={() => (userScrolledAt.current = performance.now())}
          onTouchMove={() => (userScrolledAt.current = performance.now())}
        >
          <canvas
            ref={mosaicRef}
            className={`block h-[min(42vh,320px)] max-w-none ${hasMosaic ? "" : "hidden"}`}
            style={{ width: "auto", transform: mirror ? "scaleX(-1)" : undefined }}
          />
          {!hasMosaic && (
            <p className="px-4 py-12 text-center text-sm text-faint">
              The picture builds up here once a gap is detected and you slide the device sideways.
            </p>
          )}
        </div>
      </section>

      <HowItWorks />
    </div>
  );
}

function QualityMeter({ quality, threshold, compact }: { quality: number; threshold: number; compact?: boolean }) {
  const good = quality >= threshold;
  return (
    <div
      className={compact ? "flex items-center gap-2 rounded-full bg-surface px-2.5 py-1 text-foreground ring-1 ring-line" : "flex flex-col gap-1.5"}
      role="meter"
      aria-label="Gap quality"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(quality * 100)}
    >
      {!compact && (
        <div className="flex justify-between text-sm">
          <span className="text-muted">Gap quality</span>
          <span className={`font-semibold tabular-nums ${good ? "text-good" : "text-warn"}`}>
            {Math.round(quality * 100)}%
          </span>
        </div>
      )}
      <div className={`relative overflow-hidden rounded-full ${compact ? "h-1.5 w-16 bg-meter sm:w-24" : "h-2.5 w-full bg-meter"}`}>
        <div
          className={`h-full rounded-full transition-[width] duration-150 ${good ? "bg-emerald-400" : "bg-amber-400"}`}
          style={{ width: `${Math.round(quality * 100)}%` }}
        />
        <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${threshold * 100}%` }} />
      </div>
      {compact && <span className="text-[11px] font-semibold tabular-nums text-foreground">{Math.round(quality * 100)}%</span>}
    </div>
  );
}

function SourceButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-11 touch-manipulation rounded-full px-4 text-sm font-medium transition-colors ${
        active ? "bg-emerald-400 text-emerald-950" : "bg-control text-foreground hover:bg-control-hover"
      }`}
    >
      {children}
    </button>
  );
}

function ControlButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ? `Shortcut: ${title}` : undefined}
      className="min-h-11 touch-manipulation rounded-lg bg-control px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-control-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function HudButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-11 touch-manipulation items-center justify-center rounded-full bg-black/55 px-3 text-sm font-semibold text-white shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      {children}
    </button>
  );
}

function ThemeButton({ mode, label, onClick }: { mode: ThemeMode; label: string; onClick: () => void }) {
  const name = mode === "auto" ? "Auto" : mode === "light" ? "Light" : "Dark";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex h-11 shrink-0 touch-manipulation items-center gap-2 rounded-full bg-control px-3 text-sm font-medium text-foreground hover:bg-control-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
    >
      <ThemeIcon mode={mode} />
      {name}
    </button>
  );
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <path
          d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
        <path
          d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" />
    </svg>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded bg-control px-1.5 py-0.5 font-mono text-[11px] text-muted">{children}</kbd>;
}

function ZoomSlider({
  zoom,
  vertical,
  onStart,
  onChange,
  onCommit,
}: {
  zoom: number;
  vertical?: boolean;
  onStart: () => void;
  onChange: (zoom: number) => void;
  onCommit: () => void;
}) {
  return (
    <input
      aria-label="Zoom"
      title="Zoom and crop the scanned area. Pinch to zoom, and drag with two fingers to move."
      type="range"
      min={MIN_ZOOM}
      max={MAX_ZOOM}
      step={0.05}
      value={zoom}
      onPointerDown={onStart}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={onCommit}
      onPointerCancel={onCommit}
      onKeyDown={onStart}
      onKeyUp={onCommit}
      onBlur={onCommit}
      className={
        vertical
          ? "w-11 min-h-28 flex-1 cursor-pointer touch-none accent-emerald-400"
          : "h-11 min-w-0 flex-1 cursor-pointer touch-none accent-emerald-400"
      }
      style={vertical ? { writingMode: "vertical-lr", direction: "rtl" } : undefined}
    />
  );
}

function OverlayStat({ label, value, title }: { label: string; value: string; title: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="truncate text-[10px] font-medium text-faint">{label}</dt>
      <dd className="truncate text-xs font-semibold tabular-nums text-foreground sm:text-sm">{value}</dd>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-surface p-6 text-center">
      <svg viewBox="0 0 120 80" className="h-20 w-28 text-faint" aria-hidden>
        <rect x="8" y="6" width="44" height="68" rx="3" fill="currentColor" />
        <rect x="68" y="6" width="44" height="68" rx="3" fill="currentColor" />
        <rect x="52" y="6" width="16" height="68" fill="#34d399" opacity="0.35" />
      </svg>
      <p className="max-w-xs text-sm text-muted">
        Choose <strong className="text-foreground">Use camera</strong> to scan a real gap, or{" "}
        <strong className="text-foreground">Try the demo</strong> to see a simulated one.
      </p>
    </div>
  );
}

function HowItWorks() {
  return (
    <details className="rounded-2xl bg-surface px-5 py-4 text-sm text-muted ring-1 ring-line">
      <summary className="cursor-pointer select-none font-semibold text-foreground">How it works and tips</summary>
      <div className="mt-4 grid gap-6 md:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-3">
          <p>
            The gap is close to you and the hidden scene is further away. When you slide the device, the near edges move
            across the image faster than the far scene, so the scene slides past the opening and new slices of it come
            into view. <strong>Sliding right reveals what&apos;s further left</strong>, the reverse of a normal panorama.
          </p>
          <p>
            Each slice is placed where its content matches the picture built so far, not in the order you swept. So the
            result keeps the scene&apos;s real left-right orientation, whichever way you move.
          </p>
          <p>
            To find the gap it combines four cues: two straight edges running the full height of the view; a view
            inside that looks different, with a different amount of detail; and, most tellingly, <strong>motion</strong>.
            As you slide, the occluder moves as one piece while the view through a real gap shifts at a different speed
            and keeps revealing new content. A picture frame or book on the wall can look like a gap in a still image,
            but it moves with the wall, so it&apos;s rejected.
          </p>
          <p>
            Recording only starts once the gap&apos;s quality clears your threshold and (with &quot;Wait for
            parallax&quot;) sliding has confirmed it&apos;s a real opening. Raise the threshold if it records things that
            aren&apos;t gaps; lower it for faint, dark or low-contrast gaps.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Hold the device upright so the gap runs straight up the screen.</li>
            <li>Slide sideways at a steady distance. Turning on the spot shows nothing new.</li>
            <li>Move slowly, and sweep back and forth to fill in and clean up the picture.</li>
            <li>If auto-detection picks the wrong thing, drag across the gap in the camera view.</li>
            <li>Use the zoom slider or pinch to scan only part of the frame. Drag with two fingers to move that crop.</li>
            <li>On a phone, Flip switches between the back and front cameras.</li>
            <li>Dark gaps work better with the torch on.</li>
          </ul>
        </div>
        <svg viewBox="0 0 280 200" className="w-full" role="img" aria-label="Top-down diagram: two camera positions looking through a gap see different parts of the scene behind">
          <rect x="10" y="12" width="260" height="16" rx="3" fill="#7c3aed" opacity="0.6" />
          <text x="140" y="24" textAnchor="middle" fontSize="10" fill="#f5f3ff">hidden scene</text>
          <text x="40" y="44" textAnchor="middle" fontSize="10" fill="#c4b5fd">left part</text>
          <text x="240" y="44" textAnchor="middle" fontSize="10" fill="#c4b5fd">right part</text>
          <rect x="10" y="96" width="118" height="10" fill="#a16207" />
          <rect x="152" y="96" width="118" height="10" fill="#a16207" />
          <text x="140" y="122" textAnchor="middle" fontSize="10" fill="currentColor">gap</text>
          <polygon points="128,101 152,101 105,28 58,28" fill="#34d399" opacity="0.15" />
          <polygon points="128,101 152,101 222,28 175,28" fill="#fbbf24" opacity="0.15" />
          <polyline points="200,176 128,101 58,28" fill="none" stroke="#34d399" strokeWidth="1.5" />
          <polyline points="200,176 152,101 105,28" fill="none" stroke="#34d399" strokeWidth="1.5" />
          <polyline points="80,176 128,101 175,28" fill="none" stroke="#fbbf24" strokeWidth="1.5" />
          <polyline points="80,176 152,101 222,28" fill="none" stroke="#fbbf24" strokeWidth="1.5" />
          <circle cx="200" cy="180" r="7" fill="#34d399" />
          <circle cx="80" cy="180" r="7" fill="#fbbf24" />
          <text x="200" y="198" textAnchor="middle" fontSize="10" fill="#34d399">device on the right</text>
          <text x="80" y="198" textAnchor="middle" fontSize="10" fill="#fbbf24">device on the left</text>
        </svg>
      </div>
    </details>
  );
}

/** Shape a raw depth map like a worker result, for the overlay. */
function depthResultForVis(d: { data: Float32Array; width: number; height: number }, range: [number, number]): DepthResult {
  const vis = new Uint8ClampedArray(d.data.length);
  const k = 255 / Math.max(1e-6, range[1] - range[0]);
  for (let i = 0; i < d.data.length; i++) vis[i] = (d.data[i] - range[0]) * k;
  return { type: "result", id: 0, frameId: 0, width: d.width, height: d.height, gaps: [], depth: vis.buffer, inferMs: 0, totalMs: 0 };
}

/** Colour-map a depth result for the overlay: near = warm, far = cool. */
function depthToCanvas(r: DepthResult): HTMLCanvasElement {
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
