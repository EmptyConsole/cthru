"use client";

import type { ReactNode } from "react";
import { CueArt } from "./art";
import { pickCue, statusPill, type Cue, type PillTone } from "./cues";
import type { Settings } from "./settings";
import { Icon, HudButton, type IconName } from "./ui";
import type { EngineRefs, ScanEngine } from "./useScanEngine";
import css from "./scan.module.css";

const ZOOM_STEPS = [1, 2, 3];

const PILL: Record<PillTone, string> = {
  idle: "bg-black/55 text-white",
  found: "bg-amber-400 text-amber-950",
  locked: "bg-sky-400 text-sky-950",
  rec: "bg-rose-500 text-white",
  paused: "bg-slate-300 text-slate-900",
};

const CUE_TONE: Record<Cue["tone"], string> = {
  neutral: "bg-black/65 text-white",
  good: "bg-emerald-500/90 text-emerald-950",
  warn: "bg-amber-400/95 text-amber-950",
  bad: "bg-rose-500/95 text-white",
};

export function ScanScreen({
  engine,
  refs,
  settings,
  onSettings,
  onHelp,
  onClose,
  onDone,
  onDemoAuto,
  side,
}: {
  engine: ScanEngine;
  refs: EngineRefs;
  settings: Settings;
  onSettings: () => void;
  onHelp: () => void;
  onClose: () => void;
  onDone: () => void;
  onDemoAuto: (v: boolean) => void;
  /** The docked settings column on large screens, if open. */
  side: ReactNode;
}) {
  const e = engine;
  const { viewRef, overlayRef, stripRef } = refs;
  const st = e.status;
  const isDemo = e.source === "demo";
  const modelLoading = e.detector === "depth" && !isDemo && e.depthStatus?.state === "loading";
  const cue = pickCue({
    status: st,
    isDemo,
    modelLoading,
    modelProgress: e.depthStatus?.progress ?? 0,
    searchingFor: e.timing.searchingFor,
    recordingFor: e.timing.recordingFor,
  });
  const pill = statusPill(st, isDemo);
  const tracking = st?.phase === "tracking";
  const nextZoom = ZOOM_STEPS.find((z) => z > e.zoom + 0.05) ?? 1;

  // The big button does the next useful thing.
  const shutter: { label: string; icon: IconName | "rec"; onClick: () => void; disabled?: boolean; ring: string } = !st
    ? { label: "Starting", icon: "rec", onClick: () => {}, disabled: true, ring: "border-white/40" }
    : !tracking
      ? st.candidate
        ? { label: "Record this gap", icon: "rec", onClick: e.lockCandidate, ring: "border-amber-300" }
        : { label: "Finding a gap…", icon: "rec", onClick: () => {}, disabled: true, ring: "border-white/40" }
      : st.scanning
        ? { label: "Pause", icon: "pause", onClick: () => e.setScanning(false), ring: st.recording ? "border-rose-500" : "border-white" }
        : { label: "Resume", icon: "rec", onClick: () => e.setScanning(true), ring: "border-white" };

  return (
    <div className="fixed inset-0 z-30 flex bg-neutral-950 text-white">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <div
          className="flex items-center justify-between gap-2 px-3 pb-2"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <HudButton onClick={onClose} label="Stop scanning" icon="close" />
          <span
            role="status"
            aria-live="polite"
            className={`flex min-w-0 items-center gap-2 truncate rounded-full px-3.5 py-2 text-sm font-semibold shadow ${PILL[pill.tone]}`}
          >
            {pill.tone === "rec" && <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-white" />}
            <span className="truncate">{pill.label}</span>
            {st && (st.phase === "tracking" || st.candidate) && (
              <span className="shrink-0 tabular-nums opacity-80">{Math.round(st.quality * 100)}%</span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <HudButton onClick={onHelp} label="How it works" icon="help" />
            <HudButton onClick={onSettings} label="Settings" icon="gear" />
          </div>
        </div>

        {/* Viewfinder */}
        <div className="relative min-h-0 flex-1" style={{ containerType: "size" }}>
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden bg-black sm:rounded-2xl"
            style={{ aspectRatio: `${e.aspect}`, width: `min(100cqw, calc(100cqh * ${e.aspect}))` }}
          >
            <canvas ref={viewRef} className="absolute inset-0 h-full w-full" />
            <canvas
              ref={overlayRef}
              aria-label="Camera view. Drag across a gap to pick it. Pinch to zoom."
              className="absolute inset-0 z-10 h-full w-full cursor-crosshair"
              style={{ touchAction: "none" }}
              {...e.pointer}
            />
          </div>

          {/* Camera tools */}
          <div className="absolute top-2 right-3 z-20 flex flex-col items-end gap-2">
            {e.source === "camera" && (
              <HudButton
                onClick={() => void e.flipCamera()}
                label={e.facing === "user" ? "Switch to the back camera" : "Switch to the front camera"}
                icon="flip"
              />
            )}
            {e.torch.available && (
              <HudButton onClick={() => void e.toggleTorch()} label={e.torch.on ? "Turn the torch off" : "Turn the torch on"} icon="torch" active={e.torch.on} />
            )}
            <HudButton onClick={() => e.setZoom(nextZoom)} label={`Zoom: ${e.zoom.toFixed(1)}×. Change to ${nextZoom}×`}>
              <span className="tabular-nums">{e.zoom < 1.05 ? "1" : e.zoom.toFixed(1).replace(/\.0$/, "")}×</span>
            </HudButton>
          </div>

          {settings.debug.stats && st && <DebugStats engine={e} />}

          {e.notice && (
            <button
              type="button"
              onClick={() => e.setNotice(null)}
              className={`${css.rise} absolute top-2 right-16 left-3 z-20 mx-auto max-w-md rounded-2xl bg-sky-500/95 px-4 py-2.5 text-left text-sm font-medium text-sky-950 shadow-lg`}
            >
              {e.notice} <span className="opacity-70">Tap to dismiss.</span>
            </button>
          )}
          {e.fallback && !e.notice && (
            <p className="absolute top-2 right-16 left-3 z-20 mx-auto max-w-md rounded-2xl bg-black/65 px-4 py-2.5 text-sm text-white shadow-lg">
              The AI model couldn&apos;t start, so cthru is using its backup detector. Slide sideways to confirm each gap.
            </p>
          )}

          {cue && (
            <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
              <div
                key={cue.id}
                className={`${css.rise} flex max-w-md items-center gap-3 rounded-2xl px-4 py-3 shadow-xl backdrop-blur-md ${CUE_TONE[cue.tone]}`}
              >
                <CueArt anim={cue.anim} progress={cue.progress} />
                <div className="min-w-0">
                  <p className="text-base leading-tight font-bold">{cue.title}</p>
                  {cue.detail && <p className="mt-0.5 text-sm leading-snug opacity-90">{cue.detail}</p>}
                  {cue.id === "locking" && cue.progress !== undefined && (
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/20">
                      <div className="h-full bg-emerald-950/70 transition-[width]" style={{ width: `${cue.progress * 100}%` }} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Live picture */}
        <div className="px-3 pt-3">
          <div className="relative h-16 overflow-hidden rounded-xl bg-[repeating-conic-gradient(#262626_0%_25%,#171717_0%_50%)] bg-[length:16px_16px] ring-1 ring-white/10">
            <canvas ref={stripRef} className={`absolute inset-0 h-full w-full ${e.hasMosaic ? "" : "invisible"}`} />
            {e.hasMosaic ? (
              <>
                <button type="button" onClick={onDone} aria-label="Open the picture" className="absolute inset-0" />
                <button
                  type="button"
                  onClick={e.resetImage}
                  className="absolute top-1 right-1 rounded-lg bg-black/60 px-2 py-1 text-xs font-semibold text-white hover:bg-black/80"
                >
                  Clear
                </button>
              </>
            ) : (
              <p className="flex h-full items-center justify-center px-4 text-center text-xs text-white/55">
                Your picture builds up here as you slide
              </p>
            )}
          </div>
        </div>

        {isDemo && (
          <div className="flex items-center gap-3 px-4 pt-3 text-sm text-white/80">
            <label className="flex shrink-0 items-center gap-2">
              <input type="checkbox" checked={settings.demoAuto} onChange={(ev) => onDemoAuto(ev.target.checked)} className="h-4 w-4 accent-emerald-400" />
              Auto-slide
            </label>
            {!settings.demoAuto && (
              <input
                type="range"
                aria-label="Slide the virtual camera"
                min={-1}
                max={1}
                step={0.005}
                value={e.demoPos}
                onChange={(ev) => e.setDemoPos(Number(ev.target.value))}
                className="h-8 min-w-0 flex-1 accent-emerald-400"
              />
            )}
          </div>
        )}

        {/* Controls */}
        <div
          className="grid grid-cols-3 items-center px-4 pt-3"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <SideAction icon="refresh" label="Re-detect" onClick={e.redetect} disabled={!tracking} />
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={shutter.onClick}
              disabled={shutter.disabled}
              aria-label={shutter.label}
              className={`flex h-[72px] w-[72px] touch-manipulation items-center justify-center rounded-full border-4 transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white ${shutter.ring}`}
            >
              {shutter.icon === "rec" ? (
                <span className={`h-12 w-12 rounded-full ${shutter.disabled ? "bg-white/40" : "bg-rose-500"}`} />
              ) : (
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-neutral-950">
                  <Icon name={shutter.icon} className="h-6 w-6" />
                </span>
              )}
            </button>
            <span className="text-xs font-medium text-white/75">{shutter.label}</span>
          </div>
          <SideAction icon="check" label="Done" onClick={onDone} disabled={!e.hasMosaic} emphasis />
        </div>
      </div>
      {side}
    </div>
  );
}

function SideAction({
  icon,
  label,
  onClick,
  disabled,
  emphasis,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-14 touch-manipulation flex-col items-center justify-center gap-1 justify-self-center rounded-2xl px-3 text-xs font-medium text-white/80 transition-opacity disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
    >
      <span
        className={`flex h-11 w-11 items-center justify-center rounded-full ${
          emphasis && !disabled ? "bg-emerald-400 text-emerald-950" : "bg-white/12"
        }`}
      >
        <Icon name={icon} />
      </span>
      {label}
    </button>
  );
}

function DebugStats({ engine: e }: { engine: ScanEngine }) {
  const st = e.status!;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const d = e.depthStatus;
  const rows: [string, string][] = [
    ["Detector", e.detector === "depth" ? "AI depth" : "classic"],
    [e.detector === "depth" ? "Depth score" : "Edge", pct(st.confidence)],
    ["Quality", `${pct(st.quality)} / ${pct(st.threshold)}`],
    ["Parallax", `${st.parallax.toFixed(2)}${st.parallaxConfirmed ? " ✓" : ""}`],
    ["Match", st.matchScore === null ? "–" : pct(Math.max(0, st.matchScore))],
    ["Width", `${st.coverage.toFixed(1)}×`],
    ["Frames", String(st.framesUsed)],
    ["Frame", `${e.frameMs.toFixed(1)} ms`],
  ];
  if (e.detector === "depth" && d?.state === "ready" && e.source !== "demo") {
    rows.push(["Depth", `${d.rate.toFixed(1)}/s · ${Math.round(d.latencyMs)} ms`]);
    rows.push(["Model", `${d.device === "webgpu" ? "GPU" : "CPU"} · ${d.dtype}`]);
  }
  return (
    <dl className="pointer-events-none absolute top-2 left-3 z-20 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 rounded-xl bg-black/65 px-3 py-2 font-mono text-[11px] leading-tight text-white/90">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-white/55">{k}</dt>
          <dd className="tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
