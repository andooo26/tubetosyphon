# URL to Syphon (macOS)

Play a video URL (YouTube etc.) in an Electron window and output the picture as a
**Syphon** source, so VJ software such as **SynapseRack** can receive it via a
Syphon Receiver node. On **Windows** the same sources are published via
**Spout** instead (see [Windows (Spout)](#windows-spout)).

This is a from-scratch clone of the idea behind Saina's "URL To Spout/Syphon".
Output is **1280×720 (720p) fixed**, CPU pixel path, target ~30fps.

Syphon server name: **`URLtoSyphon`**.

---

## Requirements

- **macOS on Apple Silicon (arm64)** for Syphon. Intel is untested. Windows: see
  [Windows (Spout)](#windows-spout).
- **Node.js LTS** (developed on Node 24) and npm.
- **Xcode Command Line Tools** (`xcode-select --install`). Full Xcode is **not** required.
- **You do NOT need to install Syphon.framework into `/Library/Frameworks`.** See below.

### Syphon.framework — handled automatically

The originally-planned `electron-syphon` module needed a manual `Syphon.framework`
install in `/Library/Frameworks` and full Xcode to compile. We instead use
[`node-syphon`](https://github.com/benoitlahoz/node-syphon) (the actively
maintained successor `electron-syphon` itself points to). It ships a **prebuilt
arm64 `syphon.node`** and, on `npm install`, downloads a prebuilt
`Syphon.framework` into `node_modules/node-syphon/dist/Frameworks/`. The addon
finds it via an `@loader_path/../Frameworks` rpath — so there is **no `sudo`, no
`/Library/Frameworks`, and no compilation** for the Syphon path.

See [`docs/PHASE0-LOG.md`](docs/PHASE0-LOG.md) for the full risk-reduction
investigation and why the library was swapped.

---

## Setup

```bash
npm install
```

`node-syphon`'s postinstall downloads `Syphon.framework`. Confirm it landed:

```bash
ls node_modules/node-syphon/dist/Frameworks/Syphon.framework
```

If that directory is missing (e.g. the download was blocked), re-run:

```bash
npm rebuild node-syphon        # re-runs the postinstall
```

### Verify the Syphon path (Phase-0 probe)

Before running the full app you can prove the native output works:

```bash
npx electron scripts/phase0-probe.js
```

Expected tail:

```
OK created SyphonMetalServer: URLtoSyphon
published frames: <n>
PROBE_PASS
```

While it runs (2.5s), open a Syphon receiver (SynapseRack, or Syphon's
"Simple Client") and you should see a **red 1280×720** source named `URLtoSyphon`.

---

## Run

```bash
npm start
```

1. Paste a video URL (or click **Paste** to pull it from the clipboard) and press
   **Play** / Enter. YouTube links are auto-converted to the embed player.
2. Click **Start Syphon** to begin publishing. The status line shows the server
   name, live **fps**, and whether a receiver is connected.
3. **Test frame** publishes a solid red 720p frame (no video needed) — handy for
   confirming the receiver side in isolation.

---

## Projector output

**Projector** (top bar) opens a frameless fullscreen window on the chosen
display and shows one output — **A**, **B**, the **VJ mix**, or **汎用** — i.e.
the same picture that goes to Syphon/Spout, letterboxed to the display's aspect.
Picking another display while projecting moves the window. **Esc** in the
projector window (or **Stop proj**) closes it; unplugging the display closes it
too.

- Projecting A / B captures that player even if its Syphon/Spout output is
  not started.
- **VJ mix** works in either mode, with the A/B fader. In Dual mode the fader
  row appears while the projector source is VJ mix and drives only the
  projector — the two Dual outputs stay as they are and no mix is published.
- Project onto a display other than the one the main window is on: if the
  projector covers the main window, the OS stops painting the players and the
  feed freezes.

## Windows (Spout)

On Windows every output (L / R, the VJ mix, GEN) is published as a **Spout**
sender with the same names (`URLtoSyphon-L`, `TubeToSyphon`, …). Receive them
with any Spout receiver (Resolume, TouchDesigner, OBS + Spout plugin, …).

Spout goes through our own small addon, `native/spout`, built from the vendored
Spout2 SDK (`vendor/spout2`, SpoutDX). It is compiled on your machine at install:

- **Node.js LTS** and npm.
- **Visual Studio Build Tools** with the *Desktop development with C++*
  workload (MSVC + Windows SDK).

```powershell
npm install          # postinstall builds native/spout/build/Release/spout.node
npm start
```

`node-syphon` is an optional dependency and is skipped on Windows. If the Spout
build failed (e.g. Build Tools were missing), `npm install` only warns; install
the Build Tools and run `npm run build:spout`. Starting an output without the
addon shows the error in the UI.

Differences from Syphon: Spout cannot tell whether a receiver is connected, so
the status line omits "connected / no receiver". `.github/workflows/build-windows.yml`
builds the Windows app on a Windows runner (Setup.exe installer + portable zip,
in the run's Artifacts) and smoke-tests Spout in the packaged exe.

---

## YouTube playback: chrome & ads

YouTube links load the normal **watch page** (the `/embed/` player fails with
"Error 153" on videos whose owners disabled embedding). To keep the Syphon output
clean, `src/main.ts` injects, on every YouTube navigation:

- **CSS** that hides the masthead / sidebar / comments and expands the player to
  fill the window, so `capturePage()` grabs **video only** (`PLAYER_ONLY_CSS`).
- **JS** that auto-clicks "Skip Ad" and fast-forwards through unskippable ads
  (`AD_SKIP_JS`). This is best-effort.

**Fully ad-free options** (YouTube ads stream from the same host as the video, so
they can't be cleanly URL-blocked):

- Log in to a **YouTube Premium** account once in the player — the session is kept
  in the `persist:player` partition, so ads disappear for good.
- Or integrate an adblock engine (e.g. `@cliqz/adblocker-electron`) — not bundled.

## Receiving in SynapseRack

1. Add a **Syphon Receiver** node.
2. Select the server named **`URLtoSyphon`** (app name may show as the Electron
   app). The app must be running with **Start Syphon** active.
3. Route the Receiver's texture into a **Layer In/Out** (or any texture input) to
   use the YouTube picture as a VJ source.

> Syphon discovery generally works best if the receiver is already open when the
> server starts, or you re-toggle **Start Syphon**.

---

## How it works (architecture notes)

- **Capture happens in the Electron _main_ process** via
  `webContents.capturePage()` on the `<webview>`'s guest contents — **not** a
  renderer `canvas`/`getImageData`. Two reasons, documented in `src/main.ts`:
  1. YouTube in a `<webview>` is **cross-origin**, so drawing it to a canvas and
     calling `getImageData()` throws a *tainted-canvas* security error. You
     cannot read arbitrary cross-origin video pixels that way.
  2. `node-syphon` lives in main. Capturing there keeps the ~3.6 MB/frame
     (1280×720×4) pixel buffer **out of the renderer→main IPC channel**.
- The captured `NativeImage` is `resize()`d to 1280×720 and `toBitmap()` gives a
  **BGRA** buffer, which `SyphonManager` swizzles to **RGBA** before
  `publishImageData()`. Color/flip are single toggles in `src/syphon.ts` (I could
  not visually verify color order in the build environment).
- Loop is a `setInterval` at ~30fps with an in-flight guard so a slow
  `capturePage()` skips rather than piles up. Actual fps is measured and shown.

---

## Known limitations

- **macOS / Apple Silicon** (Syphon) or **Windows x64** (Spout), **720p fixed**.
- **CPU pixel path.** `capturePage → resize → BGRA→RGBA copy → publish` is done on
  the CPU each frame; expect meaningful CPU/energy use at 30fps. GPU texture
  sharing (IOSurface) is possible with `node-syphon`'s `publishSurfaceHandle`
  but is not wired up here — optimize after it works.
- **Color order / vertical flip** may need the toggles in `src/syphon.ts`
  depending on your receiver, since they weren't visually verified during build.
- **Packaging** (`npm make`): `Syphon.framework` and the `.node` must be unpacked
  from the asar. `AutoUnpackNativesPlugin` handles the `.node`; verify the
  framework is bundled/loadable in a packaged build before distributing (dev
  `npm start` is unaffected).

---

## Scripts

- `npm start` — run the app (Electron Forge + Vite dev server).
- `npx electron scripts/phase0-probe.js` — verify the Syphon output path.
- `npm run build:spout` — (Windows) build the Spout addon; also run by postinstall.
- `npm run make` — build a distributable (framework packaging caveat above).
