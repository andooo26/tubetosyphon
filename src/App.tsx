import React, { useEffect, useRef, useState } from 'react';
import type {
  AppStatus,
  ChannelId,
  ChannelStatus,
  LoginState,
  Mode,
  Quality,
} from './preload';
import { GenCanvas } from './GenView';
import { PLAYER_PARTITION } from './constants';
import {
  DEFAULT_GEN_PARAMS,
  GENRES,
  MAX_BPM,
  MIN_BPM,
  type Genre,
} from './gen/params';

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

const EMPTY_CHANNEL: ChannelStatus = {
  running: false,
  capturing: false,
  hasClients: false,
  fps: 0,
  serverName: '',
  error: null,
  testFrame: false,
  hideControls: true,
  quality: 'highest',
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
  left: EMPTY_CHANNEL,
  right: EMPTY_CHANNEL,
  mode: 'dual',
  vjAlpha: 0,
  vj: {
    running: false,
    hasClients: false,
    fps: 0,
    serverName: 'TubeToSyphon',
    error: null,
  },
  gen: {
    running: false,
    hasClients: false,
    fps: 0,
    serverName: 'TubeToSyphon-GEN',
    error: null,
  },
  genParams: DEFAULT_GEN_PARAMS,
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
  vjMode,
}: {
  channel: ChannelId;
  status: ChannelStatus;
  vjMode: boolean;
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

  // Register this webview's contentsId with main so it can capture + inject CSS.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onReady = () => {
      const id = (
        wv as unknown as { getWebContentsId?: () => number }
      ).getWebContentsId?.();
      if (typeof id === 'number') window.api.registerGuest(channel, id);
    };
    wv.addEventListener('dom-ready', onReady);
    return () => wv.removeEventListener('dom-ready', onReady);
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
      wv.loadURL(url).catch(() => {});
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

  const toggleOutput = async () => {
    const res = status.running
      ? await window.api.stopOutput(channel)
      : await window.api.startOutput(channel);
    if (!res.ok && res.error) alert(res.error);
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
        {!vjMode && (
          <button
            className={status.running ? 'danger' : 'primary'}
            onClick={toggleOutput}
          >
            {status.running ? 'Stop output' : 'Start output'}
          </button>
        )}
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
          {vjMode ? (
            <b className="chanid">{channel === 'left' ? 'A' : 'B'}</b>
          ) : (
            <>
              <span className={`dot ${status.running ? 'on' : 'off'}`} />
              <b>{status.serverName}</b>
            </>
          )}
          {video.vh > 0 && (
            <span title="current resolution / this video's max resolution">
              · {video.vh}p / {video.maxH > 0 ? `${video.maxH}p` : '—'}
            </span>
          )}
          {!vjMode && (
            <>
              <span>· {status.fps} fps</span>
              <span>· {status.hasClients ? 'connected' : 'no receiver'}</span>
            </>
          )}
        </div>
      </div>
      {status.error && <div className="statusline error">{status.error}</div>}

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
            <span>1920×1080 → {status.serverName}</span>
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

// VJ crossfade + mode toggle bar. In VJ mode the two players feed one Syphon
// output ("TubeToSyphon") blended by the A/B fader; Cut A/B jump to either end.
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

function VjBar({
  status,
  view,
  setView,
}: {
  status: AppStatus;
  view: View;
  setView: (v: View) => void;
}) {
  const vjMode = status.mode === 'vj';
  const vj = status.vj;
  const gen = status.gen;

  const toggleGen = async () => {
    const res = await window.api.setGenOutput(!gen.running);
    if (!res.ok && res.error) alert(res.error);
  };

  const setMode = async (mode: Mode) => {
    const res = await window.api.setMode(mode);
    if (!res.ok && res.error) alert(res.error);
  };
  const setAlpha = (a: number) => window.api.setVjAlpha(a);
  const fadeTo = (a: number) => window.api.fadeVjTo(a, 1000); // ~1s crossfade

  return (
    <div className="vjbar">
      <div className="modes">
        <span className="wordmark">Tube to Syphon</span>
        <div className="segmented">
          <button
            className={status.mode === 'dual' ? 'primary' : ''}
            onClick={() => setMode('dual')}
            title="2つのプレイヤーを2系統のSyphonへ"
          >
            Dual
          </button>
          <button
            className={vjMode ? 'primary' : ''}
            onClick={() => setMode('vj')}
            title="2つのプレイヤーをクロスフェードして1系統へ"
          >
            VJ
          </button>
        </div>
        <span className="wordmark">
          {vjMode ? 'players → 1 · crossfade' : 'players → 2'}
        </span>

        {/* The generative output is its own Syphon server, independent of the
            player routing — Dual + 汎用 publishes three sources at once. So it
            gets its own group, and stays reachable from either view. */}
        <div className="railgroup">
          <button
            className={view === 'gen' ? 'primary' : ''}
            onClick={() => setView(view === 'gen' ? 'players' : 'gen')}
            title="汎用グラフィックスの操作パネルを開閉（出力の入切とは別）"
          >
            汎用
          </button>
          <button
            className={gen.running ? 'danger' : ''}
            onClick={toggleGen}
            title="汎用グラフィックスを独立したSyphonソースとして出力"
          >
            {gen.running ? 'Stop gen' : 'Start gen'}
          </button>
          <div className="statusline">
            <span className={`dot ${gen.running ? 'on' : 'off'}`} />
            <b>{gen.serverName}</b>
            {gen.running && <span>· {gen.fps} fps</span>}
          </div>
        </div>
        <LoginControl />
      </div>

      {vjMode && (
        <div className="vjfade">
          <button onClick={() => fadeTo(0)} title="Fade to A over ~1s">
            Fade→A
          </button>
          <span className="ab">A</span>
          <input
            className="fader"
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={status.vjAlpha}
            onChange={(e) => setAlpha(Number(e.target.value))}
          />
          <span className="ab">B</span>
          <button onClick={() => fadeTo(1)} title="Fade to B over ~1s">
            Fade→B
          </button>
          <div className="statusline">
            <span className={`dot ${vj.running ? 'on' : 'off'}`} />
            <b>{vj.serverName}</b>
            <span>· {vj.fps} fps</span>
            <span>· {vj.hasClients ? 'connected' : 'no receiver'}</span>
          </div>
        </div>
      )}
      {vjMode && vj.error && (
        <div className="statusline error">{vj.error}</div>
      )}
    </div>
  );
}

/**
 * 汎用 (generic) mode panel: the musical clock + look controls, and a live
 * preview of exactly the frame the offscreen window is publishing to Syphon.
 */
function GenPanel({ status }: { status: AppStatus }) {
  const p = status.genParams;
  const gen = status.gen;
  // Tap-tempo timestamps (most recent last). Kept in a ref — taps don't need to
  // re-render anything by themselves.
  const taps = useRef<number[]>([]);

  const patch = (next: Partial<typeof p>) => window.api.setGenParams(next);

  const tap = () => {
    const now = Date.now();
    // A gap longer than 2s starts a new measurement.
    if (taps.current.length && now - taps.current[taps.current.length - 1] > 2000) {
      taps.current = [];
    }
    taps.current.push(now);
    if (taps.current.length > 5) taps.current.shift();
    if (taps.current.length >= 2) {
      const first = taps.current[0];
      const spans = taps.current.length - 1;
      const bpm = 60000 / ((now - first) / spans);
      // The last tap is a beat, so anchor the grid to it as well.
      patch({ bpm: Math.round(bpm * 10) / 10, beatEpoch: now });
    } else {
      patch({ beatEpoch: now });
    }
  };

  const changeGenre = (genre: Genre) => {
    // Adopt the genre's typical tempo so the preset lands in a sensible range.
    const preset = GENRES.find((g) => g.value === genre);
    patch({ genre, bpm: preset?.bpm ?? p.bpm });
  };

  return (
    <div className="genpanel">
      <div className="gencontrols">
        <div className="genhead">Clock</div>
        <div className="genrow">
          <label className="quality">
            Genre
            <select
              value={p.genre}
              onChange={(e) => changeGenre(e.target.value as Genre)}
            >
              {GENRES.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          <label className="quality">
            BPM
            <input
              className="bpm"
              type="number"
              min={MIN_BPM}
              max={MAX_BPM}
              step={0.1}
              value={p.bpm}
              onChange={(e) => patch({ bpm: Number(e.target.value) })}
            />
          </label>
          <button onClick={tap} title="Tap 4 times on the beat">
            Tap
          </button>
          <button
            onClick={() => patch({ beatEpoch: Date.now() })}
            title="Re-align the beat grid to right now"
          >
            Sync
          </button>
        </div>

        <div className="genhead">Look</div>
        <div className="genrow">
          <button
            onClick={() => patch({ seed: Math.floor(Math.random() * 100000) })}
            title="構図・配色の乱数を引き直す（8拍ごとの自動変化とは別）"
          >
            Shuffle
          </button>
          <span className="genhint num">seed {p.seed}</span>
        </div>
        <div className="genrow">
          <label className="quality slider">
            Intensity
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={p.intensity}
              onChange={(e) => patch({ intensity: Number(e.target.value) })}
            />
          </label>
          {/* Rotates the preset's spot inks within a safe range rather than
              sweeping the whole hue wheel, so a palette bends but never breaks. */}
          <label className="quality slider">
            Tint
            <input
              type="range"
              min={0}
              max={359}
              step={1}
              value={p.hue}
              onChange={(e) => patch({ hue: Number(e.target.value) })}
            />
          </label>
        </div>

        <div className="statusline">
          <span className={`dot ${gen.running ? 'on' : 'off'}`} />
          <b>{gen.serverName}</b>
          <span>· {gen.fps} fps</span>
          <span>· {gen.hasClients ? 'connected' : 'no receiver'}</span>
          <span>· 1920×1080</span>
        </div>
        {gen.error && <div className="statusline error">{gen.error}</div>}
      </div>

      <div className="genpreview">
        {/* 720p backing store: the preview is displayed large, and at 640×360 the
            type and hairlines in the sketch visibly softened when scaled up. */}
        <GenCanvas params={p} width={1280} height={720} className="genthumb" />
        <div className="genhint">Live preview · identical to the Syphon output</div>
      </div>
    </div>
  );
}

/** Which workspace is on screen. Purely a view — it starts and stops nothing. */
type View = 'players' | 'gen';

export default function App() {
  const [status, setStatus] = useState<AppStatus>(EMPTY_STATUS);
  const [view, setView] = useState<View>('players');

  useEffect(() => {
    window.api.getStatus().then(setStatus);
    const off = window.api.onStatus(setStatus);
    return off;
  }, []);

  const vjMode = status.mode === 'vj';
  const genView = view === 'gen';

  return (
    <div className="app">
      <VjBar status={status} view={view} setView={setView} />
      {genView && <GenPanel status={status} />}
      {/* Kept mounted but hidden while the generative panel is up: unmounting
          would destroy the <webview>s and lose whatever the user had loaded.
          The players keep publishing to Syphon either way. */}
      <div className="players" style={genView ? { display: 'none' } : undefined}>
        <Player channel="left" status={status.left} vjMode={vjMode} />
        <div className="divider" />
        <Player channel="right" status={status.right} vjMode={vjMode} />
      </div>
    </div>
  );
}
