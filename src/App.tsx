import React, { useEffect, useRef, useState } from 'react';
import type { AppStatus } from './preload';

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

const EMPTY_STATUS: AppStatus = {
  running: false,
  capturing: false,
  hasClients: false,
  fps: 0,
  serverName: 'URLtoSyphon',
  error: null,
  testFrame: false,
};

export default function App() {
  const [input, setInput] = useState('');
  const [loadedUrl, setLoadedUrl] = useState('');
  const [status, setStatus] = useState<AppStatus>(EMPTY_STATUS);
  const webviewRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    window.api.getStatus().then(setStatus);
    const off = window.api.onStatus(setStatus);
    return off;
  }, []);

  const play = () => {
    if (!input.trim()) return;
    const url = toPlayableUrl(input);
    setLoadedUrl(url);
    // Setting src directly on the element also works if the ref is ready.
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
      ? await window.api.stopOutput()
      : await window.api.startOutput();
    if (!res.ok && res.error) alert(res.error);
    setStatus(await window.api.getStatus());
  };

  const toggleTest = async () => {
    const res = await window.api.testFrame(!status.testFrame);
    if (!res.ok && res.error) alert(res.error);
    setStatus(await window.api.getStatus());
  };

  return (
    <div className="app">
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
        <div className="spacer" />
        <button
          className={status.running ? 'danger' : 'primary'}
          onClick={toggleOutput}
        >
          {status.running ? 'Stop Syphon' : 'Start Syphon'}
        </button>
        <button onClick={toggleTest}>
          {status.testFrame ? 'Test frame: ON' : 'Test frame'}
        </button>
      </header>

      <div className="statusline">
        <span className={`dot ${status.running ? 'on' : 'off'}`} />
        <b>{status.serverName}</b>
        <span>{status.running ? 'publishing' : 'stopped'}</span>
        <span>· {status.fps} fps</span>
        <span>· receivers: {status.hasClients ? 'connected' : 'none'}</span>
        {status.testFrame && <span className="warn">· TEST RED FRAME</span>}
        {status.error && <span className="error">· {status.error}</span>}
      </div>

      <div className="stage">
        <webview
          ref={webviewRef as React.Ref<HTMLElement>}
          src={loadedUrl || undefined}
          partition="persist:player"
          useragent={DESKTOP_UA}
          className="webview"
          // allowpopups is a string DOM attribute on <webview>; React's typed
          // union treats it as boolean, so pass it through untyped.
          {...({ allowpopups: 'true' } as Record<string, string>)}
        />
        {!loadedUrl && (
          <div className="placeholder">
            Paste a URL above and press Play. Then “Start Syphon” to output
            1280×720 to a receiver as <b>URLtoSyphon</b>.
          </div>
        )}
      </div>
    </div>
  );
}
