import { app, BrowserWindow, dialog, ipcMain, screen, webContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import {
  getLoginState,
  installLoginHeaderFilter,
  logout,
  openGoogleLogin,
  type LoginState,
} from './login';
import {
  MEDIA_EXTENSIONS,
  handleMediaScheme,
  makeClip,
  registerMediaScheme,
  type ClipEntry,
} from './media';
import { setPerfExtra, startPerf } from './perf';
import { runBench } from './bench';
import {
  closeProjector,
  handleDisplayRemoved,
  isProjectorOpen,
  openProjector,
  projectorStatus,
  sendProjectorState,
  setProjectorStats,
} from './projector';
import {
  AD_SKIP_JS,
  CHROME_HIDE_CSS,
  VIDEO_RECT_JS,
  isWatchUrl,
} from './youtube';
import {
  DEFAULT_GEN_PARAMS,
  clampGenParams,
  type GenParams,
} from './gen/params';
import {
  BLENDS,
  CHANNELS,
  DEFAULT_OUTPUT,
  mixAt,
  type AppStatus,
  type Blend,
  type CSource,
  type ChannelId,
  type DeckStatus,
  type MixAnim,
  type OutputSettings,
  type ProjectorState,
  type ProjectorStats,
  type Quality,
  type VideoRect,
} from './shared';

// ---- Architecture -----------------------------------------------------------
// VJ only: two YouTube players (A / B) crossfaded onto a fullscreen projector
// window, plus deck C (generative sketch or a local clip) layered on top. The main process never touches a pixel — the projector captures the
// players itself (see projector.ts) — so it stays idle no matter how weak the
// machine is. Main only keeps the small shared state (which guests, crop rects,
// fader position, output settings) and pushes it to the projector on change.

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

registerMediaScheme(); // must happen before 'ready'

// Windows: Chromium may present <video> through DirectComposition hardware
// overlays, which bypass the compositor frame that tab capture copies — the
// projector would then only get a new frame when something else repaints.
// Compositing video normally keeps every video frame capturable.
// U2S_KEEP_VIDEO_OVERLAYS=1 skips this (to A/B the effect).
if (
  process.platform === 'win32' &&
  process.env.U2S_KEEP_VIDEO_OVERLAYS !== '1'
) {
  app.commandLine.appendSwitch('disable-direct-composition-video-overlays');
}

// Benchmark on a single-display machine (CI): the fullscreen projector covers
// the main window, and Windows' native occlusion tracking would then stop the
// players from painting. Keep them painting so the scenario stays realistic.
if (process.env.U2S_BENCH && process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

// While the projector is open, how often each player's drawn-video rect is
// re-measured (a cheap executeJavaScript round-trip, not per frame).
const RECT_POLL_MS = 500;
// UI refresh rate while a fade animates (the projector animates on its own).
const FADE_UI_MS = 50;

// ---- Decks (A = left, B = right) ---------------------------------------------

interface Channel {
  readonly id: ChannelId;
  guestContentsId: number | null;
  live: boolean; // false only on a YouTube browse page (-> projects black)
  isYouTube: boolean; // the video fills the viewport via our CSS -> crop to it
  videoRect: VideoRect | null;
  rectBusy: boolean; // a VIDEO_RECT_JS round-trip is in flight
  hideControls: boolean; // hide YouTube's playback bar + captions
  quality: Quality; // target YouTube playback quality
  hideCssKey: string | null; // insertCSS key for the CURRENT page
}

function makeChannel(id: ChannelId): Channel {
  return {
    id,
    guestContentsId: null,
    live: false,
    isYouTube: false,
    videoRect: null,
    rectBusy: false,
    hideControls: true,
    // The projector never needs more than 1080p, and decoding 4K on two decks
    // is the single most expensive thing a weak PC could be asked to do.
    quality: 'hd1080',
    hideCssKey: null,
  };
}

const channels: Record<ChannelId, Channel> = {
  left: makeChannel('left'),
  right: makeChannel('right'),
};

function getChannel(id: unknown): Channel | null {
  return id === 'left' || id === 'right' ? channels[id] : null;
}

function guestOf(ch: Channel): Electron.WebContents | null {
  if (ch.guestContentsId == null) return null;
  const g = webContents.fromId(ch.guestContentsId);
  return g && !g.isDestroyed() ? g : null;
}

// ---- Faders -------------------------------------------------------------------
// The A/B crossfade and deck C's opacity. A fade is sent to the projector as a
// MixAnim and animated there per display frame; main only ticks the UI.

class Fader {
  value: number; // resting value (the target while a fade runs)
  anim: MixAnim | null = null;
  constructor(value: number) {
    this.value = value;
  }
  current(now = Date.now()): number {
    return mixAt(this.value, this.anim, now);
  }
  set(v: number) {
    this.anim = null;
    this.value = Math.min(1, Math.max(0, v));
  }
  fadeTo(target: number, durationMs: number) {
    const to = Math.min(1, Math.max(0, target));
    if (!(durationMs > 0)) {
      this.set(to);
      return;
    }
    this.anim = { from: this.current(), to, start: Date.now(), dur: durationMs };
    this.value = to;
  }
  /** Drop a finished fade. True when one just finished. */
  settle(now: number): boolean {
    if (this.anim && now >= this.anim.start + this.anim.dur) {
      this.anim = null;
      return true;
    }
    return false;
  }
}

const mix = new Fader(0); // 0 = A, 1 = B
const cLevel = new Fader(0); // deck C opacity
let fadeTimer: NodeJS.Timeout | null = null;

// While any fade runs, keep the UI faders moving; push the settled state to
// the projector when one finishes.
function ensureFadeTimer() {
  if (fadeTimer) return;
  fadeTimer = setInterval(() => {
    const now = Date.now();
    const mixDone = mix.settle(now);
    const cDone = cLevel.settle(now);
    if (mixDone || cDone) pushState();
    sendStatus();
    if (!mix.anim && !cLevel.anim && fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }, FADE_UI_MS);
}

function stopFades() {
  if (fadeTimer) clearInterval(fadeTimer);
  fadeTimer = null;
}

// ---- Deck C (persisted) ----------------------------------------------------------

interface CState {
  source: CSource;
  blend: Blend;
  gen: GenParams;
  clips: ClipEntry[];
  clipId: string | null;
}

const c: CState = {
  source: 'gen',
  blend: 'screen',
  gen: { ...DEFAULT_GEN_PARAMS },
  clips: [],
  clipId: null,
};

const cFile = () => path.join(app.getPath('userData'), 'deck-c.json');

function loadC() {
  try {
    const raw = JSON.parse(fs.readFileSync(cFile(), 'utf8'));
    if (raw.source === 'gen' || raw.source === 'file') c.source = raw.source;
    if (BLENDS.some((b) => b.value === raw.blend)) c.blend = raw.blend;
    c.gen = clampGenParams(raw.gen ?? {}, c.gen);
    const paths: unknown[] = Array.isArray(raw.paths) ? raw.paths : [];
    c.clips = paths
      .filter((p): p is string => typeof p === 'string' && fs.existsSync(p))
      .map(makeClip)
      .filter((x): x is ClipEntry => x !== null);
    c.clipId = c.clips.some((x) => x.id === raw.clipId) ? raw.clipId : c.clips[0]?.id ?? null;
  } catch {
    /* first run */
  }
  // The beat grid starts now (the stored epoch is from a previous session).
  c.gen = { ...c.gen, beatEpoch: Date.now() };
}

function saveC() {
  const data = {
    source: c.source,
    blend: c.blend,
    gen: c.gen,
    paths: c.clips.map((x) => x.path),
    clipId: c.clipId,
  };
  fs.promises.writeFile(cFile(), JSON.stringify(data)).catch((): void => undefined);
}

const publicClip = ({ id, name, url, kind }: ClipEntry) => ({ id, name, url, kind });

// ---- Output settings (persisted) ----------------------------------------------

const settingsFile = () => path.join(app.getPath('userData'), 'output.json');

function loadOutput(): OutputSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return clampOutput(raw, DEFAULT_OUTPUT);
  } catch {
    return { ...DEFAULT_OUTPUT };
  }
}

function clampOutput(
  patch: Partial<OutputSettings>,
  base: OutputSettings,
): OutputSettings {
  return {
    height: patch?.height === 720 || patch?.height === 1080 ? patch.height : base.height,
    fps: patch?.fps === 30 || patch?.fps === 60 ? patch.fps : base.fps,
  };
}

let output: OutputSettings = DEFAULT_OUTPUT;

let mainWindow: BrowserWindow | null = null;

// ---- YouTube page treatment ---------------------------------------------------

function setupYouTubeCleanup(guest: Electron.WebContents, ch: Channel) {
  const apply = () => {
    if (guest.isDestroyed()) return;
    const url = guest.getURL();
    const isYouTube = /youtube\.com|youtu\.be/.test(url);
    // Black only on YouTube *browse* pages. Non-YouTube URLs (arbitrary video
    // pages) and YouTube watch/shorts pages are projected.
    ch.live = !isYouTube || isWatchUrl(url);
    ch.isYouTube = isYouTube;
    ch.videoRect = null; // re-measured for the new page
    pushState();
    sendStatus();
    if (!isYouTube) return;
    // Seed the target quality before the injected interval starts reading it.
    pushQuality(ch);
    // The persistent-<style> injector applies/removes the "video only" layout
    // itself based on the live URL, so it self-heals across SPA navigations.
    guest.executeJavaScript(AD_SKIP_JS).catch((): void => undefined);
    // The previous page's key is invalid after navigation; re-insert if enabled.
    ch.hideCssKey = null;
    if (ch.hideControls) {
      guest
        .insertCSS(CHROME_HIDE_CSS)
        .then((key) => {
          ch.hideCssKey = key;
        })
        .catch((): void => undefined);
    }
  };
  guest.on('dom-ready', apply);
  // YouTube is a SPA; re-apply on in-page navigations too.
  guest.on('did-navigate-in-page', apply);
  guest.on('did-navigate', apply);
  guest.on('destroyed', () => {
    if (ch.guestContentsId === guest.id) {
      ch.guestContentsId = null;
      ch.live = false;
      pushState();
    }
  });
}

// The injected interval reads window.__u2s_targetQuality every tick and
// re-asserts it, so this takes effect live and survives ABR downgrades.
function pushQuality(ch: Channel) {
  guestOf(ch)
    ?.executeJavaScript(`window.__u2s_targetQuality=${JSON.stringify(ch.quality)};`)
    .catch((): void => undefined);
}

// Re-measure where the video is drawn in the guest. Only while projecting.
function refreshVideoRect(ch: Channel) {
  if (ch.rectBusy || !ch.live || !ch.isYouTube) return;
  const guest = guestOf(ch);
  if (!guest) return;
  ch.rectBusy = true;
  guest
    .executeJavaScript(VIDEO_RECT_JS)
    .then((r: VideoRect | null) => {
      const next = r && r.width > 0 && r.height > 0 ? r : null;
      if (JSON.stringify(next) !== JSON.stringify(ch.videoRect)) {
        ch.videoRect = next;
        pushState();
      }
    })
    .catch((): void => undefined)
    .finally(() => {
      ch.rectBusy = false;
    });
}

let rectTimer: NodeJS.Timeout | null = null;

function syncRectPolling() {
  const want = isProjectorOpen();
  if (want && !rectTimer) {
    rectTimer = setInterval(() => {
      for (const id of CHANNELS) refreshVideoRect(channels[id]);
    }, RECT_POLL_MS);
  } else if (!want && rectTimer) {
    clearInterval(rectTimer);
    rectTimer = null;
  }
}

// ---- Windows --------------------------------------------------------------------

// Load the renderer bundle into `win`. `search` selects which root it mounts
// ('' = the control UI, 'projector=1' = the projector).
function loadRenderer(win: BrowserWindow, search = '') {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const q = search ? `?${search}` : '';
    win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}${q}`);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      search ? { search } : undefined,
    );
  }
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 900,
    title: 'Tube VJ',
    backgroundColor: '#0b0b0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // The projector is a BrowserWindow too, so it would keep
  // 'window-all-closed' from ever firing; tear it down with the UI.
  mainWindow.on('closed', () => {
    mainWindow = null;
    closeProjector();
  });
  loadRenderer(mainWindow);
};

// ---- State -> projector / UI ----------------------------------------------------

function projectorState(): ProjectorState {
  const deck = (ch: Channel) => ({
    guestId: ch.guestContentsId,
    live: ch.live,
    rect: ch.isYouTube ? ch.videoRect : null,
  });
  return {
    decks: { left: deck(channels.left), right: deck(channels.right) },
    alpha: mix.value,
    anim: mix.anim,
    c: {
      source: c.source,
      opacity: cLevel.value,
      anim: cLevel.anim,
      blend: c.blend,
      gen: c.gen,
      clip: (() => {
        const clip = c.clips.find((x) => x.id === c.clipId);
        return clip ? publicClip(clip) : null;
      })(),
    },
    output,
  };
}

function pushState() {
  sendProjectorState(projectorState());
}

function deckStatus(ch: Channel): DeckStatus {
  return { live: ch.live, hideControls: ch.hideControls, quality: ch.quality };
}

function appStatus(): AppStatus {
  return {
    left: deckStatus(channels.left),
    right: deckStatus(channels.right),
    alpha: mix.current(),
    fading: mix.anim !== null,
    c: {
      source: c.source,
      opacity: cLevel.current(),
      fading: cLevel.anim !== null,
      blend: c.blend,
      gen: c.gen,
      clips: c.clips.map(publicClip),
      clipId: c.clipId,
    },
    projector: projectorStatus(),
    output,
  };
}

function sendStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:status', appStatus());
  }
}

function setLevel(f: Fader, v: number) {
  f.set(v);
  pushState();
  sendStatus();
}

function fadeLevel(f: Fader, target: number, durationMs: number) {
  f.fadeTo(target, durationMs);
  pushState(); // the projector animates this itself, frame-accurately
  if (f.anim) ensureFadeTimer();
  sendStatus();
}

// ---- IPC: control UI ---------------------------------------------------------------

// The renderer tells us which webContents id belongs to which deck (it reads
// <webview>.getWebContentsId() on dom-ready).
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
    pushState(); // the projector re-acquires the new guest
    return { ok: true };
  },
);

ipcMain.handle(
  'app:set-hide-controls',
  async (_e, channelId: ChannelId, on: boolean) => {
    const ch = getChannel(channelId);
    if (!ch) return { ok: false, error: 'unknown channel' };
    ch.hideControls = !!on;
    const guest = guestOf(ch);
    if (guest) {
      if (ch.hideCssKey) {
        await guest.removeInsertedCSS(ch.hideCssKey).catch((): void => undefined);
        ch.hideCssKey = null;
      }
      if (ch.hideControls) {
        ch.hideCssKey = await guest.insertCSS(CHROME_HIDE_CSS).catch((): null => null);
      }
    }
    sendStatus();
    return { ok: true };
  },
);

ipcMain.handle('app:set-quality', (_e, channelId: ChannelId, quality: Quality) => {
  const ch = getChannel(channelId);
  if (!ch) return { ok: false, error: 'unknown channel' };
  ch.quality = quality;
  pushQuality(ch);
  sendStatus();
  return { ok: true };
});

const faderOf = (which: unknown) => (which === 'c' ? cLevel : which === 'mix' ? mix : null);

ipcMain.handle('app:set-level', (_e, which: 'mix' | 'c', v: number) => {
  const f = faderOf(which);
  if (!f || typeof v !== 'number' || !isFinite(v)) return { ok: false, error: 'bad level' };
  setLevel(f, v);
  return { ok: true };
});

ipcMain.handle('app:fade', (_e, which: 'mix' | 'c', target: number, durationMs: number) => {
  const f = faderOf(which);
  if (!f || typeof target !== 'number' || !isFinite(target)) {
    return { ok: false, error: 'bad target' };
  }
  fadeLevel(f, target, typeof durationMs === 'number' ? durationMs : 0);
  return { ok: true };
});

// ---- IPC: deck C -----------------------------------------------------------------

function cChanged() {
  saveC();
  pushState();
  sendStatus();
}

ipcMain.handle(
  'app:c-set',
  (_e, patch: { source?: CSource; blend?: Blend; clipId?: string }) => {
    if (patch?.source === 'gen' || patch?.source === 'file') c.source = patch.source;
    if (BLENDS.some((b) => b.value === patch?.blend)) c.blend = patch.blend as Blend;
    if (c.clips.some((x) => x.id === patch?.clipId)) c.clipId = patch.clipId as string;
    cChanged();
    return { ok: true };
  },
);

ipcMain.handle('app:c-gen', (_e, patch: Partial<GenParams>) => {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'bad params' };
  c.gen = clampGenParams(patch, c.gen);
  cChanged();
  return { ok: true };
});

ipcMain.handle('app:c-add-clips', async () => {
  const opts: Electron.OpenDialogOptions = {
    title: 'Deck C に素材を追加',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video / Image', extensions: MEDIA_EXTENSIONS }],
  };
  const res = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts);
  if (res.canceled) return { ok: true };
  let last: string | null = null;
  for (const p of res.filePaths) {
    const clip = makeClip(p);
    if (!clip) continue;
    if (!c.clips.some((x) => x.id === clip.id)) c.clips.push(clip);
    last = clip.id;
  }
  if (last) {
    c.clipId = last; // select what was just added
    c.source = 'file';
  }
  cChanged();
  return { ok: true };
});

ipcMain.handle('app:c-remove-clip', (_e, id: string) => {
  const i = c.clips.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: 'unknown clip' };
  c.clips.splice(i, 1);
  if (c.clipId === id) c.clipId = c.clips[Math.min(i, c.clips.length - 1)]?.id ?? null;
  cChanged();
  return { ok: true };
});

ipcMain.handle('app:set-output', (_e, patch: Partial<OutputSettings>) => {
  output = clampOutput(patch, output);
  fs.promises
    .writeFile(settingsFile(), JSON.stringify(output))
    .catch((): void => undefined);
  pushState();
  sendStatus();
  return { ok: true };
});

ipcMain.handle('app:get-status', () => appStatus());

// ---- IPC: Google login ---------------------------------------------------------------

// Reload both player guests so they pick up the changed session cookies.
function reloadGuests() {
  for (const id of CHANNELS) guestOf(channels[id])?.reload();
}

function sendLoginState(state: LoginState) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:login-state', state);
  }
}

ipcMain.handle('app:google-login', () => {
  openGoogleLogin(mainWindow, (state) => {
    sendLoginState(state);
    if (state.loggedIn) reloadGuests();
  });
  return { ok: true };
});

ipcMain.handle('app:google-logout', async () => {
  const state = await logout();
  sendLoginState(state);
  reloadGuests();
  return state;
});

ipcMain.handle('app:get-login-state', () => getLoginState());

// ---- IPC: projector ----------------------------------------------------------------

function onProjectorChanged() {
  syncRectPolling();
  for (const id of CHANNELS) refreshVideoRect(channels[id]);
  sendStatus();
}

ipcMain.handle('app:projector-open', (_e, displayId: number) => {
  const res = openProjector(displayId, loadRenderer, onProjectorChanged);
  onProjectorChanged();
  return res;
});

ipcMain.handle('app:projector-close', () => {
  closeProjector();
  onProjectorChanged();
  return { ok: true };
});

// Called by the projector window itself.
ipcMain.handle('app:projector-get-state', () => projectorState());

// A one-shot media source id that lets the *calling* window (the projector)
// capture a deck's guest with getUserMedia({ chromeMediaSource: 'tab' }).
ipcMain.handle('app:projector-source-id', (e, channelId: ChannelId) => {
  const ch = getChannel(channelId);
  const guest = ch ? guestOf(ch) : null;
  if (!guest) return null;
  try {
    return guest.getMediaSourceId(e.sender);
  } catch {
    return null;
  }
});

ipcMain.on('app:projector-stats', (_e, stats: ProjectorStats) => {
  if (setProjectorStats(stats)) sendStatus();
});

// ---- Startup ---------------------------------------------------------------------

// Packaged-build smoke test (CI): U2S_SELFTEST=1 loads the UI and checks that
// tab-capture source ids can be issued, prints the result as JSON and exits.
function runSelfTest() {
  createWindow();
  const win = mainWindow!;
  win.webContents.once('did-finish-load', () => {
    const probe = new BrowserWindow({ show: false });
    probe
      .loadURL('data:text/html,<p>probe</p>')
      .then(() => {
        const id = probe.webContents.getMediaSourceId(win.webContents);
        const ok = typeof id === 'string' && id.length > 0;
        console.log(
          `U2S_SELFTEST ${JSON.stringify({ packaged: app.isPackaged, sourceId: ok })}`,
        );
        app.exit(ok ? 0 : 1);
      })
      .catch((err) => {
        console.log(`U2S_SELFTEST ${JSON.stringify({ error: String(err) })}`);
        app.exit(1);
      });
  });
}

app.on('ready', () => {
  output = loadOutput();
  loadC();
  handleMediaScheme((id) => c.clips.find((x) => x.id === id) ?? null);
  if (process.env.U2S_SELFTEST === '1') {
    runSelfTest();
    return;
  }
  installLoginHeaderFilter();
  createWindow();
  setPerfExtra(() => ({ projector: projectorStatus().stats }));
  startPerf(); // no-op unless U2S_PERF=1
  if (process.env.U2S_BENCH === 'vjproj' && mainWindow) {
    runBench(mainWindow).catch((err) => {
      console.error('U2S_BENCH failed', err);
      app.exit(1);
    });
  }
  // Keep the display list current, and drop the projector if it is unplugged.
  screen.on('display-added', () => sendStatus());
  screen.on('display-removed', (_e, d) => {
    handleDisplayRemoved(d.id);
    onProjectorChanged();
  });
});

app.on('window-all-closed', () => {
  stopFades();
  if (rectTimer) clearInterval(rectTimer);
  rectTimer = null;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
