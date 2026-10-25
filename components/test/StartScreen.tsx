"use client";

import Link from "next/link";
import { useRef } from "react";
import { GapHero } from "./art";
import type { ThemeMode } from "./settings";
import { Button, Icon, ThemeIconName } from "./ui";

export function StartScreen({
  error,
  busy,
  theme,
  onTheme,
  onCamera,
  onDemo,
  onFile,
  onHelp,
}: {
  error: string | null;
  busy: boolean;
  theme: ThemeMode;
  onTheme: () => void;
  onCamera: () => void;
  onDemo: () => void;
  onFile: (f: File) => void;
  onHelp: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const themeName = theme === "auto" ? "Auto" : theme === "light" ? "Light" : "Dark";
  return (
    <div
      className="mx-auto flex min-h-svh w-full max-w-md flex-col px-4"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
    >
      <header className="flex items-center justify-between gap-3">
        <p className="flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tracking-tight">cthru</span>
          <span className="text-sm text-faint">the gap</span>
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onTheme}
            aria-label={`Theme: ${themeName}. Change theme`}
            title={`Theme: ${themeName}`}
            className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-control hover:text-foreground"
          >
            <Icon name={ThemeIconName(theme)} />
          </button>
          <button
            type="button"
            onClick={onHelp}
            aria-label="How it works"
            className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-control hover:text-foreground"
          >
            <Icon name="help" />
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col justify-center gap-6 py-6">
        <GapHero className="mx-auto w-full max-w-[18rem]" />
        <div className="flex flex-col gap-2 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-balance">See what&apos;s behind a gap</h1>
          <p className="text-[15px] leading-relaxed text-muted text-pretty">
            Point your camera at a narrow opening, like a door left ajar or a crack between boards, then slide sideways.
            cthru stitches what it sees through the gap into one wide picture.
          </p>
        </div>

        {error && (
          <p role="alert" className="rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-foreground">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Button variant="primary" icon="camera" onClick={onCamera} disabled={busy} className="min-h-14 text-base">
            {busy ? "Opening camera…" : "Start camera"}
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button icon="play" onClick={onDemo}>
              Try the demo
            </Button>
            <Button icon="film" onClick={() => fileRef.current?.click()}>
              Open a video
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="video/*,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = "";
            }}
          />
        </div>

        <ol className="grid grid-cols-3 gap-2 text-center text-xs text-muted">
          {[
            ["1", "Aim at the gap"],
            ["2", "Slide sideways"],
            ["3", "Save the picture"],
          ].map(([n, t]) => (
            <li key={n} className="flex flex-col items-center gap-1.5 rounded-2xl bg-surface px-2 py-3 ring-1 ring-line">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-control text-xs font-bold text-foreground">{n}</span>
              {t}
            </li>
          ))}
        </ol>
      </main>

      <footer className="flex flex-col items-center gap-1 text-center text-xs text-faint">
        <p>The first scan downloads a 50 MB AI model, then it&apos;s saved on this device. Video never leaves your device.</p>
        <Link href="/" className="underline underline-offset-2 hover:text-foreground">
          Open the original version
        </Link>
      </footer>
    </div>
  );
}
