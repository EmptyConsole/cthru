import { describe, expect, it } from "vitest";
import { scanningCoach } from "../coach";

const base = {
  phase: "tracking" as const,
  scanning: true,
  quality: 0.8,
  threshold: 0.5,
  gapWidthFrac: 0.15,
  unstable: false,
  candidate: null,
  gap: { left: 10, right: 40 },
  forced: false,
};

describe("scanningCoach", () => {
  it("says move closer when the gap is a thin slice of the frame", () => {
    expect(scanningCoach({ ...base, gapWidthFrac: 0.05 })).toEqual({ id: "closer", text: "Move closer" });
  });

  it("says move farther when the gap fills too much of the frame", () => {
    expect(scanningCoach({ ...base, gapWidthFrac: 0.35 })).toEqual({ id: "farther", text: "Move farther" });
  });

  it("says better gap when quality is under the record threshold", () => {
    expect(scanningCoach({ ...base, quality: 0.2 })).toEqual({ id: "better", text: "Better gap" });
  });

  it("says better gap when nothing has been found", () => {
    expect(scanningCoach({ ...base, gap: null, candidate: null, gapWidthFrac: 0 })).toEqual({
      id: "better",
      text: "Better gap",
    });
  });

  it("says hold stable when a good gap is shaking", () => {
    expect(scanningCoach({ ...base, unstable: true })).toEqual({ id: "stable", text: "Hold stable" });
  });

  it("prefers distance advice over a weak or shaky gap", () => {
    expect(scanningCoach({ ...base, gapWidthFrac: 0.04, quality: 0.1 })?.id).toBe("closer");
    expect(scanningCoach({ ...base, gapWidthFrac: 0.42, unstable: true, quality: 0.1 })?.id).toBe("farther");
  });

  it("stays quiet when a hand-picked gap is a good size and steady", () => {
    expect(scanningCoach({ ...base, quality: 0.2, forced: true })).toBeNull();
  });

  it("stays quiet when the scan is going well", () => {
    expect(scanningCoach(base)).toBeNull();
  });

  it("stays quiet while paused", () => {
    expect(scanningCoach({ ...base, scanning: false, unstable: true, quality: 0.1 })).toBeNull();
  });
});
