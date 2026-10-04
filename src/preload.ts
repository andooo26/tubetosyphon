import { contextBridge, ipcRenderer, clipboard } from 'electron';
import type { GenParams } from './gen/params';
import type { LoginState } from './login';

export type { LoginState };

export type ChannelId = 'left' | 'right';

// YouTube playback-quality target. 'auto' lets YouTube's ABR decide; 'highest'
// forces the best available; the rest are YouTube's own quality-level ids and
// mean "best available at or below this level".
export type Quality =
  | 'auto'
  | 'highest'
  | 'hd2160'
  | 'hd1440'
  | 'hd1080'
  | 'hd720'
  | 'large'
  | 'medium';

export interface ChannelStatus {
  running: boolean;
  capturing: boolean;
  hasClients: boolean;
  fps: number;
  serverName: string;
  error: string | null;
  testFrame: boolean;
  hideControls: boolean;
  quality: Quality;
}

/**
 * How the two players are routed: two Syphon servers, or one crossfaded server.
 * The 汎用 (generative) output is NOT a mode — it is an independent third
 * server that can run alongside either routing.
 */
export type Mode = 'dual' | 'vj';

export interface VjStatus {
  running: boolean;
  hasClients: boolean;
  fps: number;
  serverName: string;
  error: string | null;
}

/** Same shape as VjStatus — the single generative Syphon output. */
export type GenStatus = VjStatus;

export interface AppStatus {
  left: ChannelStatus;
  right: ChannelStatus;
  mode: Mode;
  vjAlpha: number; // 0 = A (left), 1 = B (right)
  vj: VjStatus;
  gen: GenStatus;
  genParams: GenParams;
}

const api = {
  registerGuest: (
    channel: ChannelId,
    contentsId: number,
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('app:register-guest', channel, contentsId),
  startOutput: (channel: ChannelId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:start-output', channel),
  stopOutput: (channel: ChannelId): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:stop-output', channel),
  testFrame: (
    channel: ChannelId,
    on: boolean,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:test-frame', channel, on),
  setHideControls: (
    channel: ChannelId,
    on: boolean,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:set-hide-controls', channel, on),
  setQuality: (
    channel: ChannelId,
    quality: Quality,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:set-quality', channel, quality),
  setMode: (mode: Mode): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:set-mode', mode),
  setVjAlpha: (alpha: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:set-vj-alpha', alpha),
  fadeVjTo: (
    target: number,
    durationMs: number,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:vj-fade', target, durationMs),
  setGenOutput: (on: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:set-gen-output', on),
  setGenParams: (
    patch: Partial<GenParams>,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:set-gen-params', patch),
  /** Params pushed to the offscreen generative window (and back to the UI). */
  onGenParams: (cb: (p: GenParams) => void): (() => void) => {
    const listener = (_e: unknown, p: GenParams) => cb(p);
    ipcRenderer.on('app:gen-params', listener);
    return () => {
      ipcRenderer.removeListener('app:gen-params', listener);
    };
  },
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('app:get-status'),
  onStatus: (cb: (s: AppStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: AppStatus) => cb(s);
    ipcRenderer.on('app:status', listener);
    return () => {
      ipcRenderer.removeListener('app:status', listener);
    };
  },
  readClipboard: (): string => clipboard.readText(),
  /** Open the dedicated Google login window (shared player session). */
  googleLogin: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('app:google-login'),
  googleLogout: (): Promise<LoginState> =>
    ipcRenderer.invoke('app:google-logout'),
  getLoginState: (): Promise<LoginState> =>
    ipcRenderer.invoke('app:get-login-state'),
  onLoginState: (cb: (s: LoginState) => void): (() => void) => {
    const listener = (_e: unknown, s: LoginState) => cb(s);
    ipcRenderer.on('app:login-state', listener);
    return () => {
      ipcRenderer.removeListener('app:login-state', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
