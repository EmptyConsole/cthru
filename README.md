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
3. **Slide** the device sideways, slowly, keeping the same distance. With
   **Wait for parallax** on (the default), recording only starts once sliding
   shows the view through the gap shifting against its edges. That's what proves
   it's a real opening and not a poster, frame or book on the wall. Turning on the
   spot reveals nothing new; the app warns you if you do that.
4. Sweep back and forth to fill in and clean up the picture, then **Download
   PNG**.

You can also load a recorded video (**Open a video**) or use the built-in
simulated fence (**Try the demo**).

**On phones** the screen stays awake while scanning, the phone gives a short
buzz when recording starts (where supported), the torch button appears when the
camera has one, and you can switch cameras (for example to the ultra-wide).
**On computers** the controls sit beside the camera view, and there are keyboard
shortcuts: <kbd>Space</kbd> pause, <kbd>R</kbd> re-detect / record,
<kbd>C</kbd> clear, <kbd>[</kbd> <kbd>]</kbd> threshold, <kbd>P</kbd> wait for
parallax, <kbd>M</kbd> mirror, <kbd>S</kbd> save.

Tick **Show edge graph** to see what the detector sees: pink is edge strength
per column, and cyan is parallax evidence (where the image moves differently from
the occluder). The demo fence has a poster and a sign on it. Both look like gaps
to the edge detector, but they show no parallax, so they're ignored.

## How it works

```
frame → gray (≤360 px) ─┬─ motion vs previous frame → parallax evidence map ─┐
                        ├─ edge / detail / extent profile ───────────────────┴→ detect / track the gap
                        └─ strip inside the gap → register against the mosaic → accumulate
frame → colour (≤3×)  ──────────────────────────────────────────────────────────┘
```

**Geometry.** The occluder is close and the hidden scene is further away. When
the device slides, the near edges move across the image faster than the far
scene (parallax), so the scene slides past the opening. Sliding right reveals
what is further *left*, the reverse of a normal panorama. Turning the device
moves both layers equally, so it reveals nothing.

**Gap detection** (`lib/gap/edges.ts`, `lib/gap/motion.ts`). Edges alone aren't
enough: a picture frame, book, door panel or poster on a wall has two strong
vertical edges with something different between them, just like a gap. So
detection combines four cues:

1. **Edges.** In each row, only the local maxima of the horizontal gradient
   magnitude count as edges. They are capped and averaged down each column. A long
   boundary scores near 1, while texture and faint grain score low. The measure
   ignores the edge's sign: what shows through a gap changes from row to row.
2. **Extent.** The share of the frame's height (6 row bands) in which each column
   holds an edge. A gap's sides usually run the full height; most rectangles
   don't.
3. **Appearance, detail and sides.** The inside is compared with each side in 12
   bands from top to bottom (brightness), plus the amount of horizontal detail.
   The view through a gap rarely matches the occluder in both. The two **sides**
   are also compared with *each other*: just outside a real gap, on both sides, is
   the occluder. A thin slice beside an opening (a lit edge face, a trim, a
   shadow) has the opening on one side and the occluder on the other.
4. **Motion: what changes.** This is the decisive cue. The frame is cut into
   6 px vertical bands, and each is block-matched against the previous frame. Each
   band refines its own best shift to sub-pixel accuracy, and the median, with
   near-equal votes per band, is the occluder's motion. Then **every pixel column**
   is checked against that motion: warp the previous frame by it and measure the
   residual, relative to the column's texture. Anything attached to the occluder
   fits almost perfectly, however thin and however close to the gap. The view
   through the gap, sliding at a different speed or revealing new content, doesn't.
   Full resolution matters: with whole bands, a 6 px slice beside a gap inherited
   the gap's motion. The per-column scores feed a **parallax evidence map** that is
   shifted with the occluder every frame, in whole pixels with the fraction carried
   over so it doesn't blur. That keeps evidence attached to the same place on the
   wall. The map only learns from frames that clearly show differential motion
   somewhere, so pausing at the end of a sweep neither erases a real gap nor builds
   up false evidence. Columns too featureless to show motion count as unobserved,
   not as "doesn't move".

   A pair's parallax score is judged **at its boundaries**. Just inside *each* edge
   (and in the middle) must move differently, and just outside each edge must not.
   That puts the boundary where see-through actually starts, not on the outer edge
   of a trim or edge face next to the opening.

Pairs of strong columns are ranked on all of these, plus a mild preference for
the centre of the frame. While tracking, detection keeps running. If a clearly
better candidate that overlaps or touches the tracked gap keeps winning for 5
frames (say, the real opening next to a slice it locked onto first), the scanner
moves to it. Candidates elsewhere in the frame are ignored, so it doesn't hop
between gaps. Once parallax has been observed, it outweighs
appearance: a real gap's inside moves differently from its sides, and a rectangle
on the wall scores about zero. A candidate that stays stable and good enough for
8 frames locks.

**Recording trigger** (`gapQuality` in `edges.ts`, gate in `scanner.ts`).
Each frame, the gap gets a 0–100% quality score that multiplies together:

- how strong the weaker edge is, compared with this frame's typical column (so
  heavy texture or noise, where every column looks edgy, doesn't pass);
- whether something *different* shows through, comparing the inside with each
  side in 12 bands from top to bottom (so it still works when the scene behind
  happens to match the occluder's overall brightness);
- how balanced the two edges are;
- whether there are stronger edges inside;
- whether the edges run the full height;
- and, once the device has slid, parallax, which then outweighs appearance.

The score is smoothed over frames. Auto-lock needs it at or above the threshold
for 8 stable frames. While tracking, recording starts after 5 frames above the
threshold, and pauses after 10 frames more than 8 points below it. This
hysteresis keeps a borderline gap from flickering. A gap that stays too weak for
about 3 s is dropped, and the scanner looks for a better one. With **Wait for
parallax** on, recording also needs the gap to have shown parallax (score ≥ 0.2
for 3 frames). In synthetic tests, a full-height textured strip on the wall
scores 100% quality in a still frame, exactly like a real gap. While sliding, its
parallax stays at or below 0, against about 0.95 for a real opening, so it's
never recorded.

**Tracking.** Both edges belong to one occluder, so they are searched as one
rigid shift plus a small width change. The search starts where the occluder's
measured motion says they went, and uses the same pair score, parallax included.
Edge positions are refined to subpixel accuracy.

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
| `lib/gap/edges.ts` | Edge / extent / detail profile, pair scoring and quality, detection, tracking |
| `lib/gap/motion.ts` | Dominant (occluder) motion and per-column differential motion |
| `lib/gap/registration.ts` | NCC strip-to-mosaic registration |
| `lib/gap/mosaic.ts` | Growable weighted accumulator |
| `lib/gap/scanner.ts` | `GapScanner`: state machine tying it together, user hints |
| `lib/gap/simulator.ts` | Synthetic fence + scene for the demo |
| `lib/gap/__tests__/` | End-to-end tests on synthetic frames with known motion (including gap look-alikes and edge faces right beside a gap), plus a real photo (`fixtures/door-gap.jpg`: a gap between two tables) tested as a still frame and as a sliding sequence built from it |
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
- Parallax needs depth behind the gap. If what's behind sits almost flush with
  the opening, or is dark and featureless, sliding shows little or no parallax.
  Turn off **Wait for parallax** (or drag across the gap) for those.
- Other things that move on their own (a person walking past, a screen) also
  "move differently". They still need two straight, full-height edges to be
  taken for a gap.
