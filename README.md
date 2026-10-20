# See Through the Gap

A Next.js web app that finds a narrow **vertical gap** in the camera view (a
crack between boards, a door left ajar, the space between two shelves) and,
while you slide the device sideways, stitches the slices visible through the
gap into one wide picture of what is behind it.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000. Use "Try the demo" if there's no camera.
npm test           # algorithm tests on synthetic footage
```

Phones only allow camera access over HTTPS. To try it on a phone on the same
Wi-Fi network:

```bash
npm run dev:phone  # https://<your-computer's-LAN-IP>:3000
```

The certificate is self-signed, so the phone will warn you before it opens the
page.

## How to use it

1. **Use camera**, then point it at the gap with the device upright, so the gap
   runs straight up the screen.
2. The gap is found automatically, and its **gap quality** shows top-right.
   Nothing is recorded until the quality clears the **recording threshold**
   (default 50%, adjustable, remembered on this device). The REC badge shows
   when it is recording. If it picks the wrong thing, drag across the gap in
   the camera view. A gap you pick by hand records whatever its quality.
3. **Slide** the device sideways, slowly, keeping the same distance. Turning on
   the spot reveals nothing new; the app warns you if you do that.
4. Sweep back and forth to fill in and clean up the picture, then **Download
   PNG**.

You can also load a recorded video (**Open a video**) or use the built-in
simulated fence (**Try the demo**).

**On phones** the screen stays awake while scanning, the phone gives a short
buzz when recording starts (where supported), the torch button appears when the
camera has one, and you can switch cameras (for example to the ultra-wide).
**On computers** the controls sit beside the camera view, and there are keyboard
shortcuts: <kbd>Space</kbd> pause, <kbd>R</kbd> re-detect / record,
<kbd>C</kbd> clear, <kbd>[</kbd> <kbd>]</kbd> threshold, <kbd>M</kbd> mirror,
<kbd>S</kbd> save.

## How it works

```
frame → gray (≤360 px) ─┬─ edge profile → detect / track the gap
                        └─ strip inside the gap → register against the mosaic → accumulate
frame → colour (≤3×)  ──────────────────────────────────────────────────────────┘
```

**Geometry.** The occluder is close and the hidden scene is further away. When
the device slides, the near edges move across the image faster than the far
scene (parallax), so the scene slides past the opening. Sliding right reveals
what is further *left*, the reverse of a normal panorama. Turning the device
moves both layers equally, so it reveals nothing.

**Gap detection** (`lib/gap/edges.ts`). In each row, only the local maxima of
the horizontal gradient magnitude count as edges. They are capped and averaged
down each column. A long boundary scores near 1, while texture and faint wood
grain score low. The measure ignores the edge's sign on purpose: what shows
through a gap changes from row to row, so one boundary can be bright→dark in one
row and dark→bright in the next. Pairs of strong columns are then scored on:
similar edge strengths, an inside that looks different from both sides, no
stronger edges inside, and a mild preference for the centre of the frame. A
candidate that stays stable for 8 frames locks.

**Recording trigger** (`gapQuality` in `edges.ts`, gate in `scanner.ts`).
Each frame, the gap gets a 0–100% quality score that multiplies together:

- how strong the weaker edge is, compared with this frame's typical column (so
  heavy texture or noise, where every column looks edgy, doesn't pass);
- whether something *different* shows through, comparing the inside with each
  side in 12 bands from top to bottom (so it still works when the scene behind
  happens to match the occluder's overall brightness);
- how balanced the two edges are;
- whether there are stronger edges inside.

The score is smoothed over frames. Auto-lock needs it at or above the threshold
for 8 stable frames. While tracking, recording starts after 5 frames above the
threshold, and pauses after 10 frames more than 8 points below it. This
hysteresis keeps a borderline gap from flickering. A gap that stays too weak for
about 3 s is dropped, and the scanner looks for a better one. On synthetic tests,
real slits score 79–99% and pairs of board seams or texture score 15–25%.

**Tracking.** Both edges belong to one occluder, so they are searched as one
rigid shift plus a small width change, using the same pair score. Edge positions
are refined to subpixel accuracy.

**Registration** (`lib/gap/registration.ts`). The strip inside the gap (inset
from its edges) is matched by normalised cross-correlation against the
**mosaic built so far**, not just the previous frame. That keeps drift from
building up and handles sweeping back and forth. The search starts from a
velocity prediction, gets wider after each miss, and falls back to a search over
the whole mosaic. Peaks on the edge of the search window are rejected. After the
scanner re-places itself, it checks a couple of frames before painting.

**Orientation.** Every slice is placed where its *content* matches, not in sweep
order, so the result has the scene's true left-right orientation. A naive "append
slices as you move" approach would mirror it. A **Mirror** toggle is there in case
you want the flipped view.

**Accumulation** (`lib/gap/mosaic.ts`). A weighted average that grows
horizontally as needed. Strips are feathered (more weight in the centre) and
weighted by match quality, and the per-pixel weight is capped so newer views
keep contributing. There are two buffers: grayscale at analysis resolution, used
for registration, and colour at up to 3× that, used for the output.

**Recovery.** If the edges disappear for 15 frames, or the gap still looks fine
but nothing behind it matches for 30 frames (probably the wrong pair of edges),
the scanner goes back to detection. The mosaic is kept, and the scan continues
from wherever the new view fits.

## Layout

| Path | What |
| --- | --- |
| `lib/gap/edges.ts` | Edge profile, gap detection, gap tracking |
| `lib/gap/registration.ts` | NCC strip-to-mosaic registration |
| `lib/gap/mosaic.ts` | Growable weighted accumulator |
| `lib/gap/scanner.ts` | `GapScanner`: state machine tying it together, user hints |
| `lib/gap/simulator.ts` | Synthetic fence + scene for the demo |
| `lib/gap/__tests__/` | End-to-end tests on synthetic frames with known motion |
| `components/GapScannerApp.tsx` | Camera/video/demo sources, overlay, controls, output |

## Limitations / next steps

- Vertical gaps only, held roughly upright (about ±1 px of tilt per row is tolerated).
- Assumes the hidden scene is roughly flat. Objects at very different depths
  behind the gap will show parallax seams.
- A uniform, textureless background can't be registered. The app says so.
- Processing runs on the main thread (a few ms per frame on a laptop; tick "Show
  edge graph" to see ms/frame). If it runs over budget, every other frame is
  skipped. Moving it to a Web Worker with `OffscreenCanvas` would help on slower
  phones.
- Rotating the phone mid-scan changes the frame shape, so the scan restarts.
