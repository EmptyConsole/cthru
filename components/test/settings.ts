import { DEFAULT_THRESHOLD } from "@/lib/gap/scanner";

/**
 * Preferences for the /test app. They use their own storage keys, so trying
 * things out here never changes how the main page behaves. The theme is the
 * one exception: the root layout reads its key before paint.
 */
const PREFIX = "cthru.test.";
export const THEME_KEY = "seethroughgap.theme";

export type ThemeMode = "light" | "dark" | "auto";
/** "auto": the depth model, falling back to the classic detector if it can't run. */
export type DetectorPref = "auto" | "edges";

export interface DebugFlags {
  depthMap: boolean;
  candidates: boolean;
  edgeGraph: boolean;
  stats: boolean;
}

export interface Settings {
  threshold: number;
  requireParallax: boolean;
  detector: DetectorPref;
  depthSize: number;
  debug: DebugFlags;
  demoAuto: boolean;
}

export const SENSITIVITY = [
  {
    id: "relaxed",
    label: "Relaxed",
    threshold: 0.35,
    help: "Records faint, dark or low-contrast gaps too. More likely to record something that isn't a gap.",
  },
  { id: "balanced", label: "Balanced", threshold: DEFAULT_THRESHOLD, help: "Right for most gaps." },
  {
    id: "strict",
    label: "Strict",
    threshold: 0.7,
    help: "Only clear, well-lit gaps. Use this if it records things that aren't gaps.",
  },
] as const;

/** Longest side of the image given to the depth model: speed vs detail. */
export const DEPTH_SIZES = [
  { value: 252, label: "Fast", help: "Quickest. Best for older phones." },
  { value: 336, label: "Balanced", help: "A good mix of speed and detail." },
  { value: 448, label: "Detailed", help: "Sharper gap edges, but slower. Best on computers." },
] as const;

export const MIN_THRESHOLD = 0.1;
export const MAX_THRESHOLD = 0.95;

export const DEFAULT_SETTINGS: Settings = {
  threshold: DEFAULT_THRESHOLD,
  requireParallax: false,
  detector: "auto",
  depthSize: 336,
  debug: { depthMap: false, candidates: false, edgeGraph: false, stats: false },
  demoAuto: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(PREFIX + "settings");
    if (!raw) return DEFAULT_SETTINGS;
    const v = JSON.parse(raw) as Partial<Settings>;
    const s = { ...DEFAULT_SETTINGS, ...v, debug: { ...DEFAULT_SETTINGS.debug, ...v.debug } };
    if (!(s.threshold >= MIN_THRESHOLD && s.threshold <= MAX_THRESHOLD)) s.threshold = DEFAULT_SETTINGS.threshold;
    if (s.detector !== "auto" && s.detector !== "edges") s.detector = "auto";
    if (!DEPTH_SIZES.some((o) => o.value === s.depthSize)) s.depthSize = DEFAULT_SETTINGS.depthSize;
    return s;
  } catch {
    // Storage can be unavailable (private mode, blocked site data) or hold something old.
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(PREFIX + "settings", JSON.stringify(s));
  } catch {
    // Not critical.
  }
}

export function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    // Storage can be unavailable.
  }
  return "auto";
}

export function saveTheme(v: ThemeMode) {
  document.documentElement.dataset.theme = v;
  try {
    localStorage.setItem(THEME_KEY, v);
  } catch {
    // Not critical.
  }
}

/** The preset a threshold matches, or null for a custom value. */
export function sensitivityFor(threshold: number) {
  return SENSITIVITY.find((o) => Math.abs(o.threshold - threshold) < 0.001) ?? null;
}
