"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import css from "./scan.module.css";

// ---- Icons (24px, stroke = currentColor) -------------------------------------

const PATHS = {
  camera: "M3 8.5A2.5 2.5 0 0 1 5.5 6h1.8l1.4-2h6.6l1.4 2h1.8A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 5l-7 7 7 7",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  flip: "M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20v-4.5h4.5",
  torch: "M8 3h8l-1 6h-6zM9 9h6v4l-1.5 2v6h-3v-6L9 13z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  pause: "M9 6v12M15 6v12",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  share: "M12 15V4M8 8l4-4 4 4M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12",
  mirror: "M12 3v18M9 7L4 17h5zM15 7l5 10h-5z",
  film: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  play: "M8 5.5v13l10.5-6.5z",
  trash: "M5 7h14M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4h6v3",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4",
  moon: "M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z",
  auto: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 4v16",
  arrows: "M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} fill={name === "play" ? "currentColor" : "none"} />
    </svg>
  );
}

// ---- Buttons --------------------------------------------------------------------

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400";

export function Button({
  onClick,
  children,
  variant = "secondary",
  icon,
  disabled,
  className = "",
  type = "button",
}: {
  onClick?: () => void;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const look = {
    primary: "bg-emerald-400 text-emerald-950 hover:bg-emerald-300",
    secondary: "bg-control text-foreground hover:bg-control-hover",
    ghost: "text-muted hover:bg-control hover:text-foreground",
    danger: "text-danger hover:bg-red-500/10",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-12 touch-manipulation items-center justify-center gap-2 rounded-2xl px-4 text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${look} ${focus} ${className}`}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

/** A round icon button that floats over the camera view. */
export function HudButton({
  onClick,
  label,
  icon,
  active,
  children,
}: {
  onClick: () => void;
  label: string;
  icon?: IconName;
  active?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`flex h-11 min-w-11 touch-manipulation items-center justify-center rounded-full px-2.5 text-sm font-semibold shadow-lg backdrop-blur-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
        active ? "bg-amber-300 text-amber-950" : "bg-black/45 text-white hover:bg-black/60"
      }`}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

// ---- Form controls ------------------------------------------------------------------

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col gap-1 rounded-xl bg-control p-1">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`min-h-10 touch-manipulation rounded-lg px-2 text-sm font-semibold transition-colors ${focus} ${
              on ? "bg-surface text-foreground shadow-sm ring-1 ring-line" : "text-muted hover:text-foreground"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`flex items-start justify-between gap-4 ${disabled ? "opacity-50" : ""}`}>
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[15px] font-medium text-foreground">{label}</span>
        {description && <span className="mt-0.5 block text-sm leading-snug text-muted">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-7 w-12 shrink-0 touch-manipulation rounded-full transition-colors ${focus} ${
          checked ? "bg-emerald-400" : "bg-control-hover"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : ""}`}
        />
      </button>
    </div>
  );
}

// ---- Sheet ----------------------------------------------------------------------------

/**
 * A panel with a title and a visible Close button. On phones it slides up
 * from the bottom over a scrim; with `side` on large screens it's a docked
 * column instead (no scrim, the camera stays usable).
 */
export function Sheet({
  title,
  onClose,
  children,
  side = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  side?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    if (!side) panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, side]);

  const body = (
    <div
      ref={panel}
      tabIndex={-1}
      role={side ? "complementary" : "dialog"}
      aria-modal={side ? undefined : true}
      aria-labelledby={titleId}
      className={
        side
          ? "flex h-full w-full flex-col bg-surface outline-none"
          : `${css.sheet} flex max-h-[88svh] w-full flex-col rounded-t-3xl bg-surface shadow-2xl outline-none sm:max-w-lg sm:rounded-3xl`
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={`flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-control hover:text-foreground ${focus}`}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-5 pt-4" style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}>
        {children}
      </div>
    </div>
  );

  if (side) return body;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className={`${css.fade} absolute inset-0 bg-black/50`} onClick={onClose} aria-hidden />
      <div className="relative flex w-full justify-center">{body}</div>
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-line py-5 first:pt-1 last:border-b-0">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wider text-faint uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ThemeIconName(mode: "light" | "dark" | "auto"): IconName {
  return mode === "light" ? "sun" : mode === "dark" ? "moon" : "auto";
}
