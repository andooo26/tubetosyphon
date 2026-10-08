# Tube VJ (`windows-vj` branch)

Two YouTube decks (A / B), an A/B crossfader, a third deck **C** (generative
graphics or local video/image clips) layered on top, and a built-in fullscreen
**projector** output. Everything happens inside the app — no Syphon/Spout
receiver or other VJ software needed. Made to run comfortably on weak Windows
PCs; it also runs on macOS.

> The Syphon/Spout build with Dual and 汎用 modes lives on `main`.

## Use

```bash
npm install
npm start
```

1. Search / paste a URL in each deck (or press **YouTube** to browse in-app).
   Watch pages are collapsed to video only; browse pages project black.
2. Pick a display under **Projector** and press **Project** (Esc on the
   projector, or **Stop proj**, closes it).
3. Mix with the fader, **Fade→A / Fade→B** (length: **Time**), or **Cut A / B**.
   Keys: **Z** / **X** fade to A / B, **C** cuts to the other side.
4. **Deck C** (right column) is layered over the A/B mix with its own opacity
   fader (**In / Out** fade it, key **V** toggles) and a **Blend** mode
   (Normal / Screen / Add / Multiply / Difference).
   - **Gen**: the generative sketch from `main`'s 汎用 mode (Genre, BPM, Tap,
     Sync, Shuffle, Intensity, Tint).
   - **File**: **+ Add files** (mp4 / mov / webm / png / jpg / gif / webp);
     click a clip to show it. Videos loop. The list is remembered.
   - **Preview** shows C small in the window (off by default: it is a second
     render).
5. If the PC struggles, lower **Res** (720p) and/or **FPS** (30). Deck
   **Quality** defaults to 1080p (decoding 4K twice is the heaviest thing a weak
   PC can be asked to do). Settings persist.

Each deck's status shows `out N fps` — the frames the projector actually shows.

## How it works

The previous design captured frames into the main process
(`beginFrameSubscription` → crop/resize → BGRA→RGBA → blend → IPC copy to the
projector), all on the main thread. On a weak Windows PC that saturated it
(~850 ms of JS per second, timers 0.5 s late) and the mix ran at ~2 fps.

Now no pixel ever touches JavaScript:

- The projector window captures each deck's `<webview>` with Chromium **tab
  capture**: main issues a one-shot id with `webContents.getMediaSourceId()`
  and the projector opens it with `getUserMedia({ chromeMediaSource: 'tab' })`
  at a fixed 1920×1080 (or 1280×720) frame.
- Each stream plays in a `<video>`. Cropping to the drawn video (no double
  letterbox) and fitting to the display are plain CSS boxes, and the crossfade
  is B's `opacity` over A — all done by the GPU compositor.
- Deck C is one more layer: a canvas (generative) or a `<video>`/`<img>`
  (clips, served over a private `u2s-media://` scheme with Range support), with
  CSS `opacity` + `mix-blend-mode`. It is unmounted while at 0 %, so a hidden C
  costs nothing.
- Main only holds the small shared state (which guests, crop rects measured
  twice a second, fader, settings) and pushes it to the projector on change.
  Fades are animated in the projector per display frame.

Files: `src/main.ts` (state + IPC), `src/projector.ts` (window),
`src/ProjectorView.tsx` (capture + mix), `src/App.tsx` (control UI),
`src/youtube.ts` (injected CSS/JS), `src/media.ts` (clip serving),
`src/gen/` + `src/GenView.tsx` (generative sketch), `src/shared.ts` (types).

## Diagnostics

- `U2S_PERF=1` — one JSON line per second (console + `<userData>/perf.log`):
  main-thread lag, CPU per process, projector fps / capture size per deck.
- `U2S_BENCH=vjproj` — loads a full-motion test page in both decks, sets the
  fader to 50 %, opens the projector, prints a `U2S_BENCH {…}` summary and
  exits. Options: `U2S_BENCH_SECONDS`, `U2S_BENCH_ALPHA`,
  `U2S_BENCH_URLS="<A> <B>"` (real pages), `U2S_BENCH_SHOT=<dir>` (PNGs of the
  projector and control window), `U2S_BENCH_C=<0..1>` (layer deck C at that
  opacity; generative, or `U2S_BENCH_CLIP=<file>`).
- `U2S_KEEP_VIDEO_OVERLAYS=1` — keep Windows' DirectComposition video overlays
  (disabled by default so captured video updates every frame).

## Windows build

`.github/workflows/build-windows.yml` builds on a Windows runner on every push:
Setup.exe installer + portable zip (run's **Artifacts**), a smoke test of the
packaged exe, and the benchmark (its summary is shown as a notice on the run
page). No native addons or Visual Studio Build Tools are needed.

## YouTube notes

Watch URLs load the normal watch page (`/embed/` fails on videos with embedding
disabled). Injected JS skips/fast-forwards ads (best effort) and hides
captions; **Chrome: off** hides the player bar. For ad-free playback, use
**Googleログイン** with a YouTube Premium account (shared by both decks).
