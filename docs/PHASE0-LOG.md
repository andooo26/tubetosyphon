# Phase 0 — Syphon output risk-reduction log

The brief flagged the `electron-syphon` native build (node-gyp / Xcode / framework
linking / arm64) as the #1 risk and said to kill it first. Here's what happened.

## Environment

- Apple Silicon (arm64), macOS (Darwin 25.5), Node 24, npm 11.
- **Xcode Command Line Tools only** — no full Xcode (`xcodebuild` unavailable).
- `Syphon.framework` **not** present in `/Library/Frameworks`.

## Investigating `electron-syphon` (vcync/electron-syphon)

- **Not published to npm** — it's an experimental *app* repo, not a module. Would
  have to be vendored/forked to consume.
- `binding.gyp` links `/Library/Frameworks/Syphon.framework/Syphon` and its
  postinstall runs `node-gyp clean/configure/rebuild`. So it requires:
  - a **manual `Syphon.framework` install into `/Library/Frameworks` (sudo)**, and
  - a **local compile** of the `.mm` (and building the framework itself needs full
    Xcode, which this machine lacks).
- The native source **hardcodes the server name** `"SyphonMetalTexture"` and
  exposes only `publishSyphonFrame(buffer, w, h)` — no configurable name.

Net: three separate blockers on this exact machine (no full Xcode, no framework,
hardcoded name). The brief explicitly authorized alternatives if the build fights
us.

## Chosen path: `node-syphon` (benoitlahoz/node-syphon)

`electron-syphon`'s own README points to `node-syphon` as prior/related work; it's
the actively maintained successor. Findings:

- **On npm.** Ships a **prebuilt `syphon.node` (Mach-O arm64)** — no compile.
- `otool -L` shows it links `@rpath/Syphon.framework`, and its `postinstall.sh`
  downloads a prebuilt `SyphonFramework.zip` into
  `node_modules/node-syphon/dist/Frameworks/`. The `.node`'s rpath is
  `@loader_path/../Frameworks`, so it resolves the framework **without touching
  `/Library/Frameworks`, without sudo, without Xcode.**
- N-API addon → ABI-stable, so the same prebuilt binary loads under Electron
  without an `electron-rebuild`.
- Exposes `SyphonMetalServer(name)` with a **configurable name** → `URLtoSyphon`,
  and `publishImageData(Uint8ClampedArray, {x,y,w,h}, {w,h}, flipped)`.

User approved switching to `node-syphon` (2026-07-03).

## Verification (this is the "red frame" milestone)

Reproduce with:

```bash
npx electron scripts/phase0-probe.js
```

Result on the dev machine:

```
OK created SyphonMetalServer: URLtoSyphon
published frames: 73
PROBE_PASS
```

73 frames published in 2.5s inside Electron's runtime with **zero errors** — the
framework loaded, the Metal server constructed, and `publishImageData` succeeded.
This confirms the Syphon output path is alive. (Visual confirmation of the red
image in a receiver is a manual step — do it in SynapseRack or Syphon's Simple
Client while the probe or the app runs.)

## Notes / gotchas discovered

- `NativeImage.getBitmap()` is a **mistyped legacy alias** in Electron's `.d.ts`
  (declared returning `void`). Use **`toBitmap()`** (returns a BGRA `Buffer`).
- Electron's `toBitmap()` is **BGRA**; the Metal server wants **RGBA** → we swizzle
  B/R in `src/syphon.ts` (single `SWIZZLE_BGRA_TO_RGBA` toggle).
- A bare `node -e` script is a poor test: the Syphon server needs a live CFRunLoop
  to announce itself. Test inside Electron.
- The scaffold pinned **TypeScript 4.5.4**, too old to parse modern `@types/node`
  /React 19 — bumped to TS 5.x.

## Fallback (not needed, but planned)

If a future Electron/arch combo can't load the prebuilt `syphon.node`, the
documented fallback is a **separate tiny native helper process** running
`node-syphon`, fed pixels over IPC/stdin. Not required today — in-process publish
works.
