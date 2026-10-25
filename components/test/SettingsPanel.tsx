"use client";

import type { DepthStatus } from "@/lib/depth/client";
import type { ScannerStatus } from "@/lib/gap/types";
import { DEPTH_SIZES, MAX_THRESHOLD, MIN_THRESHOLD, SENSITIVITY, sensitivityFor, type Settings, type ThemeMode } from "./settings";
import { Section, Segmented, Toggle } from "./ui";

export function SettingsPanel({
  settings,
  onChange,
  theme,
  onTheme,
  status,
  depthStatus,
  detector,
  fallback,
  isDemo,
  cameras,
  cameraId,
  onCamera,
}: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  theme: ThemeMode;
  onTheme: (t: ThemeMode) => void;
  status: ScannerStatus | null;
  depthStatus: DepthStatus | null;
  detector: "depth" | "edges";
  fallback: boolean;
  isDemo: boolean;
  cameras: { id: string; label: string }[];
  cameraId: string;
  onCamera: (id: string) => void;
}) {
  const preset = sensitivityFor(settings.threshold);
  const size = DEPTH_SIZES.find((o) => o.value === settings.depthSize) ?? DEPTH_SIZES[1];
  const quality = status && (status.phase === "tracking" || status.candidate) ? status.quality : null;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const classic = detector === "edges";

  return (
    <div className="flex flex-col">
      <Section title="When to record">
        <p className="text-sm leading-snug text-muted">
          cthru scores each gap it finds. It records once the score clears the bar you pick here.
        </p>
        <Segmented
          label="Sensitivity"
          value={preset?.id ?? null}
          options={SENSITIVITY.map((o) => ({ value: o.id, label: o.label }))}
          onChange={(id) => onChange({ threshold: SENSITIVITY.find((o) => o.id === id)!.threshold })}
        />
        <p className="text-sm leading-snug text-foreground">{preset ? preset.help : `Custom: records gaps scoring ${pct(settings.threshold)} or more.`}</p>

        <QualityBar quality={quality} threshold={settings.threshold} />

        <details className="group rounded-xl bg-control/60 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-muted select-none group-open:text-foreground">Fine-tune the bar</summary>
          <label className="mt-2 flex flex-col gap-1 text-sm text-muted">
            <span className="flex justify-between">
              <span>Record at a score of</span>
              <span className="font-semibold text-foreground tabular-nums">{pct(settings.threshold)}</span>
            </span>
            <input
              type="range"
              min={MIN_THRESHOLD}
              max={MAX_THRESHOLD}
              step={0.05}
              value={settings.threshold}
              onChange={(e) => onChange({ threshold: Number(e.target.value) })}
              className="h-8 w-full accent-emerald-400"
            />
            <span className="flex justify-between text-xs text-faint">
              <span>More gaps</span>
              <span>Fewer mistakes</span>
            </span>
          </label>
        </details>

        <Toggle
          checked={classic || settings.requireParallax}
          disabled={classic}
          onChange={(v) => onChange({ requireParallax: v })}
          label="Wait for the slide check"
          description={
            classic
              ? "Always on with the backup detector: without it, a poster or picture frame looks just like a gap."
              : "As you slide, cthru checks that the view through the gap moves differently from its edges, which only a real opening does. Normally it records straight away and drops a gap that fails the check. Turn this on to record nothing until a gap has passed."
          }
        />
      </Section>

      <Section title="Gap detection">
        <div className="flex flex-col gap-2">
          <span className="text-[15px] font-medium">Detector</span>
          <Segmented
            label="Detector"
            value={settings.detector}
            options={[
              { value: "auto", label: "AI depth" },
              { value: "edges", label: "Backup only" },
            ]}
            onChange={(v) => onChange({ detector: v })}
          />
          <p className="text-sm leading-snug text-muted">
            {settings.detector === "auto"
              ? "An AI model estimates how far away everything is. A gap is a narrow strip that's clearly farther than both sides. If the model can't run on this device, cthru switches to the backup detector by itself."
              : "The backup detector looks for straight edges and how things move as you slide. It needs no download, but it only records after the slide check, so you must slide before anything is recorded."}
          </p>
          <ModelStatus depthStatus={depthStatus} detector={detector} fallback={fallback} isDemo={isDemo} />
        </div>

        {settings.detector === "auto" && (
          <div className="flex flex-col gap-2">
            <span className="text-[15px] font-medium">Speed or detail</span>
            <Segmented
              label="Speed or detail"
              value={settings.depthSize}
              options={DEPTH_SIZES.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => onChange({ depthSize: v })}
            />
            <p className="text-sm leading-snug text-muted">{size.help}</p>
          </div>
        )}
      </Section>

      {cameras.length > 1 && (
        <Section title="Camera">
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Which camera
            <select
              value={cameraId}
              onChange={(e) => onCamera(e.target.value)}
              className="min-h-11 rounded-xl bg-control px-3 text-[15px] text-foreground"
            >
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-faint">On phones, an ultra-wide camera can help with gaps close up.</span>
          </label>
        </Section>
      )}

      <Section title="Debug views">
        <Toggle
          checked={settings.debug.stats}
          onChange={(v) => onChange({ debug: { ...settings.debug, stats: v } })}
          label="Live numbers"
          description="Scores, parallax, match, frame time and model speed, over the camera view."
        />
        <Toggle
          checked={settings.debug.depthMap}
          disabled={classic}
          onChange={(v) => onChange({ debug: { ...settings.debug, depthMap: v } })}
          label="Depth map"
          description="What the AI sees: warm is near, cool is far."
        />
        <Toggle
          checked={settings.debug.candidates}
          disabled={classic}
          onChange={(v) => onChange({ debug: { ...settings.debug, candidates: v } })}
          label="Every gap candidate"
          description="Outlines each possible gap with its score."
        />
        <Toggle
          checked={settings.debug.edgeGraph}
          onChange={(v) => onChange({ debug: { ...settings.debug, edgeGraph: v } })}
          label="Edge and motion graph"
          description="Pink: edge strength per column. Cyan: parallax evidence."
        />
      </Section>

      <Section title="Appearance">
        <Segmented
          label="Theme"
          value={theme}
          options={[
            { value: "auto", label: "Auto" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={onTheme}
        />
      </Section>
    </div>
  );
}

function QualityBar({ quality, threshold }: { quality: number | null; threshold: number }) {
  const good = quality !== null && quality >= threshold;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-control/60 px-3 py-2.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted">Gap in view now</span>
        <span className={`font-semibold tabular-nums ${quality === null ? "text-faint" : good ? "text-good" : "text-warn"}`}>
          {quality === null ? "none found" : `${Math.round(quality * 100)}% · ${good ? "will record" : "below the bar"}`}
        </span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-full bg-meter">
        {quality !== null && (
          <div className={`h-full rounded-full transition-[width] ${good ? "bg-emerald-400" : "bg-amber-400"}`} style={{ width: `${quality * 100}%` }} />
        )}
        <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${threshold * 100}%` }} title="The bar" />
      </div>
    </div>
  );
}

function ModelStatus({
  depthStatus: d,
  detector,
  fallback,
  isDemo,
}: {
  depthStatus: DepthStatus | null;
  detector: "depth" | "edges";
  fallback: boolean;
  isDemo: boolean;
}) {
  if (fallback) {
    return (
      <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-danger">
        The AI model couldn&apos;t start{d?.error ? ` (${d.error})` : ""}, so the backup detector is on. Reload the page to try again.
      </p>
    );
  }
  if (detector !== "depth") return null;
  if (isDemo) return <p className="text-xs text-faint">The demo is a flat drawing, so it uses simulated depth instead of the model.</p>;
  if (!d || d.state === "idle") return <p className="text-xs text-faint">The model loads when you start a scan (about 50 MB, once).</p>;
  if (d.state === "loading") {
    return (
      <div className="flex flex-col gap-1 text-xs text-muted">
        <span>Downloading the model… {Math.round(d.progress * 100)}%</span>
        <div className="h-1.5 overflow-hidden rounded-full bg-meter">
          <div className="h-full bg-sky-400" style={{ width: `${Math.round(d.progress * 100)}%` }} />
        </div>
      </div>
    );
  }
  if (d.state === "ready") {
    return (
      <p className="text-xs text-faint tabular-nums">
        Ready on the {d.device === "webgpu" ? "GPU" : "CPU (slower)"} · {d.rate.toFixed(1)} depth maps a second
      </p>
    );
  }
  return null;
}
