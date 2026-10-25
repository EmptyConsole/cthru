"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { HelpContent } from "./HelpContent";
import { ResultScreen } from "./ResultScreen";
import { ScanScreen } from "./ScanScreen";
import { SettingsPanel } from "./SettingsPanel";
import { StartScreen } from "./StartScreen";
import { DEFAULT_SETTINGS, loadSettings, loadTheme, saveSettings, saveTheme, type Settings, type ThemeMode } from "./settings";
import { Sheet } from "./ui";
import { useScanEngine } from "./useScanEngine";

type Screen = "start" | "scan" | "result";
type Overlay = "settings" | "help" | null;
/** What each browser history entry we push holds, so Back steps through the app. */
interface NavState {
  cthru: true;
  idx: number;
  screen: Screen;
  overlay: Overlay;
}

const LG = "(min-width: 1024px)";
function useIsLarge() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(LG);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(LG).matches,
    () => false,
  );
}

export default function ScanApp() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [theme, setTheme] = useState<ThemeMode>("auto");
  const [screen, setScreen] = useState<Screen>("start");
  const [overlay, setOverlay] = useState<Overlay>(null);
  /** The docked settings column on large screens (not part of history). */
  const [sideOpen, setSideOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [picture, setPicture] = useState<HTMLCanvasElement | null>(null);
  const idxRef = useRef(0);
  const screenRef = useRef<Screen>("start");
  const wasScanningRef = useRef(true);
  const large = useIsLarge();
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLCanvasElement>(null);
  const [refs] = useState(() => ({ videoRef, viewRef, overlayRef, stripRef }));
  const engine = useScanEngine(settings, refs);
  const engineRef = useRef(engine);
  useEffect(() => {
    engineRef.current = engine;
  });

  useLayoutEffect(() => {
    // The server render starts on auto; apply the saved theme before paint.
    const t = loadTheme();
    document.documentElement.dataset.theme = t;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(t);
  }, []);
  useEffect(() => {
    // Read saved preferences after mount so server and client render the same HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(loadSettings());
  }, []);

  const changeSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  const changeTheme = (t: ThemeMode) => {
    setTheme(t);
    saveTheme(t);
  };
  const cycleTheme = () => changeTheme(theme === "auto" ? "light" : theme === "light" ? "dark" : "auto");

  // ---- Navigation -------------------------------------------------------------

  /** Moves the app to a screen, doing what leaving and entering it needs. */
  const applyNav = useCallback((next: Screen, nextOverlay: Overlay) => {
    const e = engineRef.current;
    const prev = screenRef.current;
    if (prev !== next) {
      if (next === "start") e.stop();
      if (next === "result") {
        wasScanningRef.current = e.status?.scanning ?? true;
        e.setScanning(false);
        setPicture(e.snapshot());
      }
      if (prev === "result" && next === "scan") e.setScanning(wasScanningRef.current);
      screenRef.current = next;
      setScreen(next);
    }
    setOverlay(nextOverlay);
  }, []);

  const push = useCallback(
    (next: Screen, nextOverlay: Overlay = null) => {
      idxRef.current += 1;
      history.pushState({ cthru: true, idx: idxRef.current, screen: next, overlay: nextOverlay } satisfies NavState, "");
      applyNav(next, nextOverlay);
    },
    [applyNav],
  );

  useEffect(() => {
    history.replaceState({ cthru: true, idx: 0, screen: "start", overlay: null } satisfies NavState, "");
    const onPop = (ev: PopStateEvent) => {
      const st = ev.state as NavState | null;
      if (!st?.cthru) {
        idxRef.current = 0;
        applyNav("start", null);
        return;
      }
      idxRef.current = st.idx;
      // Going Forward into a scan that has already been stopped: there's nothing to show.
      if (st.screen !== "start" && engineRef.current.source === "none") {
        history.replaceState({ ...st, screen: "start", overlay: null } satisfies NavState, "");
        applyNav("start", null);
        return;
      }
      applyNav(st.screen, st.overlay);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyNav]);

  const back = useCallback(() => {
    if (idxRef.current > 0) history.back();
    else applyNav(screenRef.current === "result" ? "scan" : "start", null);
  }, [applyNav]);

  const toStart = () => {
    if (idxRef.current > 0) history.go(-idxRef.current);
    else applyNav("start", null);
  };

  const openOverlay = (o: Exclude<Overlay, null>) => {
    if (o === "settings" && large && screen === "scan") {
      setSideOpen((v) => !v);
      return;
    }
    push(screen, o);
  };

  // ---- Starting a scan ------------------------------------------------------------

  const startCamera = async () => {
    setBusy(true);
    const r = await engine.startCamera(engine.cameraId || undefined);
    setBusy(false);
    if (r === "started") push("scan");
  };
  const startDemo = () => {
    engine.startDemo();
    push("scan");
  };
  const startFile = async (f: File) => {
    if (await engine.startFile(f)) push("scan");
  };

  // `?photo=<url>` opens a photo straight away (handy for checking the detector on a shot).
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get("photo");
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then((r) => r.blob())
      .then(async (b) => {
        if (cancelled) return;
        if (await engineRef.current.startFile(new File([b], "photo", { type: b.type || "image/jpeg" }))) push("scan");
      })
      .catch(() => engineRef.current.setError("Couldn't load the photo from the link."));
    return () => {
      cancelled = true;
    };
  }, [push]);

  // ---- Render ----------------------------------------------------------------------

  const settingsPanel = (
    <SettingsPanel
      settings={settings}
      onChange={changeSettings}
      theme={theme}
      onTheme={changeTheme}
      status={engine.status}
      depthStatus={engine.depthStatus}
      detector={engine.detector}
      fallback={engine.fallback}
      isDemo={engine.source === "demo"}
      cameras={engine.source === "camera" ? engine.cameras : []}
      cameraId={engine.cameraId}
      onCamera={(id) => void engine.startCamera(id)}
    />
  );
  const docked = large && screen === "scan" && sideOpen;

  return (
    <>
      {/* Hidden video element: the camera or file feed is drawn onto the viewfinder canvas. */}
      <video ref={videoRef} muted playsInline autoPlay className="pointer-events-none absolute h-px w-px opacity-0" />

      {screen === "start" && (
        <StartScreen
          error={engine.error}
          busy={busy}
          theme={theme}
          onTheme={cycleTheme}
          onCamera={() => void startCamera()}
          onDemo={startDemo}
          onFile={(f) => void startFile(f)}
          onHelp={() => openOverlay("help")}
        />
      )}

      {screen === "scan" && (
        <ScanScreen
          engine={engine}
          refs={refs}
          settings={settings}
          onSettings={() => openOverlay("settings")}
          onHelp={() => openOverlay("help")}
          onClose={toStart}
          onDone={() => push("result")}
          onDemoAuto={(v) => changeSettings({ demoAuto: v })}
          side={
            docked ? (
              <aside className="hidden w-[380px] shrink-0 border-l border-line bg-surface text-foreground lg:block">
                <Sheet title="Settings" side onClose={() => setSideOpen(false)}>
                  {settingsPanel}
                </Sheet>
              </aside>
            ) : null
          }
        />
      )}

      {screen === "result" && (
        <ResultScreen
          picture={picture}
          mirror={engine.mirror}
          coverage={engine.status?.coverage ?? 0}
          frames={engine.status?.framesUsed ?? 0}
          onMirror={engine.setMirror}
          onBack={back}
          onStartOver={() => {
            engine.resetImage();
            wasScanningRef.current = true;
            back();
          }}
          onFinish={toStart}
        />
      )}

      {overlay === "settings" && (
        <Sheet title="Settings" onClose={back}>
          {settingsPanel}
        </Sheet>
      )}
      {overlay === "help" && (
        <Sheet title="How it works" onClose={back}>
          <HelpContent />
        </Sheet>
      )}
    </>
  );
}
