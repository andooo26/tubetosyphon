// ---- YouTube page treatment -------------------------------------------------
// Injected into each player <webview> by main.ts on every navigation.

// A YouTube *playback* URL (watch / shorts / youtu.be) as opposed to a browse
// page (home, search results, channel). Only playback pages get the
// "video only" treatment and reach the projector; browse pages stay full-UI and
// project black so the user can navigate in-app without leaking the page.
export function isWatchUrl(url: string): boolean {
  return /youtube\.com\/watch|youtube\.com\/shorts\/|youtu\.be\//.test(url);
}

// ---- YouTube "video only" + best-effort ad handling -----------------------
// Injected into the guest <webview> on every navigation. CSS collapses the
// watch page down to just the player (no masthead / sidebar / comments), so
// the captured viewport is clean video. JS auto-clicks "Skip Ad" and fast-forwards
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
export const CHROME_HIDE_CSS = `
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

export const AD_SKIP_JS = `
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
// aspect ratio fitted inside the viewport. Projecting only this region (instead
// of the whole viewport) avoids double letterboxing. Null if no sized video.
export const VIDEO_RECT_JS = `
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

