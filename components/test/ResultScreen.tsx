"use client";

import { useEffect, useRef, useState } from "react";
import { mosaicBlob } from "./draw";
import { Button, Icon } from "./ui";

export function ResultScreen({
  picture,
  mirror,
  coverage,
  frames,
  onMirror,
  onBack,
  onStartOver,
  onFinish,
}: {
  /** Full-resolution picture (owned by the engine). */
  picture: HTMLCanvasElement | null;
  mirror: boolean;
  coverage: number;
  frames: number;
  onMirror: (v: boolean) => void;
  onBack: () => void;
  onStartOver: () => void;
  onFinish: () => void;
}) {
  const viewRef = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState(true);
  const [saved, setSaved] = useState<string | null>(null);
  const canShare = useCanShareFiles();

  // Take a copy, so the picture shown can't change underneath the user.
  useEffect(() => {
    const c = viewRef.current;
    if (!c || !picture) return;
    c.width = picture.width;
    c.height = picture.height;
    c.getContext("2d")!.drawImage(picture, 0, 0);
  }, [picture]);

  const fileName = () => `cthru-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;

  const download = async () => {
    const c = viewRef.current;
    if (!c) return;
    const blob = await mosaicBlob(c, mirror);
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setSaved("Saved to your downloads.");
  };

  const share = async () => {
    const c = viewRef.current;
    if (!c) return;
    const blob = await mosaicBlob(c, mirror);
    if (!blob) return;
    try {
      await navigator.share({ files: [new File([blob], fileName(), { type: "image/png" })], title: "What's behind the gap" });
    } catch {
      // Cancelled, or not allowed: nothing to do.
    }
  };

  return (
    <div
      className="mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-4 px-4"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))", paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
    >
      <header className="flex items-center justify-between gap-2">
        <Button variant="ghost" icon="back" onClick={onBack} className="-ml-2 px-3">
          Keep scanning
        </Button>
        <Button variant="ghost" onClick={onFinish} className="-mr-2 px-3">
          Finish
        </Button>
      </header>

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">What&apos;s behind the gap</h1>
        <p className="text-sm text-muted">
          {coverage.toFixed(1)}× wider than the gap · built from {frames} frames
        </p>
      </div>

      <div className="relative overflow-hidden rounded-2xl bg-[repeating-conic-gradient(var(--checker-a)_0%_25%,var(--checker-b)_0%_50%)] bg-[length:24px_24px] ring-1 ring-line">
        <div className={fit ? "flex items-center justify-center p-2" : "overflow-x-auto"}>
          <canvas
            ref={viewRef}
            className={fit ? "block max-h-[55svh] max-w-full" : "block h-[55svh] max-w-none"}
            style={{ width: fit ? undefined : "auto", height: fit ? "auto" : undefined, transform: mirror ? "scaleX(-1)" : undefined }}
          />
        </div>
        <button
          type="button"
          onClick={() => setFit((f) => !f)}
          className="absolute right-2 bottom-2 flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-semibold text-white hover:bg-black/75"
        >
          <Icon name={fit ? "expand" : "arrows"} className="h-4 w-4" />
          {fit ? "Zoom in" : "Fit"}
        </button>
      </div>
      {!fit && <p className="-mt-2 text-center text-xs text-faint">Scroll sideways to see all of it.</p>}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="primary" icon="download" onClick={() => void download()} className="flex-1">
          Save image
        </Button>
        {canShare && (
          <Button icon="share" onClick={() => void share()} className="flex-1">
            Share
          </Button>
        )}
      </div>
      {saved && (
        <p role="status" className="-mt-1 text-center text-sm text-good">
          {saved}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <Button variant="ghost" icon="mirror" onClick={() => onMirror(!mirror)} className="-ml-2">
          {mirror ? "Mirrored" : "Mirror"}
        </Button>
        <Button variant="danger" icon="trash" onClick={onStartOver} className="-mr-2">
          Start over
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-faint">
        The picture already has the scene&apos;s real left-to-right order. Mirror it only if you need the flipped view.
        Keep scanning to add more, or sweep over rough parts to clean them up.
      </p>
    </div>
  );
}

function useCanShareFiles() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    try {
      const f = new File([new Blob()], "x.png", { type: "image/png" });
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOk(typeof navigator.canShare === "function" && navigator.canShare({ files: [f] }));
    } catch {
      setOk(false);
    }
  }, []);
  return ok;
}
