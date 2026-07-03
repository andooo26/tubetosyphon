import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { SyphonManager } from './syphon';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// ---- Output constants (spec: 1080p fixed, ~60fps) -------------------------
const OUT_W = 1920;
const OUT_H = 1080;
const TARGET_FPS = 60;
const FRAME_INTERVAL_MS = Math.round(1000 / TARGET_FPS);

// ---- Channels (two independent players: left + right) ---------------------
// Each channel drives its own <webview> guest, its own Syphon server, and its
// own capture loop, so the two sides publish two separate Syphon sources.
type ChannelId = 'left' | 'right';

interface Channel {
  readonly id: ChannelId;
  readonly serverName: string;
  readonly syphon: SyphonManager;
  guestContentsId: number | null;
  captureTimer: NodeJS.Timeout | null;
  inFlight: boolean; // capturePage is async; skip a tick if the last is still running.
  testFrame: boolean; // publish a solid red frame instead of the webview.
  hideControls: boolean; // hide YouTube's playback bar + captions.
  hideCssKey: string | null; // insertCSS key for the CURRENT page (invalidated on navigation).
  framesThisSecond: number;
  lastFpsStamp: number;
  measuredFps: number;
}

function makeChannel(id: ChannelId, serverName: string): Channel {
  return {
    id,
    serverName,
    syphon: new SyphonManager(serverName),
    guestContentsId: null,
    captureTimer: null,
    inFlight: false,
    testFrame: false,
    hideControls: true,
    hideCssKey: null,
    framesThisSecond: 0,
    lastFpsStamp: Date.now(),
    measuredFps: 0,
  };
}

const channels: Record<ChannelId, Channel> = {
  left: makeChannel('left', 'URLtoSyphon-L'),
  right: makeChannel('right', 'URLtoSyphon-R'),
};

function getChannel(id: unknown): Channel | null {
  return id === 'left' || id === 'right' ? channels[id] : null;
}

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

// Hides the playback/seek bar + controls and captions so the captured frame is
// clean video only. Managed separately from PLAYER_ONLY_CSS (inserted/removed
// via a tracked key) so the UI can toggle it on and off at runtime.
const CHROME_HIDE_CSS = `
  /* playback/seek bar + controls + gradients */
  .ytp-chrome-bottom, .ytp-chrome-top, .ytp-gradient-bottom, .ytp-gradient-top,
  .ytp-progress-bar-container, .ytp-chrome-controls {
    display: none !important;
  }
  /* captions / subtitles */
  .ytp-caption-window-container, .caption-window, .ytp-caption-segment,
  .captions-text {
    display: none !important;
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
      // Turn subtitles/captions OFF by default (re-asserted every tick since
      // YouTube may re-enable them on navigation / autoplay).
      try {
        var mp = document.getElementById('movie_player');
        if (mp && mp.setOption) mp.setOption('captions', 'track', {});
        if (mp && mp.unloadModule) mp.unloadModule('captions');
      } catch (e) {}
      // Force the highest available playback quality. YouTube may downgrade on
      // its own (bandwidth/ABR), so we keep re-asserting it every tick.
      try {
        var p = document.getElementById('movie_player');
        if (p && p.getAvailableQualityLevels) {
          var levels = p.getAvailableQualityLevels();
          if (levels && levels.length) {
            var best = levels[0]; // array is ordered highest -> lowest
            if (p.setPlaybackQualityRange) p.setPlaybackQualityRange(best, best);
            if (p.setPlaybackQuality) p.setPlaybackQuality(best);
          }
        }
      } catch (e) {}
    }, 400);
    window.dispatchEvent(new Event('resize'));
  })();
`;

function setupYouTubeCleanup(guest: Electron.WebContents, ch: Channel) {
  const apply = () => {
    const url = guest.getURL();
    if (!/youtube\.com|youtu\.be/.test(url)) return;
    guest.insertCSS(PLAYER_ONLY_CSS).catch((): void => {});
    guest.executeJavaScript(AD_SKIP_JS).catch((): void => {});
    // The previous page's key is invalid after navigation; re-insert if enabled.
    ch.hideCssKey = null;
    if (ch.hideControls) {
      guest
        .insertCSS(CHROME_HIDE_CSS)
        .then((key) => {
          ch.hideCssKey = key;
        })
        .catch((): void => {});
    }
  };
  guest.on('dom-ready', apply);
  // YouTube is a SPA; re-apply on in-page navigations too.
  guest.on('did-navigate-in-page', apply);
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Enable the <webview> tag used to render YouTube etc.
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

// ---- Capture loop (per channel) -------------------------------------------

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

async function captureTick(ch: Channel) {
  if (ch.inFlight) return;
  ch.inFlight = true;
  try {
    if (ch.testFrame) {
      ch.syphon.publishBGRA(makeRedFrame(), OUT_W, OUT_H);
      countFrame(ch);
      return;
    }

    if (ch.guestContentsId == null) return;
    const guest = webContents.fromId(ch.guestContentsId);
    if (!guest || guest.isDestroyed()) {
      ch.guestContentsId = null;
      return;
    }

    // capturePage() -> NativeImage at page resolution; resize to fixed 720p.
    const image = await guest.capturePage();
    if (image.isEmpty()) return;
    const resized = image.resize({ width: OUT_W, height: OUT_H, quality: 'good' });
    // toBitmap() returns a BGRA buffer (getBitmap is a mistyped legacy alias).
    const bgra = resized.toBitmap();
    if (ch.syphon.publishBGRA(bgra, OUT_W, OUT_H)) countFrame(ch);
  } catch (err) {
    // Don't kill the loop on a transient capture error; surface it.
    sendStatus({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    ch.inFlight = false;
  }
}

function countFrame(ch: Channel) {
  ch.framesThisSecond++;
  const now = Date.now();
  if (now - ch.lastFpsStamp >= 1000) {
    ch.measuredFps = ch.framesThisSecond;
    ch.framesThisSecond = 0;
    ch.lastFpsStamp = now;
    sendStatus({});
  }
}

function startCapture(ch: Channel) {
  if (ch.captureTimer) return;
  ch.lastFpsStamp = Date.now();
  ch.framesThisSecond = 0;
  ch.captureTimer = setInterval(() => captureTick(ch), FRAME_INTERVAL_MS);
}

function stopCapture(ch: Channel) {
  if (ch.captureTimer) {
    clearInterval(ch.captureTimer);
    ch.captureTimer = null;
  }
  ch.measuredFps = 0;
}

// ---- Status -> renderer ---------------------------------------------------

function channelStatus(ch: Channel) {
  return {
    running: ch.syphon.isRunning,
    capturing: ch.captureTimer !== null,
    hasClients: ch.syphon.hasClients,
    fps: ch.measuredFps,
    serverName: ch.serverName,
    error: ch.syphon.error,
    testFrame: ch.testFrame,
    hideControls: ch.hideControls,
  };
}

function appStatus() {
  return {
    left: channelStatus(channels.left),
    right: channelStatus(channels.right),
  };
}

function sendStatus(extra: { error?: string }) {
  const status = appStatus();
  if (extra.error) {
    status.left = { ...status.left, error: extra.error };
    status.right = { ...status.right, error: extra.error };
  }
  mainWindow?.webContents.send('app:status', status);
}

// ---- IPC ------------------------------------------------------------------

// Renderer tells us which webContents id belongs to which channel (it reads
// <webview>.getWebContentsId() on dom-ready). This avoids relying on the order
// of did-attach-webview events.
ipcMain.handle(
  'app:register-guest',
  (_e, channelId: ChannelId, contentsId: number) => {
    const ch = getChannel(channelId);
    if (!ch) return { ok: false };
    if (ch.guestContentsId === contentsId) return { ok: true };
    const guest = webContents.fromId(contentsId);
    if (!guest || guest.isDestroyed()) return { ok: false };
    ch.guestContentsId = contentsId;
    setupYouTubeCleanup(guest, ch);
    return { ok: true };
  },
);

ipcMain.handle('app:start-output', (_e, channelId: ChannelId) => {
  const ch = getChannel(channelId);
  if (!ch) return { ok: false, error: 'unknown channel' };
  if (!ch.syphon.start()) {
    return { ok: false, error: ch.syphon.error };
  }
  startCapture(ch);
  sendStatus({});
  return { ok: true };
});

ipcMain.handle('app:stop-output', (_e, channelId: ChannelId) => {
  const ch = getChannel(channelId);
  if (!ch) return { ok: false, error: 'unknown channel' };
  stopCapture(ch);
  ch.syphon.dispose();
  sendStatus({});
  return { ok: true };
});

ipcMain.handle('app:test-frame', (_e, channelId: ChannelId, on: boolean) => {
  const ch = getChannel(channelId);
  if (!ch) return { ok: false, error: 'unknown channel' };
  ch.testFrame = on;
  if (on && !ch.syphon.start()) return { ok: false, error: ch.syphon.error };
  if (on) startCapture(ch);
  sendStatus({});
  return { ok: true };
});

ipcMain.handle(
  'app:set-hide-controls',
  async (_e, channelId: ChannelId, on: boolean) => {
    const ch = getChannel(channelId);
    if (!ch) return { ok: false, error: 'unknown channel' };
    ch.hideControls = on;
    const guest =
      ch.guestContentsId != null ? webContents.fromId(ch.guestContentsId) : null;
    if (guest && !guest.isDestroyed()) {
      if (ch.hideCssKey) {
        try {
          await guest.removeInsertedCSS(ch.hideCssKey);
        } catch {
          /* stale key after navigation — ignore */
        }
        ch.hideCssKey = null;
      }
      if (on) {
        try {
          ch.hideCssKey = await guest.insertCSS(CHROME_HIDE_CSS);
        } catch {
          /* ignore */
        }
      }
    }
    sendStatus({});
    return { ok: true };
  },
);

ipcMain.handle('app:get-status', () => appStatus());

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  for (const ch of Object.values(channels)) {
    stopCapture(ch);
    ch.syphon.dispose();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
