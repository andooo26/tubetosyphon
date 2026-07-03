import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { SyphonManager } from './syphon';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// ---- Output constants (spec: 720p fixed, ~30fps) --------------------------
const OUT_W = 1280;
const OUT_H = 720;
const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = Math.round(1000 / TARGET_FPS);

const syphon = new SyphonManager('URLtoSyphon');

// The guest <webview>'s webContents, captured in the MAIN process.
let guestContentsId: number | null = null;

// Capture loop state.
let captureTimer: NodeJS.Timeout | null = null;
let inFlight = false; // capturePage is async; skip a tick if the last is still running.
let testFrame = false; // Phase-0: publish a solid red frame instead of the webview.

// fps measurement
let framesThisSecond = 0;
let lastFpsStamp = Date.now();
let measuredFps = 0;

let mainWindow: BrowserWindow | null = null;

// ---- YouTube "video only" + best-effort ad handling -----------------------
// Injected into the guest <webview> on every navigation. CSS collapses the
// watch page down to just the player (no masthead / sidebar / comments), so
// capturePage() grabs a clean frame. JS auto-clicks "Skip Ad" and fast-forwards
// through unskippable ads.
const PLAYER_ONLY_CSS = `
  /* hide everything except the player */
  #masthead-container, ytd-masthead, #secondary, #secondary-inner,
  #below, #comments, ytd-comments, #chat, #related, tp-yt-app-drawer,
  ytd-merch-shelf-renderer, #owner, #meta, ytd-watch-metadata,
  .ytp-pause-overlay, .ytp-ce-element, .iv-branding {
    display: none !important;
  }
  html, body { overflow: hidden !important; background: #000 !important; }
  ytd-app, #content, ytd-page-manager, #page-manager,
  ytd-watch-flexy, #primary, #primary-inner, #player, #player-container,
  #player-container-outer, #player-container-inner {
    margin: 0 !important; padding: 0 !important; max-width: none !important;
  }
  #movie_player, .html5-video-player {
    position: fixed !important; inset: 0 !important;
    width: 100vw !important; height: 100vh !important; z-index: 2147483647 !important;
  }
  video.html5-main-video {
    position: fixed !important; inset: 0 !important;
    width: 100vw !important; height: 100vh !important; object-fit: contain !important;
    left: 0 !important; top: 0 !important; transform: none !important;
  }
`;

const AD_SKIP_JS = `
  (function () {
    if (window.__u2s_adskip) return;
    window.__u2s_adskip = true;
    setInterval(function () {
      var btn = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button'
      );
      if (btn) btn.click();
      // Fast-forward through unskippable ads.
      if (document.querySelector('.ad-showing, .ytp-ad-player-overlay')) {
        var v = document.querySelector('video');
        if (v && isFinite(v.duration) && v.duration > 0) {
          try { v.currentTime = v.duration; } catch (e) {}
        }
      }
      // Dismiss "are you still watching" / survey dialogs.
      var dsm = document.querySelector('#dismiss-button button, .ytp-ad-overlay-close-button');
      if (dsm) dsm.click();
    }, 400);
    window.dispatchEvent(new Event('resize'));
  })();
`;

function setupYouTubeCleanup(guest: Electron.WebContents) {
  const apply = () => {
    const url = guest.getURL();
    if (!/youtube\.com|youtu\.be/.test(url)) return;
    guest.insertCSS(PLAYER_ONLY_CSS).catch(() => undefined);
    guest.executeJavaScript(AD_SKIP_JS).catch(() => undefined);
  };
  guest.on('dom-ready', apply);
  // YouTube is a SPA; re-apply on in-page navigations too.
  guest.on('did-navigate-in-page', apply);
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Enable the <webview> tag used to render YouTube etc.
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Grab the guest webview's webContents as soon as it attaches. We capture
  // pixels here in main (not in the renderer) for two reasons:
  //   1. YouTube in a <webview> is cross-origin, so a renderer canvas
  //      drawImage()+getImageData() would throw a "tainted canvas" security
  //      error — you cannot read arbitrary cross-origin video that way.
  //   2. node-syphon runs in main. Capturing here keeps the ~3.6 MB/frame
  //      (1280*720*4) pixel buffer out of the renderer->main IPC channel.
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    guestContentsId = guest.id;
    setupYouTubeCleanup(guest);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// ---- Capture loop ---------------------------------------------------------

function makeRedFrame(): Uint8Array {
  // BGRA solid red (SyphonManager swizzles BGRA->RGBA).
  const buf = new Uint8Array(OUT_W * OUT_H * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0; // B
    buf[i + 1] = 0; // G
    buf[i + 2] = 255; // R
    buf[i + 3] = 255; // A
  }
  return buf;
}

async function captureTick() {
  if (inFlight) return;
  inFlight = true;
  try {
    if (testFrame) {
      syphon.publishBGRA(makeRedFrame(), OUT_W, OUT_H);
      countFrame();
      return;
    }

    if (guestContentsId == null) return;
    const guest = webContents.fromId(guestContentsId);
    if (!guest || guest.isDestroyed()) {
      guestContentsId = null;
      return;
    }

    // capturePage() -> NativeImage at page resolution; resize to fixed 720p.
    const image = await guest.capturePage();
    if (image.isEmpty()) return;
    const resized = image.resize({ width: OUT_W, height: OUT_H, quality: 'good' });
    // toBitmap() returns a BGRA buffer (getBitmap is a mistyped legacy alias).
    const bgra = resized.toBitmap();
    if (syphon.publishBGRA(bgra, OUT_W, OUT_H)) countFrame();
  } catch (err) {
    // Don't kill the loop on a transient capture error; surface it.
    sendStatus({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    inFlight = false;
  }
}

function countFrame() {
  framesThisSecond++;
  const now = Date.now();
  if (now - lastFpsStamp >= 1000) {
    measuredFps = framesThisSecond;
    framesThisSecond = 0;
    lastFpsStamp = now;
    sendStatus({});
  }
}

function startCapture() {
  if (captureTimer) return;
  lastFpsStamp = Date.now();
  framesThisSecond = 0;
  captureTimer = setInterval(captureTick, FRAME_INTERVAL_MS);
}

function stopCapture() {
  if (captureTimer) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
  measuredFps = 0;
}

// ---- Status -> renderer ---------------------------------------------------

function sendStatus(extra: { error?: string }) {
  mainWindow?.webContents.send('app:status', {
    running: syphon.isRunning,
    capturing: captureTimer !== null,
    hasClients: syphon.hasClients,
    fps: measuredFps,
    serverName: 'URLtoSyphon',
    error: extra.error ?? syphon.error,
    testFrame,
  });
}

// ---- IPC ------------------------------------------------------------------

ipcMain.handle('app:start-output', () => {
  if (!syphon.start()) {
    return { ok: false, error: syphon.error };
  }
  startCapture();
  sendStatus({});
  return { ok: true };
});

ipcMain.handle('app:stop-output', () => {
  stopCapture();
  syphon.dispose();
  sendStatus({});
  return { ok: true };
});

ipcMain.handle('app:test-frame', (_e, on: boolean) => {
  testFrame = on;
  if (on && !syphon.start()) return { ok: false, error: syphon.error };
  if (on) startCapture();
  sendStatus({});
  return { ok: true };
});

ipcMain.handle('app:get-status', () => ({
  running: syphon.isRunning,
  capturing: captureTimer !== null,
  hasClients: syphon.hasClients,
  fps: measuredFps,
  serverName: 'URLtoSyphon',
  error: syphon.error,
  testFrame,
}));

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  stopCapture();
  syphon.dispose();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
