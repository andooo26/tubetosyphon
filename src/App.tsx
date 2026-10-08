import React, { useEffect, useRef, useState } from 'react';
import type { LoginState } from './preload';
import {
  DEFAULT_OUTPUT,
  EMPTY_DECK_STATS,
  PLAYER_PARTITION,
  type AppStatus,
  type ChannelId,
  type DeckStats,
  type DeckStatus,
  type OutputSettings,
  type Quality,
} from './shared';

/** True if the input looks like a URL (has a scheme or a bare domain), rather
 * than a free-text search query. */
function looksLikeUrl(s: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return true; // http://, https://, file://…
  // Bare domain like "youtu.be/…", "example.com/…" (no spaces, has a dotted host).
  return !/\s/.test(s) && /^[^\s/]+\.[^\s/]+/.test(s);
}

/**
 * Normalise the search-bar input into something loadable:
 *  - A YouTube video URL -> the normal **watch page** (not /embed/: many videos
 *    have embedding disabled and the embed player fails with "Error 153/150";
 *    the watch page has no such restriction).
 *  - Any other URL -> loaded as-is.
 *  - Free text (not a URL) -> a YouTube **search** so the user can pick a video.
 */
function toPlayableUrl(raw: string): string {
  const url = raw.trim();
  const yt =
    url.match(/[?&]v=([\w-]{11})/) ||
    url.match(/youtu\.be\/([\w-]{11})/) ||
    url.match(/youtube\.com\/embed\/([\w-]{11})/) ||
    url.match(/youtube\.com\/shorts\/([\w-]{11})/);
  if (yt) {
    return `https://www.youtube.com/watch?v=${yt[1]}`;
  }
  if (looksLikeUrl(url)) {
    // Add a scheme if it's a bare domain so the webview loads it correctly.
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  }
  // Free-text query -> YouTube search results page.
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(url)}`;
}

// Present a normal desktop Chrome UA so YouTube serves the full player (some
// videos/features are gated behind a recognised browser UA).
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const EMPTY_DECK: DeckStatus = {
  live: false,
  hideControls: true,
  quality: 'hd1080',
};

// UI label -> YouTube quality target (see Quality in preload).
const QUALITY_OPTIONS: { value: Quality; label: string }[] = [
  { value: 'highest', label: 'Max' },
  { value: 'auto', label: 'Auto' },
  { value: 'hd2160', label: '2160p' },
  { value: 'hd1440', label: '1440p' },
  { value: 'hd1080', label: '1080p' },
  { value: 'hd720', label: '720p' },
  { value: 'large', label: '480p' },
  { value: 'medium', label: '360p' },
];

const EMPTY_STATUS: AppStatus = {
  left: EMPTY_DECK,
  right: EMPTY_DECK,
  alpha: 0,
  fading: false,
  projector: {
    open: false,
    displayId: null,
    displays: [],
    stats: { left: EMPTY_DECK_STATS, right: EMPTY_DECK_STATS },
  },
  output: DEFAULT_OUTPUT,
};

// mm:ss (or h:mm:ss) for the transport time labels.
function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

interface VideoState {
  time: number;
  duration: number;
  paused: boolean;
  vw: number; // current decoded video width
  vh: number; // current decoded video height
  maxH: number; // max available resolution height (from YouTube quality levels)
}

function Player({
  channel,
  status,
  proj,
  projecting,
}: {
  channel: ChannelId;
  status: DeckStatus;
  proj: DeckStats;
  projecting: boolean;
}) {
  const [input, setInput] = useState('');
  const [loadedUrl, setLoadedUrl] = useState('');
  const webviewRef = useRef<HTMLElement | null>(null);

  // Custom transport (native YouTube controls are hidden). The <webview> lives
  // in this renderer, so we drive the <video> element directly with
  // executeJavaScript — no main-process round-trip needed.
  const [video, setVideo] = useState<VideoState>({
    time: 0,
    duration: 0,
    paused: true,
    vw: 0,
    vh: 0,
    maxH: 0,
  });
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubRef = useRef(false);

  const runInGuest = async <T,>(code: string): Promise<T | null> => {
    const wv = webviewRef.current as unknown as {
      executeJavaScript?: (c: string) => Promise<T>;
    } | null;
    if (!wv || typeof wv.executeJavaScript !== 'function') return null;
    try {
      return await wv.executeJavaScript(code);
    } catch {
      return null;
    }
  };

  // Register this webview's contentsId with main (page treatment + capture).
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onReady = () => {
      const id = (
        wv as unknown as { getWebContentsId?: () => number }
      ).getWebContentsId?.();
      if (typeof id === 'number') window.api.registerGuest(channel, id);
    };
    // Navigation from inside the page (or a reload) also counts as a source.
    const onNavigate = (e: Event) => {
      const url = (e as Event & { url?: string }).url;
      if (url && !url.startsWith('about:')) setLoadedUrl(url);
    };
    wv.addEventListener('dom-ready', onReady);
    wv.addEventListener('did-navigate', onNavigate);
    return () => {
      wv.removeEventListener('dom-ready', onReady);
      wv.removeEventListener('did-navigate', onNavigate);
    };
  }, [channel]);

  // Poll the guest <video> state for the transport bar.
  useEffect(() => {
    const id = setInterval(async () => {
      if (scrubRef.current) return;
      const s = await runInGuest<VideoState | null>(
        '(()=>{const v=document.querySelector("video");if(!v)return null;' +
          'var p=document.getElementById("movie_player");' +
          'var lv=(p&&p.getAvailableQualityLevels)?p.getAvailableQualityLevels():[];' +
          'var map={highres:4320,hd2160:2160,hd1440:1440,hd1080:1080,hd720:720,large:480,medium:360,small:240,tiny:144};' +
          'var maxH=0;for(var i=0;i<lv.length;i++){var h=map[lv[i]]||0;if(h>maxH)maxH=h;}' +
          'return {time:v.currentTime,duration:(isFinite(v.duration)?v.duration:0),paused:v.paused,' +
          'vw:v.videoWidth||0,vh:v.videoHeight||0,maxH:maxH};})()',
      );
      if (s) setVideo(s);
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Navigate the guest webview through a SINGLE source of truth: the imperative
  // loadURL (with a src-attribute fallback before the guest is attached). Do NOT
  // also bind the `src` prop — mixing the two fires two navigations that race to
  // the same URL and the first aborts with ERR_ABORTED (-3). loadURL also
  // re-navigates to an identical URL, so e.g. "YouTube" works after in-app browsing.
  const navigate = (url: string) => {
    setLoadedUrl(url);
    const wv = webviewRef.current as unknown as {
      loadURL?: (u: string) => Promise<void>;
      getWebContentsId?: () => number;
      src?: string;
    } | null;
    if (!wv) return;
    let attached = false;
    try {
      attached = typeof wv.getWebContentsId === 'function' && wv.getWebContentsId() > 0;
    } catch {
      attached = false;
    }
    if (attached && typeof wv.loadURL === 'function') {
      wv.loadURL(url).catch((): void => undefined);
    } else {
      wv.src = url; // initial load before the guest webContents exists
    }
  };

  const play = () => {
    if (!input.trim()) return;
    navigate(toPlayableUrl(input));
  };

  const paste = () => {
    const text = window.api.readClipboard();
    if (text) setInput(text);
  };

  // Open YouTube's home page inside the webview so the user can search + pick a
  // video in-app. Browse pages keep the full YouTube UI; once a video's watch
  // page opens, the main process auto-collapses it to "video only".
  const browseYouTube = () => navigate('https://www.youtube.com');

  const goBack = () => {
    const wv = webviewRef.current as unknown as {
      canGoBack?: () => boolean;
      goBack?: () => void;
    } | null;
    if (wv && wv.canGoBack?.()) wv.goBack?.();
  };

  const changeQuality = async (q: Quality) => {
    const res = await window.api.setQuality(channel, q);
    if (!res.ok && res.error) alert(res.error);
  };

  const toggleHideControls = async () => {
    const res = await window.api.setHideControls(channel, !status.hideControls);
    if (!res.ok && res.error) alert(res.error);
  };

  const togglePlay = () =>
    runInGuest(
      "(()=>{const v=document.querySelector('video');if(v){v.paused?v.play():v.pause();}})()",
    );

  const seekTo = (t: number) =>
    runInGuest(
      `(()=>{const v=document.querySelector('video');if(v)v.currentTime=${t};})()`,
    );

  const skip = (delta: number) => {
    const dur = video.duration || 0;
    const next = Math.min(Math.max(video.time + delta, 0), dur || Infinity);
    setVideo((v) => ({ ...v, time: next }));
    seekTo(next);
  };

  const displayTime = scrub != null ? scrub : video.time;

  return (
    <div className="player">
      <header className="bar">
        <button onClick={goBack} disabled={!loadedUrl} title="Back">
          ←
        </button>
        <button onClick={browseYouTube}>YouTube</button>
        <input
          className="url"
          placeholder="Search YouTube, or paste a URL…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && play()}
        />
        <button onClick={paste}>Paste</button>
        <button onClick={play} disabled={!input.trim()}>
          Play
        </button>
      </header>

      <div className="bar sub">
        <button onClick={toggleHideControls}>
          {status.hideControls ? 'Chrome: off' : 'Chrome: on'}
        </button>
        <label className="quality" title="YouTube playback quality">
          Quality
          <select
            value={status.quality}
            onChange={(e) => changeQuality(e.target.value as Quality)}
          >
            {QUALITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <div className="statusline">
          <b className="chanid">{channel === 'left' ? 'A' : 'B'}</b>
          {video.vh > 0 && (
            <span title="current resolution / this video's max resolution">
              · {video.vh}p / {video.maxH > 0 ? `${video.maxH}p` : '—'}
            </span>
          )}
          {projecting && (
            <span
              title={
                proj.width
                  ? `projector capture ${proj.width}×${proj.height}`
                  : 'projector capture'
              }
            >
              · {status.live ? `out ${proj.fps} fps` : 'out black'}
            </span>
          )}
        </div>
      </div>
      {projecting && proj.error && (
        <div className="statusline error">{proj.error}</div>
      )}

      <div className="stage">
        <webview
          ref={webviewRef as React.Ref<HTMLElement>}
          partition={PLAYER_PARTITION}
          useragent={DESKTOP_UA}
          className="webview"
          {...({ allowpopups: 'true' } as Record<string, string>)}
        />
        {!loadedUrl && (
          <div className="placeholder">
            <span>No source · {channel === 'left' ? 'A' : 'B'}</span>
            <span>Search, paste a URL, or browse YouTube</span>
          </div>
        )}
      </div>

      <footer className="transport">
        <button className="skip" onClick={() => skip(-3)} disabled={!loadedUrl}>
          -3s
        </button>
        <button className="skip" onClick={() => skip(-1)} disabled={!loadedUrl}>
          -1s
        </button>
        <button
          className="skip"
          onClick={() => skip(-0.5)}
          disabled={!loadedUrl}
        >
          -0.5s
        </button>
        <button
          className="playpause"
          onClick={togglePlay}
          disabled={!loadedUrl}
          title={video.paused ? 'Play' : 'Pause'}
        >
          {video.paused ? '▶' : '❚❚'}
        </button>
        <button className="skip" onClick={() => skip(0.5)} disabled={!loadedUrl}>
          +0.5s
        </button>
        <button className="skip" onClick={() => skip(1)} disabled={!loadedUrl}>
          +1s
        </button>
        <button className="skip" onClick={() => skip(3)} disabled={!loadedUrl}>
          +3s
        </button>
        <span className="time">{fmtTime(displayTime)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={video.duration || 0}
          step={0.1}
          value={Math.min(displayTime, video.duration || 0)}
          disabled={!loadedUrl || video.duration <= 0}
          onChange={(e) => {
            scrubRef.current = true;
            setScrub(Number(e.target.value));
          }}
          onPointerUp={() => {
            if (scrub != null) seekTo(scrub);
            scrubRef.current = false;
            setScrub(null);
          }}
          onKeyUp={() => {
            if (scrub != null) seekTo(scrub);
            scrubRef.current = false;
            setScrub(null);
          }}
        />
        <span className="time">{fmtTime(video.duration)}</span>
      </footer>
    </div>
  );
}

/**
 * Google account (for YouTube Premium). Login runs in a separate window on the
 * shared player session, so both players pick it up.
 */
function LoginControl() {
  const [login, setLogin] = useState<LoginState>({ loggedIn: false });

  useEffect(() => {
    window.api.getLoginState().then(setLogin);
    return window.api.onLoginState(setLogin);
  }, []);

  const toggle = () => {
    if (login.loggedIn) window.api.googleLogout();
    else window.api.googleLogin();
  };

  return (
    <div className="logingroup">
      <div className="statusline">
        <span className={`dot ${login.loggedIn ? 'on' : 'off'}`} />
        <span>{login.loggedIn ? 'ログイン中' : '未ログイン'}</span>
      </div>
      <button
        onClick={toggle}
        title={
          login.loggedIn
            ? 'YouTube / Google のログイン情報を消去して両プレイヤーを再読み込み'
            : 'Googleアカウントでログイン（YouTube Premium 用）'
        }
      >
        {login.loggedIn ? 'ログアウト' : 'Googleログイン'}
      </button>
    </div>
  );
}

/**
 * Projector: pick a display and open a fullscreen output window there. It
 * shows the A/B crossfade; nothing else is needed to get a picture out.
 */
function ProjectorControl({ status }: { status: AppStatus }) {
  const proj = status.projector;
  const [picked, setPicked] = useState<number | null>(null);

  // Default to a non-primary display (the projector is rarely the main screen),
  // and fall back if the picked one disappears.
  const displays = proj.displays;
  const fallback =
    displays.find((d) => !d.primary)?.id ?? displays[0]?.id ?? null;
  const displayId =
    proj.open && proj.displayId != null
      ? proj.displayId
      : picked != null && displays.some((d) => d.id === picked)
        ? picked
        : fallback;

  const open = async (id: number | null) => {
    if (id == null) return;
    const res = await window.api.openProjector(id);
    if (!res.ok && res.error) alert(res.error);
  };

  const changeDisplay = (id: number) => {
    setPicked(id);
    // Already projecting: move the window to the new display right away.
    if (proj.open) open(id);
  };

  return (
    <div className="projgroup">
      <label className="quality">
        Projector
        <select
          value={displayId ?? ''}
          onChange={(e) => changeDisplay(Number(e.target.value))}
          disabled={displays.length === 0}
        >
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} · {d.width}×{d.height}
              {d.primary ? ' (main)' : ''}
            </option>
          ))}
        </select>
      </label>
      <button
        className={proj.open ? 'danger' : 'primary'}
        onClick={() => (proj.open ? window.api.closeProjector() : open(displayId))}
        disabled={!proj.open && displayId == null}
        title="選んだディスプレイに全画面で出力（投影ウィンドウで Esc でも閉じる）"
      >
        {proj.open ? 'Stop proj' : 'Project'}
      </button>
      <div className="statusline">
        <span className={`dot ${proj.open ? 'on' : 'off'}`} />
        <span>{proj.open ? 'live' : 'off'}</span>
      </div>
    </div>
  );
}

/** Capture size / rate of the projected decks — the knob for weak PCs. */
function OutputControl({ output }: { output: OutputSettings }) {
  const set = (patch: Partial<OutputSettings>) => window.api.setOutput(patch);
  return (
    <div className="projgroup">
      <label
        className="quality"
        title="投影の解像度。重いときは 720p に下げる"
      >
        Res
        <select
          value={output.height}
          onChange={(e) =>
            set({ height: Number(e.target.value) as OutputSettings['height'] })
          }
        >
          <option value={1080}>1080p</option>
          <option value={720}>720p</option>
        </select>
      </label>
      <label
        className="quality"
        title="投影のフレームレート。重いときは 30 に下げる"
      >
        FPS
        <select
          value={output.fps}
          onChange={(e) =>
            set({ fps: Number(e.target.value) as OutputSettings['fps'] })
          }
        >
          <option value={60}>60</option>
          <option value={30}>30</option>
        </select>
      </label>
    </div>
  );
}

const FADE_TIMES = [0.5, 1, 2, 4];

// Top rail: identity, projector, output settings, account; then the A/B fader.
function VjBar({ status }: { status: AppStatus }) {
  const [fadeSec, setFadeSec] = useState(1);
  const setAlpha = (a: number) => window.api.setAlpha(a);
  const fadeTo = (a: number) => window.api.fadeTo(a, fadeSec * 1000);

  // Keyboard: Z / X fade to A / B, C cuts to the other side. Ignored while
  // typing in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
        if ((t as HTMLInputElement).type !== 'range') return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z') window.api.fadeTo(0, fadeSec * 1000);
      else if (k === 'x') window.api.fadeTo(1, fadeSec * 1000);
      else if (k === 'c') window.api.setAlpha(status.alpha < 0.5 ? 1 : 0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fadeSec, status.alpha]);

  return (
    <div className="vjbar">
      <div className="modes">
        <span className="wordmark">Tube VJ</span>
        <span className="wordmark">A / B → projector</span>
        <div className="railgroup">
          <ProjectorControl status={status} />
          <OutputControl output={status.output} />
          <LoginControl />
        </div>
      </div>

      <div className="vjfade">
        <button onClick={() => setAlpha(0)} title="Cut to A">
          Cut A
        </button>
        <button onClick={() => fadeTo(0)} title={`Fade to A (Z)`}>
          Fade→A
        </button>
        <span className="ab">A</span>
        <input
          className="fader"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={status.alpha}
          onChange={(e) => setAlpha(Number(e.target.value))}
        />
        <span className="ab">B</span>
        <button onClick={() => fadeTo(1)} title={`Fade to B (X)`}>
          Fade→B
        </button>
        <button onClick={() => setAlpha(1)} title="Cut to B">
          Cut B
        </button>
        <label className="quality" title="Fade の長さ">
          Time
          <select
            value={fadeSec}
            onChange={(e) => setFadeSec(Number(e.target.value))}
          >
            {FADE_TIMES.map((s) => (
              <option key={s} value={s}>
                {s}s
              </option>
            ))}
          </select>
        </label>
        <div className="statusline">
          <span className="num">{Math.round(status.alpha * 100)}%</span>
          <span>Z / X fade · C cut</span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<AppStatus>(EMPTY_STATUS);

  useEffect(() => {
    window.api.getStatus().then(setStatus);
    return window.api.onStatus(setStatus);
  }, []);

  const projecting = status.projector.open;
  return (
    <div className="app">
      <VjBar status={status} />
      <div className="players">
        <Player
          channel="left"
          status={status.left}
          proj={status.projector.stats.left}
          projecting={projecting}
        />
        <div className="divider" />
        <Player
          channel="right"
          status={status.right}
          proj={status.projector.stats.right}
          projecting={projecting}
        />
      </div>
    </div>
  );
}
