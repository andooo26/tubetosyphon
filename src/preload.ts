import { contextBridge, ipcRenderer, clipboard } from 'electron';

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

export type Mode = 'dual' | 'vj';

export interface VjStatus {
  running: boolean;
  hasClients: boolean;
  fps: number;
  serverName: string;
  error: string | null;
}

export interface AppStatus {
  left: ChannelStatus;
  right: ChannelStatus;
  mode: Mode;
  vjAlpha: number; // 0 = A (left), 1 = B (right)
  vj: VjStatus;
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
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('app:get-status'),
  onStatus: (cb: (s: AppStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: AppStatus) => cb(s);
    ipcRenderer.on('app:status', listener);
    return () => {
      ipcRenderer.removeListener('app:status', listener);
    };
  },
  readClipboard: (): string => clipboard.readText(),
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
