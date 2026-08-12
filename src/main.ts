import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { SyphonManager } from './syphon';
import type { Quality } from './preload';
import {
  DEFAULT_GEN_PARAMS,
  clampGenParams,
  type GenParams,
} from './gen/params';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// ---- Output constants (spec: 1080p fixed, ~60fps) -------------------------
const OUT_W = 1920;
const OUT_H = 1080;
// Live frames are pushed by beginFrameSubscription at the compositor's paint
// cadence (up to display refresh). This slow timer only drives the generated
// static frames (red test / black-while-browsing) and the video-rect refresh.
const STATIC_TICK_MS = 150;

// ---- Channels (two independent players: left + right) ---------------------
// Each channel drives its own <webview> guest, its own Syphon server, and its
// own capture loop, so the two sides publish two separate Syphon sources.
type ChannelId = 'left' | 'right';

interface Channel {
  readonly id: ChannelId;
  readonly serverName: string;
  readonly syphon: SyphonManager;
  guestContentsId: number | null;
  onWatchPage: boolean; // capture real video? false only on a YouTube browse page (-> black).
  isYouTube: boolean; // current guest page is YouTube (video fills the viewport via our CSS).
  // Drawn-video region to capture, in guest CSS px, plus the viewport CSS size it
  // was measured against (so onFrame can rescale it to the subscription image's
  // device-pixel dimensions — Retina makes them differ).
  videoRect: {
    x: number;
    y: number;
    width: number;
    height: number;
    viewW: number;
    viewH: number;
  } | null;
  videoRectStamp: number; // when videoRect was last measured (throttle the JS round-trip)
  captureTimer: NodeJS.Timeout | null; // slow timer: static (red/black) frames + rect refresh
  subscribedContentsId: number | null; // guest we've called beginFrameSubscription on
  rectRefreshing: boolean; // a VIDEO_RECT_JS round-trip is in flight
  inFlight: boolean; // capturePage is async; skip a tick if the last is still running.
  testFrame: boolean; // publish a solid red frame instead of the webview.
  hideControls: boolean; // hide YouTube's playback bar + captions.
  quality: Quality; // target YouTube playback quality (re-asserted by the injected JS).
  hideCssKey: string | null; // insertCSS key for the CURRENT page (invalidated on navigation).
  framesThisSecond: number;
  lastFpsStamp: number;
  measuredFps: number;
  frameBuf: Uint8Array | null; // reused OUT_W*OUT_H*4 RGBA letterbox canvas (grown never shrunk)
  lbW: number; // last letterboxed video width (to know when black bars must be re-cleared)
  lbH: number; // last letterboxed video height
  latest: Uint8Array | null; // most recent OUT_W*OUT_H RGBA frame (for the VJ mixer to blend)
}

function makeChannel(id: ChannelId, serverName: string): Channel {
  return {
    id,
    serverName,
    syphon: new SyphonManager(serverName),
    guestContentsId: null,
    onWatchPage: false,
    isYouTube: false,
    videoRect: null,
    videoRectStamp: 0,
    captureTimer: null,
    subscribedContentsId: null,
    rectRefreshing: false,
    inFlight: false,
    testFrame: false,
    hideControls: true,
    quality: 'highest',
    hideCssKey: null,
    framesThisSecond: 0,
    lastFpsStamp: Date.now(),
    measuredFps: 0,
    frameBuf: null,
    lbW: -1,
    lbH: -1,
    latest: null,
  };
}

const channels: Record<ChannelId, Channel> = {
  left: makeChannel('left', 'URLtoSyphon-L'),
  right: makeChannel('right', 'URLtoSyphon-R'),
};

function getChannel(id: unknown): Channel | null {
  return id === 'left' || id === 'right' ? channels[id] : null;
}

// ---- VJ mode --------------------------------------------------------------
// One combined Syphon output that crossfades between the two players. In 'vj'
// mode the per-channel Syphon servers are stopped; both channels keep capturing
// (into ch.latest) and a single mixer blends L/R by vjAlpha and publishes to one
// server. In 'dual' mode each channel publishes to its own server as before.
type Mode = 'dual' | 'vj' | 'gen';
let mode: Mode = 'dual';
let vjAlpha = 0; // 0 = full A (left), 1 = full B (right)
// Active crossfade animation (Cut A/B fade over a duration instead of jumping).
let vjAnim: { from: number; to: number; start: number; dur: number } | null = null;
const vjSyphon = new SyphonManager('TubeToSyphon');
let vjTimer: NodeJS.Timeout | null = null;
let vjBuf: Uint8Array | null = null; // OUT_W*OUT_H*4 RGBA blend scratch
let vjFramesThisSecond = 0;
let vjLastFpsStamp = Date.now();
let vjMeasuredFps = 0;
const VJ_INTERVAL_MS = 16; // ~60fps output

let mainWindow: BrowserWindow | null = null;

// ---- 汎用 (generic) mode --------------------------------------------------
// No video source at all: a hidden 1920x1080 **offscreen** BrowserWindow renders
// the generative sketch (src/gen/sketch.ts, same bundle as the UI, loaded with
// ?gen=1) driven by BPM + genre, and every painted frame is published to a
// single Syphon server. Offscreen rendering hands us the finished 1920x1080
// BGRA bitmap directly, so there is no crop/letterbox step here.
const genSyphon = new SyphonManager('TubeToSyphon-GEN');
let genWindow: BrowserWindow | null = null;
let genParams: GenParams = { ...DEFAULT_GEN_PARAMS, beatEpoch: Date.now() };
let genFramesThisSecond = 0;
let genLastFpsStamp = Date.now();
let genMeasuredFps = 0;
const GEN_FPS = 60;

// A YouTube *playback* URL (watch / shorts / youtu.be) as opposed to a browse
// page (home, search results, channel). Only playback pages get the
// "video only" treatment + real Syphon output; browse pages stay full-UI and
// output black so the user can navigate in-app without leaking the page.
function isWatchUrl(url: string): boolean {
  return /youtube\.com\/watch|youtube\.com\/shorts\/|youtu\.be\//.test(url);
}

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

// Player-only CSS re-asserted from JS. insertCSS (below) is the fast path, but
// on a fresh watch-page load the single insertion sometimes lands on the wrong
// navigation event (YouTube is a SPA that re-navigates in-page + rebuilds the
// DOM), so ~1 load in N the full page chrome slips through. Injecting the same
// rules as a persistent <style> that the interval re-adds if missing makes the
// "video only" layout self-healing regardless of navigation timing.
const PLAYER_ONLY_JS_LITERAL = JSON.stringify(PLAYER_ONLY_CSS);

const AD_SKIP_JS = `
  (function () {
    if (window.__u2s_adskip) return;
    window.__u2s_adskip = true;
    var PLAYER_ONLY_CSS = ${PLAYER_ONLY_JS_LITERAL};
    function isWatchPage() {
      return /youtube\\.com\\/watch|youtube\\.com\\/shorts\\/|youtu\\.be\\//.test(location.href);
    }
    function ensurePlayerOnlyStyle() {
      var el = document.getElementById('__u2s_player_only');
      // On browse pages (home/search/channel) leave the full YouTube UI intact
      // so the user can navigate; only collapse to "video only" on watch pages.
      if (!isWatchPage()) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        return;
      }
      if (!el) {
        el = document.createElement('style');
        el.id = '__u2s_player_only';
        el.textContent = PLAYER_ONLY_CSS;
      }
      // Keep it last in <head> so it always wins the cascade, and re-attach if
      // YouTube's renderer removed it.
      var head = document.head || document.documentElement;
      if (el.parentNode !== head || head.lastChild !== el) {
        head.appendChild(el);
      }
    }
    ensurePlayerOnlyStyle();
    setInterval(function () {
      ensurePlayerOnlyStyle();
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
      // Enforce the target playback quality (set via window.__u2s_targetQuality
      // from the UI). YouTube may downgrade on its own (ABR), so we re-assert it
      // every tick. 'auto' means leave YouTube's ABR alone.
      try {
        var target = window.__u2s_targetQuality || 'highest';
        if (target !== 'auto') {
          var p = document.getElementById('movie_player');
          if (p && p.getAvailableQualityLevels) {
            var levels = p.getAvailableQualityLevels(); // highest -> lowest, no 'auto'
            if (levels && levels.length) {
              var order = ['highres','hd2160','hd1440','hd1080','hd720','large','medium','small','tiny'];
              var pick;
              if (target === 'highest') {
                pick = levels[0];
              } else {
                var ti = order.indexOf(target);
                // best available AT OR BELOW the target (levels is highest-first).
                for (var i = 0; i < levels.length; i++) {
                  if (order.indexOf(levels[i]) >= ti) { pick = levels[i]; break; }
                }
                if (!pick) pick = levels[levels.length - 1]; // only higher exist -> lowest available
              }
              if (pick) {
                if (p.setPlaybackQualityRange) p.setPlaybackQualityRange(pick, pick);
                if (p.setPlaybackQuality) p.setPlaybackQuality(pick);
              }
            }
          }
        }
      } catch (e) {}
    }, 400);
    window.dispatchEvent(new Event('resize'));
  })();
`;

// Returns the on-screen rectangle (CSS px, relative to the guest viewport) where
// the video pixels are actually drawn. Our injected CSS makes the <video> fill
// the whole viewport with object-fit:contain, so the drawn region is the video's
// aspect ratio fitted inside the viewport. Capturing exactly this region (instead
// of the whole webview pane) avoids double letterboxing. Null if no sized video.
const VIDEO_RECT_JS = `
  (function () {
    var v = document.querySelector('video');
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    var elW = window.innerWidth, elH = window.innerHeight;
    if (!elW || !elH) return null;
    var vAR = v.videoWidth / v.videoHeight, eAR = elW / elH;
    var w, h;
    if (vAR > eAR) { w = elW; h = elW / vAR; } else { h = elH; w = elH * vAR; }
    return {
      x: Math.round((elW - w) / 2), y: Math.round((elH - h) / 2),
      width: Math.round(w), height: Math.round(h),
      viewW: elW, viewH: elH
    };
  })()
`;

function setupYouTubeCleanup(guest: Electron.WebContents, ch: Channel) {
  const apply = () => {
    const url = guest.getURL();
    const isYouTube = /youtube\.com|youtu\.be/.test(url);
    // Output black only on YouTube *browse* pages. Non-YouTube URLs (arbitrary
    // video pages) are always captured; YouTube watch/shorts pages are captured.
    ch.onWatchPage = !isYouTube || isWatchUrl(url);
    ch.isYouTube = isYouTube;
    // Force a fresh video-rect measurement for the new page.
    ch.videoRect = null;
    ch.videoRectStamp = 0;
    if (!isYouTube) return;
    // Seed the target quality before the injected interval starts reading it.
    pushQuality(ch);
    // The persistent-<style> injector (AD_SKIP_JS) applies/removes the
    // "video only" layout itself based on the live URL, so it self-heals across
    // SPA navigations and never leaks onto browse pages. No eager insertCSS here.
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
  guest.on('did-navigate', apply);
}

// Push the channel's target quality into its guest. The injected interval reads
// window.__u2s_targetQuality every tick and re-asserts it, so this takes effect
// live (no reload) and survives ABR downgrades.
function pushQuality(ch: Channel) {
  if (ch.guestContentsId == null) return;
  const guest = webContents.fromId(ch.guestContentsId);
  if (!guest || guest.isDestroyed()) return;
  guest
    .executeJavaScript(
      `window.__u2s_targetQuality=${JSON.stringify(ch.quality)};`,
    )
    .catch((): void => {});
}

// Load the renderer bundle into `win`. `search` selects which root it mounts
// ('' = the normal UI, 'gen=1' = the offscreen generative canvas).
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Enable the <webview> tag used to render YouTube etc.
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The hidden generative window is a BrowserWindow too, so it would keep
  // 'window-all-closed' from ever firing; tear it down with the UI.
  mainWindow.on('closed', () => {
    mainWindow = null;
    stopGen();
  });

  loadRenderer(mainWindow);
};

// ---- Capture loop (per channel) -------------------------------------------

// Shared opaque-black BGRA frame, published while the guest is on a YouTube
// browse page (so receivers never see the search/home UI, only real video).
let blackFrame: Uint8Array | null = null;
function getBlackFrame(): Uint8Array {
  if (!blackFrame) {
    blackFrame = new Uint8Array(OUT_W * OUT_H * 4);
    for (let i = 3; i < blackFrame.length; i += 4) blackFrame[i] = 255; // alpha
  }
  return blackFrame;
}

let redFrame: Uint8Array | null = null;
function getRedFrame(): Uint8Array {
  // RGBA solid red (published via publishRGBA — no swizzle).
  if (!redFrame) {
    redFrame = new Uint8Array(OUT_W * OUT_H * 4);
    for (let i = 0; i < redFrame.length; i += 4) {
      redFrame[i] = 255; // R
      redFrame[i + 3] = 255; // A
    }
  }
  return redFrame;
}

// Route one finished OUT_W*OUT_H RGBA frame for a channel. In 'dual' mode it goes
// straight to the channel's own Syphon server; in 'vj' mode it is just recorded
// as ch.latest for the mixer (which publishes the blended result to one server).
function outputChannelFrame(ch: Channel, frame: Uint8Array) {
  ch.latest = frame;
  if (mode === 'dual') {
    if (ch.syphon.publishRGBA(frame, OUT_W, OUT_H)) countFrame(ch);
  }
}

// Composite a BGRA source image (srcW*srcH) centred, at 1:1, onto a black
// OUT_W*OUT_H canvas, converting BGRA->RGBA in the SAME pass so the result is
// ready to publish without a second full-buffer swizzle. The black bars are only
// re-cleared when the video geometry changes (they are otherwise untouched from
// the previous frame), so a steady-state frame does exactly one pass over just
// the video pixels. Rows/cols are clamped so an unexpectedly large source (e.g.
// a Retina scaleFactor slip) can never overrun the canvas.
function letterbox(ch: Channel, src: Uint8Array, srcW: number, srcH: number): Uint8Array {
  const size = OUT_W * OUT_H * 4;
  let cleared = false;
  if (!ch.frameBuf || ch.frameBuf.length < size) {
    ch.frameBuf = new Uint8Array(size);
    cleared = true; // fresh buffer needs its bars painted
  }
  const canvas = ch.frameBuf;

  const w = Math.min(srcW, OUT_W);
  const h = Math.min(srcH, OUT_H);
  // Re-paint the opaque-black bars (RGBA 0,0,0,255) only when the video region
  // changed shape; otherwise last frame's bars are already correct.
  if (!cleared && (w !== ch.lbW || h !== ch.lbH)) cleared = true;
  if (cleared) {
    canvas.fill(0);
    for (let i = 3; i < size; i += 4) canvas[i] = 255;
    ch.lbW = w;
    ch.lbH = h;
  }

  const offX = (OUT_W - w) >> 1;
  const offY = (OUT_H - h) >> 1;
  const srcStride = srcW * 4;
  const dstStride = OUT_W * 4;
  for (let y = 0; y < h; y++) {
    let s = y * srcStride;
    let d = (offY + y) * dstStride + offX * 4;
    for (let x = 0; x < w; x++) {
      canvas[d] = src[s + 2]; // R <- B
      canvas[d + 1] = src[s + 1]; // G
      canvas[d + 2] = src[s]; // B <- R
      canvas[d + 3] = 255; // A (opaque; source alpha is always 255 here)
      s += 4;
      d += 4;
    }
  }
  return canvas;
}

// Process ONE painted frame delivered by beginFrameSubscription. `image` is the
// full webview surface; we crop to the drawn-video rect (avoids double
// letterboxing), scale-to-fit + letterbox onto 1920x1080, and publish. Fully
// synchronous — no capturePage round-trip, so it runs at the compositor's paint
// cadence instead of stalling on polled GPU readbacks.
function onFrame(ch: Channel, image: Electron.NativeImage) {
  // Static modes (test pattern / browsing) are driven by the slow timer so they
  // work even when the page isn't painting; ignore live paints for them.
  if (ch.testFrame || !ch.onWatchPage) return;
  try {
    if (image.isEmpty()) return;

    // On YouTube our CSS makes the <video> fill the viewport (object-fit:contain),
    // so crop to ONLY the drawn video rectangle (measured off-thread, cached on
    // ch.videoRect). Clamp to the surface bounds so a stale rect can't overrun.
    let img = image;
    const full = image.getSize();
    const rect = ch.isYouTube ? ch.videoRect : null;
    if (rect && rect.viewW > 0 && rect.viewH > 0) {
      // The subscription image is in device px (Retina => 2x the CSS px the rect
      // was measured in). Rescale the rect by the image/viewport ratio so the crop
      // lands on the real video region, not a corner of it.
      const sx = full.width / rect.viewW;
      const sy = full.height / rect.viewH;
      const x = Math.max(0, Math.min(Math.round(rect.x * sx), full.width - 1));
      const y = Math.max(0, Math.min(Math.round(rect.y * sy), full.height - 1));
      const w = Math.max(1, Math.min(Math.round(rect.width * sx), full.width - x));
      const h = Math.max(1, Math.min(Math.round(rect.height * sy), full.height - y));
      img = image.crop({ x, y, width: w, height: h });
    }

    // Scale UNIFORMLY to fit within OUT_W x OUT_H, preserving aspect ratio, then
    // letterbox onto the fixed 1920x1080 canvas (keeps every video at correct
    // proportions regardless of the source's aspect).
    const src = img.getSize();
    if (src.width <= 0 || src.height <= 0) return;
    const scale = Math.min(OUT_W / src.width, OUT_H / src.height);
    const dw = Math.max(1, Math.round(src.width * scale));
    const dh = Math.max(1, Math.round(src.height * scale));
    const resized = img.resize({ width: dw, height: dh, quality: 'good' });
    // toBitmap() returns BGRA. Force scaleFactor 1.0 so the buffer is exactly
    // dw*dh px regardless of the display's Retina scale factor.
    const bgra = resized.toBitmap({ scaleFactor: 1.0 });
    // Guard against a scaleFactor slip: derive the true pixel size from length.
    const px = bgra.length / 4;
    let bw = dw;
    let bh = dh;
    if (px !== dw * dh && dw > 0) {
      const k = Math.round(Math.sqrt(px / (dw * dh)));
      if (k > 1) {
        bw = dw * k;
        bh = dh * k;
      }
    }
    const frame = letterbox(ch, bgra, bw, bh);
    outputChannelFrame(ch, frame);
  } catch (err) {
    sendStatus({ error: err instanceof Error ? err.message : String(err) });
  }
}

// Slow timer (~STATIC_TICK_MS): publishes the generated static frames (red test
// pattern, black while browsing) which have no paints to ride on, and refreshes
// the cached drawn-video rect off-thread for the frame-subscription path.
function staticTick(ch: Channel) {
  if (ch.testFrame) {
    outputChannelFrame(ch, getRedFrame());
    return;
  }
  if (!ch.onWatchPage) {
    outputChannelFrame(ch, getBlackFrame());
    return;
  }
  // Watch page: live frames arrive via onFrame(); just keep the rect fresh.
  if (ch.isYouTube) refreshVideoRect(ch);
}

// Measure the drawn-video rect in the guest (throttled ~2x/sec) and cache it for
// onFrame() to crop with. Fire-and-forget so it never blocks a paint.
function refreshVideoRect(ch: Channel) {
  const now = Date.now();
  if (ch.rectRefreshing || (ch.videoRect && now - ch.videoRectStamp < 500)) return;
  if (ch.guestContentsId == null) return;
  const guest = webContents.fromId(ch.guestContentsId);
  if (!guest || guest.isDestroyed()) return;
  ch.rectRefreshing = true;
  ch.videoRectStamp = now;
  guest
    .executeJavaScript(VIDEO_RECT_JS)
    .then((r: Channel['videoRect']) => {
      ch.videoRect = r && r.width > 0 && r.height > 0 ? r : null;
    })
    .catch(() => {
      /* keep the previous rect */
    })
    .finally(() => {
      ch.rectRefreshing = false;
    });
}

// ---- Frame subscription (per channel) -------------------------------------

function subscribeGuest(ch: Channel) {
  if (ch.guestContentsId == null) return;
  if (ch.subscribedContentsId === ch.guestContentsId) return;
  unsubscribeGuest(ch); // drop any stale subscription first
  const guest = webContents.fromId(ch.guestContentsId);
  if (!guest || guest.isDestroyed()) return;
  try {
    // onlyDirty=false: deliver full frames so a crop always has complete pixels.
    guest.beginFrameSubscription(false, (image) => onFrame(ch, image));
    ch.subscribedContentsId = ch.guestContentsId;
  } catch (err) {
    sendStatus({ error: err instanceof Error ? err.message : String(err) });
  }
}

function unsubscribeGuest(ch: Channel) {
  if (ch.subscribedContentsId == null) return;
  const guest = webContents.fromId(ch.subscribedContentsId);
  try {
    guest?.endFrameSubscription();
  } catch {
    /* guest already gone */
  }
  ch.subscribedContentsId = null;
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

// ---- VJ mixer -------------------------------------------------------------

function countVjFrame() {
  vjFramesThisSecond++;
  const now = Date.now();
  if (now - vjLastFpsStamp >= 1000) {
    vjMeasuredFps = vjFramesThisSecond;
    vjFramesThisSecond = 0;
    vjLastFpsStamp = now;
    sendStatus({});
  }
}

// Blend two OUT_W*OUT_H RGBA frames into dst: dst = a*(1-t) + b*t.
function blend(dst: Uint8Array, a: Uint8Array, b: Uint8Array, t: number) {
  const it = 1 - t;
  const n = OUT_W * OUT_H * 4;
  for (let i = 0; i < n; i++) {
    dst[i] = (a[i] * it + b[i] * t) | 0;
  }
}

// Publish one mixed frame. Skips the per-pixel blend entirely at the fader ends
// (the common "hold on A/B" case) — only a live crossfade pays the blend cost.
function vjTick() {
  // Advance an in-progress crossfade animation (smoothstep for an ease-in/out
  // "slow" feel). Manual fader input cancels it (see set-vj-alpha).
  if (vjAnim) {
    const t = Math.min(1, (Date.now() - vjAnim.start) / vjAnim.dur);
    const e = t * t * (3 - 2 * t); // smoothstep
    vjAlpha = vjAnim.from + (vjAnim.to - vjAnim.from) * e;
    if (t >= 1) {
      vjAlpha = vjAnim.to;
      vjAnim = null;
    }
    sendStatus({}); // keep the UI fader in sync during the fade
  }

  const black = getBlackFrame();
  const L = channels.left.latest ?? black;
  const R = channels.right.latest ?? black;
  let out: Uint8Array;
  if (vjAlpha <= 0.001) {
    out = L;
  } else if (vjAlpha >= 0.999) {
    out = R;
  } else {
    if (!vjBuf || vjBuf.length < OUT_W * OUT_H * 4) {
      vjBuf = new Uint8Array(OUT_W * OUT_H * 4);
    }
    blend(vjBuf, L, R, vjAlpha);
    out = vjBuf;
  }
  if (vjSyphon.publishRGBA(out, OUT_W, OUT_H)) countVjFrame();
}

function startVjTimer() {
  if (vjTimer) return;
  vjLastFpsStamp = Date.now();
  vjFramesThisSecond = 0;
  vjTimer = setInterval(vjTick, VJ_INTERVAL_MS);
}

function stopVjTimer() {
  if (vjTimer) {
    clearInterval(vjTimer);
    vjTimer = null;
  }
  vjMeasuredFps = 0;
}

// ---- 汎用 (generic) generative output --------------------------------------

function countGenFrame() {
  genFramesThisSecond++;
  const now = Date.now();
  if (now - genLastFpsStamp >= 1000) {
    genMeasuredFps = genFramesThisSecond;
    genFramesThisSecond = 0;
    genLastFpsStamp = now;
    sendStatus({});
  }
}

// Push the current params into the offscreen window (and mirror them to the UI
// so its preview draws exactly the same thing).
function pushGenParams() {
  genWindow?.webContents.send('app:gen-params', genParams);
}

function createGenWindow() {
  if (genWindow && !genWindow.isDestroyed()) return;
  genWindow = new BrowserWindow({
    width: OUT_W,
    height: OUT_H,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      // The window is never visible, so Chromium would otherwise throttle
      // requestAnimationFrame down to a crawl and the output would stutter.
      backgroundThrottling: false,
    },
  });
  const wc = genWindow.webContents;
  wc.setFrameRate(GEN_FPS);
  // Electron has changed this event's argument list across versions (dirty-rect
  // + image vs. a details object), so pick the NativeImage out of whatever
  // arrives instead of relying on a fixed position.
  wc.on('paint', (...args: unknown[]) => {
    const image = args.find(
      (a): a is Electron.NativeImage =>
        !!a && typeof (a as Electron.NativeImage).getBitmap === 'function',
    );
    if (image) onGenPaint(image);
  });
  wc.on('did-finish-load', pushGenParams);
  genWindow.on('closed', () => {
    genWindow = null;
  });
  loadRenderer(genWindow, 'gen=1');
}

function onGenPaint(image: Electron.NativeImage) {
  if (mode !== 'gen' || !genSyphon.isRunning) return;
  try {
    if (image.isEmpty()) return;
    const size = image.getSize();
    // getBitmap() hands back the underlying BGRA pixels with no copy (unlike
    // toBitmap()), which matters at 1080p60 — we publish synchronously here, so
    // the "don't hold on to it" caveat is satisfied. Cast: Electron's own .d.ts
    // mistypes the return as void.
    const bgra = (image as unknown as { getBitmap(): Buffer }).getBitmap();
    // Guard against a scale-factor slip (the bitmap can come back at 2x the
    // logical size): derive the true pixel dimensions from the buffer length.
    let w = size.width;
    let h = size.height;
    const px = bgra.length / 4;
    if (w > 0 && h > 0 && px !== w * h) {
      const k = Math.round(Math.sqrt(px / (w * h)));
      if (k > 1) {
        w *= k;
        h *= k;
      }
    }
    if (w <= 0 || h <= 0 || bgra.length < w * h * 4) return;
    if (genSyphon.publishBGRA(bgra, w, h)) countGenFrame();
  } catch (err) {
    sendStatus({ error: err instanceof Error ? err.message : String(err) });
  }
}

function startGen(): { ok: boolean; error?: string } {
  if (!genSyphon.start()) {
    return { ok: false, error: genSyphon.error ?? 'gen start failed' };
  }
  genLastFpsStamp = Date.now();
  genFramesThisSecond = 0;
  createGenWindow();
  pushGenParams();
  return { ok: true };
}

function stopGen() {
  if (genWindow && !genWindow.isDestroyed()) genWindow.destroy();
  genWindow = null;
  genSyphon.dispose();
  genMeasuredFps = 0;
}

// Switch between 'dual' and 'vj'. Entering VJ stops the per-channel servers,
// starts the single mixed server, and makes sure both channels are capturing.
// Leaving VJ tears the mixer down and stops capture (dual outputs start on demand).
function setMode(next: Mode): { ok: boolean; error?: string } {
  if (next === mode) return { ok: true };

  // Tear the previous mode down first — every mode owns its own Syphon
  // server(s), and only one mode's outputs may be live at a time.
  stopVjTimer();
  vjSyphon.dispose();
  stopGen();
  for (const ch of Object.values(channels)) {
    stopCapture(ch);
    ch.syphon.dispose();
  }

  if (next === 'vj') {
    if (!vjSyphon.start()) {
      return { ok: false, error: vjSyphon.error ?? 'vj start failed' };
    }
    mode = 'vj';
    for (const ch of Object.values(channels)) startCapture(ch);
    startVjTimer();
  } else if (next === 'gen') {
    // No capture at all in 汎用 mode: the players stay loaded but idle.
    mode = 'gen';
    const res = startGen();
    if (!res.ok) {
      mode = 'dual';
      sendStatus({});
      return res;
    }
  } else {
    // Dual: per-channel outputs start on demand via "Start Syphon".
    mode = 'dual';
  }
  sendStatus({});
  return { ok: true };
}

function startCapture(ch: Channel) {
  if (ch.captureTimer) return;
  ch.lastFpsStamp = Date.now();
  ch.framesThisSecond = 0;
  // Live frames come from the frame subscription; the timer only drives static
  // frames + rect refresh.
  ch.captureTimer = setInterval(() => staticTick(ch), STATIC_TICK_MS);
  subscribeGuest(ch);
}

function stopCapture(ch: Channel) {
  if (ch.captureTimer) {
    clearInterval(ch.captureTimer);
    ch.captureTimer = null;
  }
  unsubscribeGuest(ch);
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
    quality: ch.quality,
  };
}

function appStatus() {
  return {
    left: channelStatus(channels.left),
    right: channelStatus(channels.right),
    mode,
    vjAlpha,
    vj: {
      running: vjSyphon.isRunning,
      hasClients: vjSyphon.hasClients,
      fps: vjMeasuredFps,
      serverName: 'TubeToSyphon',
      error: vjSyphon.error,
    },
    gen: {
      running: genSyphon.isRunning,
      hasClients: genSyphon.hasClients,
      fps: genMeasuredFps,
      serverName: 'TubeToSyphon-GEN',
      error: genSyphon.error,
    },
    genParams,
  };
}

function sendStatus(extra: { error?: string }) {
  const status = appStatus();
  if (extra.error) {
    status.left = { ...status.left, error: extra.error };
    status.right = { ...status.right, error: extra.error };
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:status', status);
  }
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
    // If capture is already running, (re)attach the frame subscription to the
    // new guest webContents.
    if (ch.captureTimer) subscribeGuest(ch);
    return { ok: true };
  },
);

ipcMain.handle('app:start-output', (_e, channelId: ChannelId) => {
  const ch = getChannel(channelId);
  if (!ch) return { ok: false, error: 'unknown channel' };
  if (mode !== 'dual') return { ok: false, error: 'switch to Dual mode first' };
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

ipcMain.handle(
  'app:set-quality',
  (_e, channelId: ChannelId, quality: Quality) => {
    const ch = getChannel(channelId);
    if (!ch) return { ok: false, error: 'unknown channel' };
    ch.quality = quality;
    pushQuality(ch); // takes effect live; the injected interval re-asserts it
    sendStatus({});
    return { ok: true };
  },
);

ipcMain.handle('app:set-mode', (_e, next: Mode) => {
  if (next !== 'dual' && next !== 'vj' && next !== 'gen') {
    return { ok: false, error: 'bad mode' };
  }
  return setMode(next);
});

// Update the generative params (partial patch: the UI sends only what changed).
ipcMain.handle('app:set-gen-params', (_e, patch: Partial<GenParams>) => {
  if (!patch || typeof patch !== 'object') {
    return { ok: false, error: 'bad params' };
  }
  genParams = clampGenParams(patch, genParams);
  pushGenParams();
  sendStatus({});
  return { ok: true };
});

ipcMain.handle('app:set-vj-alpha', (_e, alpha: number) => {
  if (typeof alpha !== 'number' || !isFinite(alpha)) {
    return { ok: false, error: 'bad alpha' };
  }
  vjAnim = null; // manual fader wins; cancel any running fade
  vjAlpha = Math.min(1, Math.max(0, alpha));
  sendStatus({});
  return { ok: true };
});

// Animate the crossfade to `target` over `durationMs` (Cut A/B use ~1s).
ipcMain.handle('app:vj-fade', (_e, target: number, durationMs: number) => {
  if (typeof target !== 'number' || !isFinite(target)) {
    return { ok: false, error: 'bad target' };
  }
  const to = Math.min(1, Math.max(0, target));
  const dur = typeof durationMs === 'number' && durationMs > 0 ? durationMs : 0;
  if (dur === 0) {
    vjAnim = null;
    vjAlpha = to;
  } else {
    vjAnim = { from: vjAlpha, to, start: Date.now(), dur };
  }
  sendStatus({});
  return { ok: true };
});

ipcMain.handle('app:get-status', () => appStatus());

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  stopVjTimer();
  vjSyphon.dispose();
  stopGen();
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
