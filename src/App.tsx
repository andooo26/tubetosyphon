import React, { useEffect, useRef, useState } from 'react';
import type { AppStatus, ChannelId, ChannelStatus } from './preload';

/**
 * Normalise a pasted URL. We deliberately use the normal **watch page**, not the
 * /embed/ player: many videos have embedding disabled by the owner and the embed
 * player then fails with "Error 153 / 150". The watch page has no such
 * restriction. Any non-YouTube URL is loaded as-is.
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
  return url;
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
};

const EMPTY_STATUS: AppStatus = { left: EMPTY_CHANNEL, right: EMPTY_CHANNEL };

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
}

function Player({
  channel,
  status,
}: {
  channel: ChannelId;
  status: ChannelStatus;
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
        "(()=>{const v=document.querySelector('video');" +
          'return v?{time:v.currentTime,duration:(isFinite(v.duration)?v.duration:0),paused:v.paused}:null;})()',
      );
      if (s) setVideo(s);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const play = () => {
    if (!input.trim()) return;
    const url = toPlayableUrl(input);
    setLoadedUrl(url);
    if (webviewRef.current) {
      (webviewRef.current as unknown as { src: string }).src = url;
    }
  };

  const paste = () => {
    const text = window.api.readClipboard();
    if (text) setInput(text);
  };

  const toggleOutput = async () => {
    const res = status.running
      ? await window.api.stopOutput(channel)
      : await window.api.startOutput(channel);
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
        <input
          className="url"
          placeholder="Paste a YouTube (or any) URL…"
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
        <button
          className={status.running ? 'danger' : 'primary'}
          onClick={toggleOutput}
        >
          {status.running ? 'Stop Syphon' : 'Start Syphon'}
        </button>
        <button onClick={toggleHideControls}>
          {status.hideControls ? 'Controls: hidden' : 'Controls: shown'}
        </button>
        <div className="spacer" />
        <div className="statusline">
          <span className={`dot ${status.running ? 'on' : 'off'}`} />
          <b>{status.serverName}</b>
          <span>· {status.fps} fps</span>
          <span>· {status.hasClients ? 'connected' : 'no receiver'}</span>
        </div>
      </div>
      {status.error && <div className="statusline error">{status.error}</div>}

      <div className="stage">
        <webview
          ref={webviewRef as React.Ref<HTMLElement>}
          src={loadedUrl || undefined}
          partition={`persist:player-${channel}`}
          useragent={DESKTOP_UA}
          className="webview"
          {...({ allowpopups: 'true' } as Record<string, string>)}
        />
        {!loadedUrl && (
          <div className="placeholder">
            Paste a URL and press Play, then “Start Syphon”.
            <br />
            Outputs 1920×1080 as <b>{status.serverName}</b>.
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

export default function App() {
  const [status, setStatus] = useState<AppStatus>(EMPTY_STATUS);

  useEffect(() => {
    window.api.getStatus().then(setStatus);
    const off = window.api.onStatus(setStatus);
    return off;
  }, []);

  return (
    <div className="app">
      <Player channel="left" status={status.left} />
      <div className="divider" />
      <Player channel="right" status={status.right} />
    </div>
  );
}
