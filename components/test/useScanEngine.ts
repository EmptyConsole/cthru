"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DepthClient, type DepthResult, type DepthStatus } from "@/lib/depth/client";
import { findDepthGaps } from "@/lib/gap/depthGap";
import { GapScanner, rgbaToGray, type DetectorMode } from "@/lib/gap/scanner";
import { GapSimulator } from "@/lib/gap/simulator";
import type { ScannerStatus } from "@/lib/gap/types";
import { depthResultForVis, depthToCanvas, drawOverlay, drawStrip, renderMosaic } from "./draw";
import type { Settings } from "./settings";

export type SourceKind = "none" | "camera" | "demo" | "file" | "image";
export type FacingMode = "user" | "environment";
export type StartResult = "started" | "failed" | "superseded";

/** Longest side of the frame used for the vision maths. */
const ANALYSIS_MAX = 360;
/** Longest side of the colour frame used for the output image is at most ANALYSIS_MAX * this. */
const MAX_COLOR_SCALE = 3;
/** If processing a frame takes longer than this (ms, smoothed), skip every other frame. */
const FRAME_BUDGET_MS = 28;
/**
 * Occluder travel (analysis px) after which a depth-found gap must show parallax to keep recording.
 * Benchmarked on synthetic sweeps: 8 px loses nothing on real openings (sliding or held still) and drops
 * a poster the depth model misreads as far within a sweep, taking back its slices; 15+ px lets more through.
 */
const SLIDE_CHECK_PX = 8;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

type CameraOption = { id: string; label: string };
type PinchGesture = { dist: number; zoom: number; panX: number; panY: number; midX: number; midY: number };
/** Canvases and the video element the UI mounts; created by the caller so render code never reads the engine's refs. */
export interface EngineRefs {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  viewRef: React.RefObject<HTMLCanvasElement | null>;
  overlayRef: React.RefObject<HTMLCanvasElement | null>;
  stripRef: React.RefObject<HTMLCanvasElement | null>;
}

export interface CueTiming {
  searchingFor: number;
  recordingFor: number;
}

/**
 * Safari (every iOS browser is Safari underneath) runs the depth model on the
 * CPU with ONNX Runtime's plain WebAssembly build: its GPU path and the default
 * builds grow memory until iOS kills the tab. `?depth=safe` forces it elsewhere, for testing.
 */
function needsSafeDepth(): boolean {
  if (new URLSearchParams(window.location.search).get("depth") === "safe") return true;
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua);
  return iOS || safari;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
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

/**
 * Everything that drives a scan: the camera / demo / file source, the depth
 * model worker, the per-frame loop, and gestures on the viewfinder. The UI
 * mounts the canvases it returns refs for.
 */
export function useScanEngine(settings: Settings, { videoRef, viewRef, overlayRef, stripRef }: EngineRefs) {
  /** Full-resolution copy of the picture, shared by the live strip and the result screen. */
  const mosaicRef = useRef<HTMLCanvasElement | null>(null);

  const scannerRef = useRef<GapScanner | null>(null);
  const simRef = useRef<GapSimulator | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileUrlRef = useRef<string | null>(null);
  const imageRef = useRef<ImageBitmap | null>(null);
  const depthRef = useRef<DepthClient | null>(null);
  const depthVisRef = useRef<HTMLCanvasElement | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const dragRef = useRef<{ x0: number; x1: number } | null>(null);
  const settingsRef = useRef(settings);
  const detectorRef = useRef<DetectorMode>("depth");
  const mirrorRef = useRef(false);
  const hasMosaicRef = useRef(false);
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
  const [timing, setTiming] = useState<CueTiming>({ searchingFor: 0, recordingFor: Infinity });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aspect, setAspect] = useState(4 / 3);
  const [mirror, setMirrorState] = useState(false);
  const [depthStatus, setDepthStatus] = useState<DepthStatus | null>(null);
  const [torch, setTorch] = useState({ available: false, on: false });
  const [cameras, setCameras] = useState<CameraOption[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [facing, setFacing] = useState<FacingMode>("environment");
  const [zoom, setZoomState] = useState(1);
  const [hasMosaic, setHasMosaic] = useState(false);
  const [frameMs, setFrameMs] = useState(0);
  const [demoPos, setDemoPos] = useState(0);

  // The classic detector runs when it's chosen, or when the depth model can't run.
  const fallback = settings.detector === "auto" && depthStatus?.state === "error";
  const detector: DetectorMode = settings.detector === "edges" || fallback ? "edges" : "depth";
  // The classic detector can't tell a poster from a gap without sliding, so it always waits for parallax.
  const requireParallax = detector === "edges" ? true : settings.requireParallax;

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    detectorRef.current = detector;
    const sc = scannerRef.current;
    if (sc && sc.mode !== detector) {
      sc.mode = detector;
      sc.unlock();
    }
    if (detector === "depth" && source !== "none") depthRef.current?.start(true, needsSafeDepth());
  }, [detector, source]);
  useEffect(() => {
    if (scannerRef.current) scannerRef.current.requireParallax = requireParallax;
  }, [requireParallax]);
  useEffect(() => {
    if (scannerRef.current) scannerRef.current.threshold = settings.threshold;
  }, [settings.threshold]);
  useEffect(() => {
    if (depthRef.current) depthRef.current.longSide = settings.depthSize;
  }, [settings.depthSize]);
  useEffect(() => {
    if (simRef.current) simRef.current.manual = settings.demoAuto ? null : demoPos;
  }, [settings.demoAuto, demoPos, source]);

  // The depth model lives in a worker for the page's lifetime (it takes a while to load).
  useEffect(() => {
    const client = new DepthClient();
    client.longSide = settingsRef.current.depthSize;
    depthRef.current = client;
    client.onStatus = (st) => setDepthStatus({ ...st });
    client.onResult = (r: DepthResult) => {
      const sc = scannerRef.current;
      if (sc && sc.mode === "depth") sc.submitDepth({ frameId: r.frameId, width: r.width, height: r.height, gaps: r.gaps });
      if (settingsRef.current.debug.depthMap) depthVisRef.current = depthToCanvas(r);
    };
    return () => {
      client.dispose();
      depthRef.current = null;
    };
  }, []);

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

  const clearPicture = useCallback(() => {
    hasMosaicRef.current = false;
    setHasMosaic(false);
    const m = mosaicRef.current;
    if (m) m.width = m.height = 0;
    const s = stripRef.current;
    s?.getContext("2d")?.clearRect(0, 0, s.width, s.height);
  }, [stripRef]);

  const stop = useCallback(() => {
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
    liveMirrorRef.current = false;
    clearPicture();
    setStatus(null);
    setNotice(null);
    setTorch({ available: false, on: false });
    setSource("none");
  }, [clearPicture, videoRef]);

  useEffect(() => stop, [stop]);

  const begin = (kind: SourceKind) => {
    setSource(kind);
    setSession((s) => s + 1);
    if (detectorRef.current === "depth") depthRef.current?.start(true, needsSafeDepth());
  };

  const startCamera = async (deviceId?: string, requestedFacing?: FacingMode): Promise<StartResult> => {
    stop();
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't open the camera here. Camera access needs a secure (https) connection.");
      return "failed";
    }
    const facingMode = requestedFacing ?? facingRef.current;
    const gen = cameraGen.current;
    const superseded = (stream: MediaStream) => {
      stream.getTracks().forEach((t) => t.stop());
      if (streamRef.current === stream) streamRef.current = null;
      return "superseded" as const;
    };
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
      if (gen !== cameraGen.current) return superseded(stream);
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      if (gen !== cameraGen.current) return superseded(stream);
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
      if (gen !== cameraGen.current) return superseded(stream);
      const options = devices
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      camerasRef.current = options;
      setCameras(options);
      begin("camera");
      return "started";
    } catch (e) {
      if (gen !== cameraGen.current) return "superseded";
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const name = e instanceof DOMException ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "Camera access was blocked. Allow the camera for this site in your browser's settings, then try again."
          : name === "NotFoundError"
            ? "No camera was found. Try the demo, or open a video instead."
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
    // Some devices ignore facingMode: cycle through the cameras instead.
    const nowId = streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
    if (prevId && nowId === prevId && list.length > 1) {
      const idx = list.findIndex((c) => c.id === prevId);
      const cycle = list[(idx + 1 + list.length) % list.length];
      if (cycle && cycle.id !== nowId) await startCamera(cycle.id, next);
    }
  };

  const startDemo = () => {
    stop();
    setError(null);
    simRef.current = new GapSimulator();
    begin("demo");
  };

  const startFile = async (file: File): Promise<boolean> => {
    stop();
    setError(null);
    if (file.type.startsWith("image/")) {
      try {
        imageRef.current = await createImageBitmap(file);
        begin("image");
        return true;
      } catch {
        setError("Couldn't open that image.");
        return false;
      }
    }
    const url = URL.createObjectURL(file);
    fileUrlRef.current = url;
    const v = videoRef.current!;
    v.src = url;
    v.loop = true;
    try {
      await v.play();
      begin("file");
      return true;
    } catch {
      setError("Couldn't play that video. Try an MP4 or MOV file.");
      return false;
    }
  };

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

  // ---- Main loop ------------------------------------------------------------

  useEffect(() => {
    if (source === "none") return;
    let raf = 0;
    let cancelled = false;
    const analysis = document.createElement("canvas");
    const actx = analysis.getContext("2d", { willReadFrequently: true })!;
    if (!mosaicRef.current) mosaicRef.current = document.createElement("canvas");
    let dimsKey = "";
    let grayBuf: Float32Array | undefined;
    let lastStatusAt = 0;
    let lastMosaicAt = 0;
    let lastVideoTime = -1;
    let lastProcessAt = 0;
    let lastRecordStarts = 0;
    let procMs = 0;
    let skipNext = false;
    let searchingSince = performance.now();
    let recordingSince = -1;

    const tick = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);
      const view = viewRef.current;
      // The viewfinder isn't mounted (e.g. on the result screen): nothing to do.
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
        // Skip duplicate frames (rAF can run faster than the camera), except while reframing.
        if (!cropActiveRef.current && v.currentTime === lastVideoTime && now - lastProcessAt < 100) return;
        lastVideoTime = v.currentTime;
        src = v;
        sw = v.videoWidth;
        sh = v.videoHeight;
      }
      // On slow devices, drop every other frame rather than falling behind.
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
        if (dimsKey && hasMosaicRef.current) setNotice("The camera turned or changed resolution, so the picture started over.");
        dimsKey = key;
        const k = ANALYSIS_MAX / Math.max(sw, sh);
        analysis.width = Math.round(sw * k);
        analysis.height = Math.round(sh * k);
        const s = settingsRef.current;
        const scanner = new GapScanner({
          width: analysis.width,
          height: analysis.height,
          colorScale: Math.min(MAX_COLOR_SCALE, Math.max(1, Math.max(sw, sh) / ANALYSIS_MAX)),
          threshold: s.threshold,
          requireParallax: detectorRef.current === "edges" ? true : s.requireParallax,
          mode: detectorRef.current,
          parallaxAfterSlide: SLIDE_CHECK_PX,
        });
        scannerRef.current = scanner;
        if (process.env.NODE_ENV === "development") (window as unknown as { gapScanner: GapScanner }).gapScanner = scanner;
        lastRecordStarts = 0;
        view.width = scanner.colorWidth;
        view.height = scanner.colorHeight;
        setAspect(sw / sh);
        clearPicture();
      }
      const scanner = scannerRef.current!;
      // The viewfinder may have been remounted (back from the result screen).
      if (view.width !== scanner.colorWidth || view.height !== scanner.colorHeight) {
        view.width = scanner.colorWidth;
        view.height = scanner.colorHeight;
      }

      const vctx = view.getContext("2d")!;
      const mirrorLive = liveMirrorRef.current;
      paintFrame(vctx, src, crop, view.width, view.height, mirrorLive);
      paintFrame(actx, src, crop, analysis.width, analysis.height, mirrorLive);
      // The crop is changing, so don't fold these frames into the picture.
      if (cropActiveRef.current) {
        const ov = overlayRef.current;
        ov?.getContext("2d")?.clearRect(0, 0, ov.width, ov.height);
        return;
      }

      const frame = rgbaToGray(actx.getImageData(0, 0, analysis.width, analysis.height), grayBuf);
      grayBuf = frame.data;
      scanner.processFrame(frame, (a, b) => vctx.getImageData(a, 0, b - a, view.height));
      const debug = settingsRef.current.debug;
      if (scanner.mode === "depth") {
        if (source === "demo" && simRef.current) {
          // The demo is a flat drawing, which a depth model can't judge: use the simulator's own depth.
          if (scanner.frameIndex % 4 === 0) {
            const d = simRef.current.depthMap(224, Math.round((224 * crop.sh) / crop.sw), crop);
            const res = findDepthGaps(d);
            scanner.submitDepth({ frameId: scanner.frameIndex, width: d.width, height: d.height, gaps: res.gaps });
            if (debug.depthMap) depthVisRef.current = depthToCanvas(depthResultForVis(d, res.range));
          }
        } else {
          // The view canvas is exactly the frame the scanner analyses (zoomed, panned, mirrored).
          depthRef.current?.request(view, view.width, view.height, scanner.frameIndex);
        }
      }

      if (scanner.recordStarts > lastRecordStarts) {
        lastRecordStarts = scanner.recordStarts;
        // A short buzz on phones that support it: "recording started".
        navigator.vibrate?.(40);
      }

      const ov = overlayRef.current;
      if (ov) drawOverlay(ov, scanner, { debug, depthVis: depthVisRef.current, drag: dragRef.current });

      if (now - lastMosaicAt > 120 && mosaicRef.current) {
        lastMosaicAt = now;
        const win = renderMosaic(mosaicRef.current, scanner);
        if (win) {
          if (!hasMosaicRef.current) {
            hasMosaicRef.current = true;
            setHasMosaic(true);
          }
          if (stripRef.current) drawStrip(stripRef.current, mosaicRef.current, win, mirrorRef.current);
        }
      }

      procMs += 0.1 * (performance.now() - t0 - procMs);
      skipNext = procMs > FRAME_BUDGET_MS;

      const searching = scanner.phase === "searching" && !scanner.candidate;
      if (!searching) searchingSince = now;
      const rec = scanner.recording && scanner.scanning && scanner.phase === "tracking";
      if (!rec) recordingSince = -1;
      else if (recordingSince < 0) recordingSince = now;

      if (now - lastStatusAt > 150) {
        lastStatusAt = now;
        setStatus(scanner.getStatus());
        setTiming({ searchingFor: now - searchingSince, recordingFor: recordingSince < 0 ? Infinity : now - recordingSince });
        if (debug.stats) setFrameMs(procMs);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [source, session, clearPicture, videoRef, viewRef, overlayRef, stripRef]);

  // ---- Actions --------------------------------------------------------------

  const refreshStatus = () => {
    const sc = scannerRef.current;
    if (sc) setStatus(sc.getStatus());
  };

  /** Record the gap being shown now (searching), or let go and look again (tracking). */
  const lockCandidate = useCallback(() => {
    const sc = scannerRef.current;
    if (!sc || !sc.candidate || sc.phase === "tracking") return;
    sc.setManualGap(sc.candidate);
    sc.setScanning(true);
    setStatus(sc.getStatus());
  }, []);

  const redetect = useCallback(() => {
    const sc = scannerRef.current;
    if (!sc) return;
    sc.unlock();
    sc.setScanning(true);
    setStatus(sc.getStatus());
  }, []);

  const setScanning = useCallback((on: boolean) => {
    const sc = scannerRef.current;
    if (!sc) return;
    sc.setScanning(on);
    setStatus(sc.getStatus());
  }, []);

  const resetImage = useCallback(() => {
    const sc = scannerRef.current;
    if (!sc) return;
    sc.resetMosaic();
    clearPicture();
    setNotice(null);
    setStatus(sc.getStatus());
  }, [clearPicture]);

  const setMirror = useCallback((v: boolean) => {
    mirrorRef.current = v;
    setMirrorState(v);
  }, []);

  /** Brings the picture's full-resolution canvas up to date (e.g. for the result screen). */
  const snapshot = useCallback(() => {
    const sc = scannerRef.current;
    const m = mosaicRef.current;
    if (!sc || !m) return null;
    return renderMosaic(m, sc) ? m : null;
  }, []);

  // ---- Framing (zoom / pan) ---------------------------------------------------

  const commitFraming = useCallback(() => {
    cropActiveRef.current = false;
    if (!framingChangedRef.current) return;
    framingChangedRef.current = false;
    const hadPicture = hasMosaicRef.current;
    scannerRef.current?.resetMosaic();
    clearPicture();
    if (hadPicture) setNotice("The framing changed, so the picture started over.");
  }, [clearPicture]);

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
    setZoomState((prev) => (Math.abs(prev - z) < 0.001 ? prev : z));
  }, []);

  /** One-step zoom change (the zoom button), committed straight away. */
  const setZoom = useCallback(
    (z: number) => {
      applyZoom(z);
      commitFraming();
    },
    [applyZoom, commitFraming],
  );

  // Trackpad pinch arrives as a wheel event with the control key held. A normal scroll still scrolls.
  // Listens on the window, so it keeps working when the viewfinder remounts.
  useEffect(() => {
    if (source === "none") return;
    let timer = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (!overlayRef.current || e.target !== overlayRef.current) return;
      e.preventDefault();
      cropActiveRef.current = true;
      applyZoom(zoomRef.current * (e.deltaY > 0 ? 0.92 : 1.08));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => commitFraming(), 280);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.clearTimeout(timer);
    };
  }, [source, applyZoom, commitFraming, overlayRef]);

  // ---- Gestures on the viewfinder: drag across a gap to pick it, pinch to zoom ----

  const toAnalysisX = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const sc = scannerRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    if (!sc) return 0;
    return ((e.clientX - rect.left) / rect.width) * sc.width - 0.5;
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
      const rect = e.currentTarget.getBoundingClientRect();
      const nextZoom = clamp(pinch.zoom * (dist / pinch.dist), MIN_ZOOM, MAX_ZOOM);
      const dx = rect.width > 0 ? ((pts[0].x + pts[1].x) / 2 - pinch.midX) / rect.width : 0;
      const dy = rect.height > 0 ? ((pts[0].y + pts[1].y) / 2 - pinch.midY) / rect.height : 0;
      // Dragging the picture right moves the crop the other way. A mirrored front camera flips that.
      const m = liveMirrorRef.current ? -1 : 1;
      applyZoom(nextZoom, { x: pinch.panX - (m * dx) / nextZoom, y: pinch.panY - dy / nextZoom });
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
      const sc = scannerRef.current;
      if (d && sc && Math.abs(d.x1 - d.x0) >= 3) {
        sc.setManualGap({ left: d.x0, right: d.x1 });
        sc.setScanning(true);
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

  return {
    pointer: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    source,
    session,
    status,
    timing,
    error,
    notice,
    aspect,
    mirror,
    depthStatus,
    torch,
    cameras,
    cameraId,
    facing,
    zoom,
    hasMosaic,
    frameMs,
    demoPos,
    detector,
    fallback,
    requireParallax,
    startCamera,
    flipCamera,
    startDemo,
    startFile,
    stop,
    toggleTorch,
    lockCandidate,
    redetect,
    setScanning,
    resetImage,
    setMirror,
    setZoom,
    setDemoPos,
    snapshot,
    setError,
    setNotice,
  };
}

export type ScanEngine = ReturnType<typeof useScanEngine>;
