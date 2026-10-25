import { CueArt, GeometryDiagram } from "./art";

const STEPS = [
  {
    anim: "aim" as const,
    title: "Aim at the gap",
    text: "Hold the phone upright so the gap runs straight up the screen. Fill about a tenth to a quarter of the view with it. cthru finds the gap by itself; if it picks the wrong thing, drag across the right one.",
  },
  {
    anim: "slide" as const,
    title: "Slide sideways, slowly",
    text: "Move the phone left and right at the same distance. Don't turn it: turning shows nothing new. Sliding right reveals what's further left, the opposite of a normal panorama.",
  },
  {
    anim: "steady" as const,
    title: "Sweep back and forth",
    text: "Each pass fills in and cleans up the picture. Watch it build in the strip under the camera, then tap Done to save it.",
  },
];

export function HelpContent() {
  return (
    <div className="flex flex-col gap-6 pb-2 text-[15px] leading-relaxed text-muted">
      <ol className="flex flex-col gap-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-control text-foreground">
              <CueArt anim={s.anim} />
            </span>
            <div>
              <p className="font-semibold text-foreground">
                {i + 1}. {s.title}
              </p>
              <p className="text-sm">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-foreground">Why sliding works</h3>
        <p className="text-sm">
          The gap is close to you and the hidden scene is farther away. When you slide, the near edges move across the
          view faster than the far scene, so the scene drifts past the opening and new slices of it come into view.
          Each slice is placed where it matches the picture so far, so the result keeps the scene&apos;s real
          left-to-right order however you sweep.
        </p>
        <div className="mx-auto w-full max-w-xs text-foreground">
          <GeometryDiagram />
        </div>
        <p className="text-sm">
          The same effect is how cthru tells a real opening from a poster or picture frame on the wall: through a real
          gap the view shifts against the edges as you slide, while anything on the wall moves with them.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-base font-semibold text-foreground">Tips</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Dark gap? Turn on the torch (camera view, top right).</li>
          <li>Too thin to see much? Move closer, or use the zoom button.</li>
          <li>It records things that aren&apos;t gaps? Set Sensitivity to Strict in Settings.</li>
          <li>It ignores a faint gap? Set Sensitivity to Relaxed, or drag across the gap.</li>
          <li>The scene behind should be mostly at one distance. Things at very different depths can leave seams.</li>
        </ul>
      </div>
    </div>
  );
}
