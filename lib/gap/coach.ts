import type { Gap, ScannerStatus } from "./types";

export type CoachId = "closer" | "farther" | "better" | "stable";

export interface Coach {
  id: CoachId;
  text: string;
}

/** Gap narrower than this fraction of the frame should be scanned from closer in. */
const CLOSER_BELOW = 0.08;
/** Gap wider than this fraction of the frame should be scanned from farther away. */
const FARTHER_ABOVE = 0.3;

type CoachStatus = Pick<
  ScannerStatus,
  "scanning" | "quality" | "threshold" | "gapWidthFrac" | "unstable" | "forced"
> & {
  gap: Gap | null;
  candidate: Gap | null;
};

/**
 * One short instruction while a scan is running.
 * Distance comes first, then whether the gap is good enough to record, then shake.
 * A steady, good-sized gap returns null so the longer hint can take over.
 */
export function scanningCoach(status: CoachStatus): Coach | null {
  if (!status.scanning) return null;
  const hasGap = status.gap != null || status.candidate != null;
  const width = status.gapWidthFrac;
  if (hasGap && width > 0 && width < CLOSER_BELOW) return { id: "closer", text: "Move closer" };
  if (hasGap && width > FARTHER_ABOVE) return { id: "farther", text: "Move farther" };
  // A gap the user dragged out is usable even when it sits under the quality bar.
  const usable = hasGap && (status.quality >= status.threshold || status.forced);
  if (!usable) return { id: "better", text: "Better gap" };
  if (status.unstable) return { id: "stable", text: "Hold stable" };
  return null;
}
